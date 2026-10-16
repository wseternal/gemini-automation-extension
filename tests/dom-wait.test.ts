import { describe, expect, it } from 'vitest';
import { WaitTimeoutError, queryFirst, sleep, waitForCondition, waitForElement } from '../utils/dom-wait';
import { SELECTORS } from '../utils/selectors';

describe('dom-wait primitives', () => {
  it('waitForCondition resolves with the first truthy probe value', async () => {
    let calls = 0;
    const value = await waitForCondition(
      () => (++calls >= 3 ? 'ready' : null),
      'probe',
      { timeoutMs: 1_000, intervalMs: 5 },
    );
    expect(value).toBe('ready');
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('waitForCondition rejects with WaitTimeoutError after the timeout', async () => {
    await expect(waitForCondition(() => null, 'never', { timeoutMs: 40, intervalMs: 5 })).rejects.toBeInstanceOf(
      WaitTimeoutError,
    );
  });

  it('waitForElement finds an element that appears later', async () => {
    setTimeout(() => {
      const el = document.createElement('div');
      el.className = 'late';
      document.body.appendChild(el);
    }, 20);
    const el = await waitForElement(document, ['.late'], 'late element', { timeoutMs: 1_000, intervalMs: 5 });
    expect(el.className).toBe('late');
  });

  it('waitForElement times out when nothing matches', async () => {
    await expect(
      waitForElement(document, ['.missing'], 'missing', { timeoutMs: 30, intervalMs: 5 }),
    ).rejects.toBeInstanceOf(WaitTimeoutError);
  });

  it('queryFirst walks selector fallbacks in order', () => {
    document.body.innerHTML = '<button class="b"></button><button class="c"></button>';
    expect(queryFirst(document, ['.a', '.b', '.c'])?.className).toBe('b');
    expect(queryFirst(document, ['.x', '.y'])).toBeNull();
  });

  it('sleep actually waits', async () => {
    const t0 = Date.now();
    await sleep(25);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(20);
  });
});

describe('selector registry', () => {
  it('declares ordered fallbacks for every Gemini dependency', () => {
    const keys = [
      'tempChatButton',
      'tempChatActiveMarker',
      'promptEditor',
      'sendButton',
      'stopButton',
      'fileInput',
      'attachmentChip',
      'responseContainer',
      'dropZone',
    ] as const;
    for (const key of keys) {
      expect(SELECTORS[key].length, `SELECTORS.${key} must have fallbacks`).toBeGreaterThanOrEqual(2);
    }
  });
});
