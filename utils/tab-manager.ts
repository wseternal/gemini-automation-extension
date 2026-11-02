/**
 * utils/tab-manager.ts — background-side orchestration of LLM provider tabs.
 *
 * Finds an already-open provider tab (the user's existing authenticated
 * session) or creates one only as a fallback. URL matching is done
 * provider-side via `provider.isProviderUrl()` so behavior is deterministic
 * and unit-testable.
 */
import type { Tabs } from 'wxt/browser';
import { AutomationErrorException } from '../types/automation';
import type { LlmProvider } from '../types/provider';
import { sleep } from './dom-wait';

/**
 * Structural slice of the extension browser API this module needs.
 * Satisfied by `wxt/browser`'s `browser` in production and by the
 * `wxt/testing` fake browser in tests — dependency injection by shape.
 */
export interface TabsLike {
  query(queryInfo: Tabs.QueryQueryInfoType): Promise<Tabs.Tab[]>;
  get(tabId: number): Promise<Tabs.Tab>;
  create(createProperties: Tabs.CreateCreatePropertiesType): Promise<Tabs.Tab>;
  update(tabId: number, updateProperties: Tabs.UpdateUpdatePropertiesType): Promise<Tabs.Tab | undefined>;
  reload(tabId: number): Promise<void>;
  sendMessage(tabId: number, message: unknown): Promise<unknown>;
  remove(tabIds: number | readonly number[]): Promise<void>;
}

export interface StorageSessionLike {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface BrowserLike {
  readonly tabs: TabsLike;
  readonly storage: { readonly session: StorageSessionLike };
}

export interface ManagedTab {
  readonly tabId: number;
  readonly url: string;
  readonly created: boolean;
  /** True when the tab was opened by automation and should be closed after. */
  readonly shouldCloseAfter: boolean;
}

export interface EnsureTabOptions {
  /** Max wait for a newly created tab to finish loading. Default 30s. */
  readonly loadTimeoutMs?: number;
}

/**
 * Selection policy, pure and unit-testable: prefer an active provider tab,
 * otherwise the first one found; null when none exists.
 */
export function pickPreferredTab(tabs: readonly Tabs.Tab[], provider: LlmProvider): Tabs.Tab | null {
  const matchingTabs = tabs.filter((tab) => provider.isProviderUrl(tab.url));
  return matchingTabs.find((tab) => tab.active) ?? matchingTabs[0] ?? null;
}

/** Locate an existing provider tab, preferring an active one. */
export async function findTab(browser: BrowserLike, provider: LlmProvider): Promise<Tabs.Tab | null> {
  return pickPreferredTab(await browser.tabs.query({}), provider);
}

/** Resolve once the tab reports `status === 'complete'`; typed timeout otherwise. */
export async function waitForTabComplete(browser: BrowserLike, tabId: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const tab = await browser.tabs.get(tabId);
    if (tab.status === 'complete') return;
    if (Date.now() >= deadline) {
      throw new AutomationErrorException('TAB_LOAD_TIMEOUT', `Tab ${tabId} did not finish loading within ${timeoutMs}ms`);
    }
    await sleep(250);
  }
}

/**
 * Resolve the tab all automation runs against. Reuse is the rule — creating
 * a tab is the fallback, so the user's authenticated session is never
 * re-challenged.
 */
export async function ensureTab(
  browser: BrowserLike,
  provider: LlmProvider,
  options: EnsureTabOptions = {},
): Promise<ManagedTab> {
  const existing = await findTab(browser, provider);
  if (existing && typeof existing.id === 'number') {
    return { tabId: existing.id, url: existing.url ?? provider.urlPatterns[0], created: false, shouldCloseAfter: false };
  }

  const targetUrl = provider.urlPatterns[0].replace('/*', '');
  const created = await browser.tabs.create({ url: targetUrl, active: false });
  if (typeof created.id !== 'number') {
    throw new AutomationErrorException('NO_TAB', `Could not create a ${provider.name} tab`);
  }
  await waitForTabComplete(browser, created.id, options.loadTimeoutMs ?? 30_000);
  return { tabId: created.id, url: targetUrl, created: true, shouldCloseAfter: true };
}

/**
 * Resolve the tab for an automation run. When `targetTabId` is given the
 * request targets a specific user-chosen conversation — the tab is verified
 * but never created/closed. Otherwise falls back to
 * {@link ensureTab} (new tabs open in the background and are flagged
 * for cleanup after the run).
 */
export async function resolveTargetTab(
  browser: BrowserLike,
  provider: LlmProvider,
  targetTabId: number | undefined,
  options: EnsureTabOptions = {},
): Promise<ManagedTab> {
  if (targetTabId !== undefined) {
    let tab: Tabs.Tab;
    try {
      tab = await browser.tabs.get(targetTabId);
    } catch {
      throw new AutomationErrorException('NO_TAB', `Target tab ${targetTabId} not found`);
    }
    if (!provider.isProviderUrl(tab.url)) {
      throw new AutomationErrorException('NO_TAB', `Tab ${targetTabId} is not a ${provider.name} conversation`);
    }
    return { tabId: targetTabId, url: tab.url ?? provider.urlPatterns[0], created: false, shouldCloseAfter: false };
  }

  // No target — reuse existing tab or create a new background tab.
  return ensureTab(browser, provider, options);
}

/** List all open tabs matching a provider with lightweight metadata. */
export async function listTabs(browser: BrowserLike, provider: LlmProvider): Promise<Tabs.Tab[]> {
  const allTabs = await browser.tabs.query({});
  return allTabs.filter((tab) => provider.isProviderUrl(tab.url));
}

/** List all open tabs matching any registered provider. */
export async function listAllProviderTabs(
  browser: BrowserLike,
  providers: readonly LlmProvider[],
): Promise<Tabs.Tab[]> {
  const allTabs = await browser.tabs.query({});
  return allTabs.filter((tab) => providers.some((p) => p.isProviderUrl(tab.url)));
}
