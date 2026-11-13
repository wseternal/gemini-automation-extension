/**
 * entrypoints/background.ts — tab orchestration and message dispatch.
 *
 * Receives typed run requests (popup or programmatic), resolves the provider
 * tab via the tab manager (reuse-first), dispatches to the content script,
 * stamps tab metadata, and hands the latest result off via storage.session
 * so a reopened popup can recover it.
 */
import { browser as wxtBrowser } from 'wxt/browser';
import type { Runtime } from 'wxt/browser';
import { defineBackground } from 'wxt/sandbox';
import {
  AutomationErrorException,
  err,
  isAutomationRunRequest,
  isAutomationRunResponse,
  isTabListRequest,
  TAB_LIST_RESPONSE,
  type AutomationRunRequest,
  type AutomationRunResponse,
  type ConversationInfo,
  type HistoryEntry,
  type TabListResponse,
} from '../types/automation';
import { getProvider, getDefaultProvider, ALL_PROVIDERS } from '../providers';
import type { LlmProviderId } from '../types/provider';
import { resolveTargetTab, listAllProviderTabs, waitForTabComplete, type BrowserLike } from '../utils/tab-manager';
import { generateHistoryId, saveHistoryEntry, listHistoryConversations } from '../utils/history-storage';

export const LAST_RESULT_KEY = 'llm-automation/last-result' as const;

export interface DispatchOptions {
  readonly loadTimeoutMs?: number;
}

function withTabId(response: AutomationRunResponse, tabId: number): AutomationRunResponse {
  if (response.status === 'ok') return { ...response, meta: { ...response.meta, tabId } };
  return response.meta ? { ...response, meta: { ...response.meta, tabId } } : response;
}

/**
 * Core dispatch: resolve tab → send request → validate → stamp → persist.
 * On a connection failure (content script not yet injected, e.g. the tab
 * predates the extension install) the tab is reloaded once and the dispatch
 * retried once — within the frozen permission set, a reload is what
 * re-registers the manifest content script.
 */
export async function dispatchAutomation(
  browserApi: BrowserLike,
  request: AutomationRunRequest,
  options: DispatchOptions = {},
): Promise<AutomationRunResponse> {
  // Resolve provider from request or use default.
  const providerId = request.providerId ?? 'gemini';
  const provider = getProvider(providerId);
  if (!provider) {
    return err('INVALID_PROVIDER', `Unknown provider: ${providerId}`);
  }

  let managed: Awaited<ReturnType<typeof resolveTargetTab>> | undefined;
  let tabId: number | undefined;
  let succeeded = false;
  let errorCode: string | undefined;
  try {
    managed = await resolveTargetTab(browserApi, provider, request.targetTabId, { loadTimeoutMs: options.loadTimeoutMs }, request.targetUrl);
    tabId = managed.tabId;

    let raw: unknown;
    try {
      raw = await browserApi.tabs.sendMessage(tabId, request);
    } catch (firstError) {
      // Content script not present → reload the tab once and retry once.
      await browserApi.tabs.reload(tabId).catch(() => undefined);
      await waitForTabComplete(browserApi, tabId, options.loadTimeoutMs ?? 30_000).catch(() => undefined);
      try {
        raw = await browserApi.tabs.sendMessage(tabId, request);
      } catch {
        throw firstError;
      }
    }

    if (!isAutomationRunResponse(raw)) {
      throw new AutomationErrorException('INTERNAL', 'content script returned an unrecognized response shape');
    }

    const stamped = withTabId(raw, tabId);
    await browserApi.storage.session.set({ [LAST_RESULT_KEY]: stamped });
    const conversationUrl = await getTabUrl(browserApi, tabId);
    await persistHistory(request, provider.id, stamped, conversationUrl);
    succeeded = stamped.status === 'ok';
    return stamped;
  } catch (e) {
    if (e instanceof AutomationErrorException) {
      const response = err(e.code, e.message, e.step);
      errorCode = e.code;
      const stamped = tabId === undefined ? response : withTabId(response, tabId);
      const conversationUrl = tabId !== undefined ? await getTabUrl(browserApi, tabId) : undefined;
      await persistHistory(request, provider.id, stamped, conversationUrl);
      return stamped;
    }
    const message = e instanceof Error ? e.message : String(e);
    const response = err('INTERNAL', `automation dispatch failed: ${message}`);
    errorCode = 'INTERNAL';
    const stamped = tabId === undefined ? response : withTabId(response, tabId);
    const conversationUrl = tabId !== undefined ? await getTabUrl(browserApi, tabId) : undefined;
    await persistHistory(request, provider.id, stamped, conversationUrl);
    return stamped;
  } finally {
    // Close background tabs that automation created.
    // On success: always close.
    // On hard failures (tab not found, load timeout, invalid provider):
    //   close — the tab state is not diagnostic.
    // On soft failures (extraction, submit, attach):
    //   keep open so the user can inspect what went wrong.
    if (managed?.shouldCloseAfter) {
      const hardFailures = new Set(['NO_TAB', 'TAB_LOAD_TIMEOUT', 'INVALID_PROVIDER']);
      const shouldClose = succeeded || (errorCode && hardFailures.has(errorCode));
      if (shouldClose) {
        await browserApi.tabs.remove(managed.tabId).catch(() => undefined);
      }
    }
  }
}

