import { describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { markTabComplete, markTabLoading } from './helpers';
import { AutomationErrorException } from '../types/automation';
import { sleep } from '../utils/dom-wait';
import {
  ensureGeminiTab,
  findGeminiTab,
  GEMINI_APP_URL,
  isGeminiAppUrl,
  pickPreferredGeminiTab,
  waitForTabComplete,
} from '../utils/tab-manager';

describe('isGeminiAppUrl', () => {
  it.each([
    ['https://gemini.google.com/app', true],
    ['https://gemini.google.com/app/abc123', true],
    ['https://gemini.google.com/app?hl=en', true],
    ['https://gemini.google.com/', false],
    ['https://gemini.google.com/other', false],
    ['https://gemini.google.com.evil.tld/app', false],
    ['http://gemini.google.com/app', false],
    ['https://example.com/app', false],
    ['not a url', false],
    ['', false],
  ])('%s → %s', (url, expected) => {
    expect(isGeminiAppUrl(url)).toBe(expected);
  });
});

describe('tab-manager (fake browser)', () => {
  it('reuses an existing Gemini tab and creates nothing', async () => {
    const seeded = await fakeBrowser.tabs.create({ url: 'https://gemini.google.com/app' });
    const countBefore = (await fakeBrowser.tabs.query({})).length;

    const managed = await ensureGeminiTab(fakeBrowser);

    expect(managed.created).toBe(false);
    expect(managed.tabId).toBe(seeded.id);
    expect((await fakeBrowser.tabs.query({})).length).toBe(countBefore);
  });

  it('matches sub-paths of /app (e.g. an open conversation)', async () => {
    const seeded = await fakeBrowser.tabs.create({ url: 'https://gemini.google.com/app/abc123' });
    const found = await findGeminiTab(fakeBrowser);
    expect(found?.id).toBe(seeded.id);
  });

  it('ignores non-Gemini tabs', async () => {
    await fakeBrowser.tabs.create({ url: 'https://example.com/app' });
    expect(await findGeminiTab(fakeBrowser)).toBeNull();
  });

  it('prefers the active Gemini tab when several are open', () => {
    const tabs = [
      { id: 1, url: GEMINI_APP_URL, active: false },
      { id: 2, url: 'https://gemini.google.com/app/xyz', active: true },
      { id: 3, url: 'https://example.com', active: false },
    ] as never[];
    expect(pickPreferredGeminiTab(tabs)?.id).toBe(2);
    expect(pickPreferredGeminiTab([])).toBeNull();
  });

  it('creates a new Gemini tab only when none exists, and waits for load', async () => {
    const pending = ensureGeminiTab(fakeBrowser, { loadTimeoutMs: 2_000 });
    // Simulate the network: the new tab finishes loading shortly after.
    await sleep(30);
    for (const tab of await fakeBrowser.tabs.query({})) {
      if (tab.id != null && isGeminiAppUrl(tab.url)) {
        await markTabComplete(tab.id);
      }
    }
    const managed = await pending;

    expect(managed.created).toBe(true);
    expect(managed.url).toBe(GEMINI_APP_URL);
    const tab = await fakeBrowser.tabs.get(managed.tabId);
    expect(tab.url).toBe(GEMINI_APP_URL);
  });

  it('raises TAB_LOAD_TIMEOUT when a created tab never finishes loading', async () => {
    const tab = await fakeBrowser.tabs.create({ url: GEMINI_APP_URL });
    await markTabLoading(tab.id!);
    await expect(waitForTabComplete(fakeBrowser, tab.id!, 60)).rejects.toMatchObject({
      code: 'TAB_LOAD_TIMEOUT',
    } satisfies Partial<AutomationErrorException>);
  });
});
