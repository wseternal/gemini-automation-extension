/**
 * utils/tab-manager.ts — background-side orchestration of the Gemini tab.
 *
 * Finds an already-open `https://gemini.google.com/app` tab (the user's
 * existing authenticated session) or creates one only as a fallback.
 * URL matching is done code-side (not via `tabs.query({url})`) so behavior
 * is deterministic and unit-testable. The `Browser` object is injected so
 * tests can run against a fake browser.
 */
import type { Browser, Tabs } from 'wxt/browser';
import { AutomationErrorException } from '../types/automation';
import { sleep } from './dom-wait';

export const GEMINI_APP_URL = 'https://gemini.google.com/app';

export interface ManagedTab {
  readonly tabId: number;
  readonly url: string;
  readonly created: boolean;
}

export interface EnsureTabOptions {
  /** Max wait for a newly created tab to finish loading. Default 30s. */
  readonly loadTimeoutMs?: number;
}

/** True for Gemini app URLs: https://gemini.google.com/app[/...][?...][#...] */
export function isGeminiAppUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname === 'gemini.google.com' &&
      (parsed.pathname === '/app' || parsed.pathname.startsWith('/app/'))
    );
  } catch {
    return false;
  }
}

/**
 * Selection policy, pure and unit-testable: prefer an active Gemini tab,
 * otherwise the first one found; null when none exists.
 */
export function pickPreferredGeminiTab(tabs: readonly Tabs.Tab[]): Tabs.Tab | null {
  const geminiTabs = tabs.filter((tab) => isGeminiAppUrl(tab.url));
  return geminiTabs.find((tab) => tab.active) ?? geminiTabs[0] ?? null;
}

/** Locate an existing Gemini app tab, preferring an active one. */
export async function findGeminiTab(browser: Browser): Promise<Tabs.Tab | null> {
  return pickPreferredGeminiTab(await browser.tabs.query({}));
}

/** Resolve once the tab reports `status === 'complete'`; typed timeout otherwise. */
export async function waitForTabComplete(browser: Browser, tabId: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const tab = await browser.tabs.get(tabId);
    if (tab.status === 'complete') return;
    if (Date.now() >= deadline) {
      throw new AutomationErrorException('TAB_LOAD_TIMEOUT', `Gemini tab ${tabId} did not finish loading within ${timeoutMs}ms`);
    }
    await sleep(250);
  }
}

/**
 * Resolve the tab all automation runs against. Reuse is the rule — creating
 * a tab is the fallback, so the user's authenticated session is never
 * re-challenged.
 */
export async function ensureGeminiTab(browser: Browser, options: EnsureTabOptions = {}): Promise<ManagedTab> {
  const existing = await findGeminiTab(browser);
  if (existing && typeof existing.id === 'number') {
    return { tabId: existing.id, url: existing.url ?? GEMINI_APP_URL, created: false };
  }

  const created = await browser.tabs.create({ url: GEMINI_APP_URL, active: true });
  if (typeof created.id !== 'number') {
    throw new AutomationErrorException('NO_GEMINI_TAB', 'Could not create a Gemini tab');
  }
  await waitForTabComplete(browser, created.id, options.loadTimeoutMs ?? 30_000);
  return { tabId: created.id, url: GEMINI_APP_URL, created: true };
}