export default defineBackground(() => {
  // Set the toolbar tooltip to include the build version and time.
  wxtBrowser.action.setTitle({
    title: `LLM Automation Bridge ${__BUILD_VERSION__} ${__BUILD_TIME__}`,
  });

  wxtBrowser.runtime.onMessage.addListener(
    (message: unknown, _sender: Runtime.MessageSender): Promise<AutomationRunResponse | TabListResponse> | undefined => {
      if (isTabListRequest(message)) return handleTabList(wxtBrowser);
      if (!isAutomationRunRequest(message)) return undefined;
      return dispatchAutomation(wxtBrowser, message);
    },
  );
});

/** Return lightweight descriptors of all open LLM provider tabs and recent conversations. */
async function handleTabList(browserApi: BrowserLike): Promise<TabListResponse> {
  const tabs = await listAllProviderTabs(browserApi, ALL_PROVIDERS);
  const openTabs = tabs
    .filter((t): t is typeof t & { id: number } => typeof t.id === 'number')
    .map((t) => ({ tabId: t.id, title: t.title ?? t.url ?? '', url: t.url ?? '' }));

  // Build the merged conversations list: open tabs first, then history.
  const openUrls = new Set(openTabs.map((t) => t.url));
  const conversations: ConversationInfo[] = openTabs.map((t) => {
    const provider = ALL_PROVIDERS.find((p) => p.isProviderUrl(t.url));
    return {
      tabId: t.tabId,
      title: t.title,
      url: t.url,
      providerId: (provider?.id ?? 'gemini') as ConversationInfo['providerId'],
      isOpen: true,
    };
  });

  try {
    const historyConvos = await listHistoryConversations(20);
    for (const hc of historyConvos) {
      if (openUrls.has(hc.url)) continue;
      conversations.push({
        title: hc.prompt,
        url: hc.url,
        providerId: hc.providerId,
        isOpen: false,
      });
    }
  } catch {
    /* History read failure must not break the tab list response. */
  }

  return { kind: TAB_LIST_RESPONSE, tabs: openTabs, conversations };
}

/** Build a HistoryEntry from the request + response and persist it. */
async function persistHistory(
  request: AutomationRunRequest,
  providerId: LlmProviderId,
  response: AutomationRunResponse,
  conversationUrl?: string,
): Promise<void> {
  const entry: HistoryEntry = {
    id: generateHistoryId(),
    timestamp: Date.now(),
    providerId,
    prompt: request.prompt,
    status: response.status,
    responseText: response.status === 'ok' ? response.text : '',
    ...(response.status === 'ok' && response.markdown ? { responseMarkdown: response.markdown } : {}),
    ...(response.status === 'error'
      ? { errorCode: response.error.code, errorMessage: response.error.message }
      : {}),
    ...(request.file
      ? {
          attachment: {
            name: request.file.name,
            mimeType: request.file.mimeType,
            byteLength: request.file.byteLength,
          },
        }
      : {}),
    ...(conversationUrl ? { conversationUrl } : {}),
  };
  await saveHistoryEntry(entry).catch(() => {
    /* storage write failure must not break the automation response */
  });
}

/** Retrieve the current URL of a tab, returning undefined on failure. */
async function getTabUrl(browserApi: BrowserLike, tabId: number): Promise<string | undefined> {
  try {
    const tab = await browserApi.tabs.get(tabId);
    return tab.url;
  } catch {
    return undefined;
  }
}
