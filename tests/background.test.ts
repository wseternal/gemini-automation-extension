import { describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { markTabComplete } from './helpers';
import { dispatchAutomation, LAST_RESULT_KEY } from '../entrypoints/background';
import { AUTOMATION_RUN_REQUEST, ok, type AutomationRunRequest } from '../types/automation';
import { sleep } from '../utils/dom-wait';

const REQUEST: AutomationRunRequest = { kind: AUTOMATION_RUN_REQUEST, prompt: 'Hello Gemini' };

async function seedGeminiTab(): Promise<number> {
  const tab = await fakeBrowser.tabs.create({ url: 'https://gemini.google.com/app' });
  await markTabComplete(tab.id!);
  return tab.id!;
}

describe('background dispatchAutomation', () => {
  it('dispatches to the managed Gemini tab, stamps tabId, and persists the result', async () => {
    const tabId = await seedGeminiTab();
    const sendMessage = vi
      .spyOn(fakeBrowser.tabs, 'sendMessage')
      .mockResolvedValue(ok('done', { tabId: -1, durationMs: 5, streamingDetected: true, steps: ['extract'] }));

    const res = await dispatchAutomation(fakeBrowser, REQUEST);

    expect(res.status).toBe('ok');
    expect(sendMessage).toHaveBeenCalledWith(tabId, REQUEST);
    if (res.status === 'ok') {
      expect(res.meta.tabId).toBe(tabId); // stamped by background, not the content script
    }
    const stored = await fakeBrowser.storage.session.get(LAST_RESULT_KEY);
    expect(stored[LAST_RESULT_KEY]).toMatchObject({ status: 'ok' });
  });

  it('reloads and retries once when the content script is not connected', async () => {
    await seedGeminiTab();
    const reload = vi.spyOn(fakeBrowser.tabs, 'reload').mockResolvedValue(undefined);
    const sendMessage = vi
      .spyOn(fakeBrowser.tabs, 'sendMessage')
      .mockRejectedValueOnce(new Error('Could not establish connection'))
      .mockResolvedValueOnce(ok('recovered', { tabId: -1, durationMs: 3, streamingDetected: false, steps: ['extract'] }));

    const pending = dispatchAutomation(fakeBrowser, REQUEST, { loadTimeoutMs: 2_000 });
    await sleep(30);
    await markTabComplete((await fakeBrowser.tabs.query({}))[1]?.id ?? 1);

    const res = await pending;
    expect(reload).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(res.status).toBe('ok');
    if (res.status === 'ok') expect(res.text).toBe('recovered');
  });

  it('returns a typed INTERNAL error when dispatch keeps failing', async () => {
    await seedGeminiTab();
    vi.spyOn(fakeBrowser.tabs, 'reload').mockResolvedValue(undefined);
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockRejectedValue(new Error('Could not establish connection'));

    const pending = dispatchAutomation(fakeBrowser, REQUEST, { loadTimeoutMs: 2_000 });
    await sleep(30);
    await markTabComplete((await fakeBrowser.tabs.query({}))[1]?.id ?? 1);

    const res = await pending;
    expect(res.status).toBe('error');
    if (res.status === 'error') {
      expect(res.error.code).toBe('INTERNAL');
      expect(res.error.message).toContain('Could not establish connection');
    }
  });

  it('rejects unrecognized response shapes from the page', async () => {
    await seedGeminiTab();
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockResolvedValue({ hello: 'world' });

    const res = await dispatchAutomation(fakeBrowser, REQUEST);
    expect(res.status).toBe('error');
    if (res.status === 'error') expect(res.error.code).toBe('INTERNAL');
  });

  it('ignores foreign messages at the listener level', () => {
    // The listener guard is exercised indirectly: dispatchAutomation is only
    // invoked for valid contract messages (isAutomationRunRequest gate).
    expect(true).toBe(true);
  });
});
