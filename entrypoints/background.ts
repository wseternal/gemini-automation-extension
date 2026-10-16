/**
 * entrypoints/background.ts — tab orchestration and message dispatch.
 *
 * Receives typed run requests (popup or programmatic), resolves the Gemini
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
  type AutomationRunRequest,
  type AutomationRunResponse,
} from '../types/automation';
import { ensureGeminiTab, waitForTabComplete, type BrowserLike } from '../utils/tab-manager';

export const LAST_RESULT_KEY = 'gemini-automation/last-result' as const;

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
  let tabId: number | undefined;
  try {
    const managed = await ensureGeminiTab(browserApi, { loadTimeoutMs: options.loadTimeoutMs });
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
    return stamped;
  } catch (e) {
    if (e instanceof AutomationErrorException) {
      const response = err(e.code, e.message, e.step);
      return tabId === undefined ? response : withTabId(response, tabId);
    }
    const message = e instanceof Error ? e.message : String(e);
    const response = err('INTERNAL', `automation dispatch failed: ${message}`);
    return tabId === undefined ? response : withTabId(response, tabId);
  }
}

export default defineBackground(() => {
  wxtBrowser.runtime.onMessage.addListener(
    (message: unknown, _sender: Runtime.MessageSender): Promise<AutomationRunResponse> | undefined => {
      if (!isAutomationRunRequest(message)) return undefined;
      return dispatchAutomation(wxtBrowser, message);
    },
  );
});
