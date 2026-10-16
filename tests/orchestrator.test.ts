import { describe, expect, it } from 'vitest';
import { runAutomation } from '../utils/automation-runner';
import { AUTOMATION_RUN_REQUEST, type AutomationRunRequest } from '../types/automation';
import { mountGeminiFixture } from './fixtures/gemini-dom';

const TXT_FILE = { name: 'notes.txt', mimeType: 'text/plain', dataBase64: 'aGVsbG8=', byteLength: 5 };

/** Fast timings so the pipeline test runs in well under a second. */
const FAST = {
  waits: { timeoutMs: 300, intervalMs: 5 },
  attach: { timeoutMs: 300, intervalMs: 5, registrationTimeoutMs: 100 },
  prompt: { timeoutMs: 300, intervalMs: 5, kickoffTimeoutMs: 150 },
  extraction: { timeoutMs: 600, intervalMs: 10, kickoffTimeoutMs: 150, stabilityPolls: 2 },
};

function request(partial: Partial<AutomationRunRequest> = {}): AutomationRunRequest {
  return { kind: AUTOMATION_RUN_REQUEST, prompt: 'Summarize this', ...partial };
}

describe('runAutomation orchestrator', () => {
  it('runs the full pipeline in order: temp-chat → attach → fill → submit → extract', async () => {
    const fx = mountGeminiFixture();
    const order: string[] = [];

    fx.tempChatButton.addEventListener('click', () => order.push('temp-chat-click'));
    fx.root.querySelector('.input-area')!.addEventListener('drop', () => {
      order.push('drop');
      setTimeout(() => {
        fx.registerAttachment('notes.txt');
        order.push('attachment-registered');
      }, 10);
    });
    fx.editor.addEventListener('input', () => order.push('fill'));
    fx.sendButton.addEventListener('click', () => {
      order.push('submit-click');
      void fx.streamResponse(['Hello ', 'from Gemini.'], { intervalMs: 15 });
    });

    const res = await runAutomation(document, request({ file: TXT_FILE }), { tabId: 42 }, FAST);

    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.text).toBe('Hello from Gemini.');
    expect(res.meta.tabId).toBe(42);
    expect(res.meta.streamingDetected).toBe(true);
    expect(res.meta.steps).toEqual(['temporary-chat', 'attach-file', 'fill-prompt', 'submit', 'extract']);

    // Gate-3 ordering proof: registration strictly precedes submission.
    expect(order.indexOf('attachment-registered')).toBeGreaterThan(-1);
    expect(order.indexOf('attachment-registered')).toBeLessThan(order.indexOf('submit-click'));
    expect(order.indexOf('temp-chat-click')).toBeLessThan(order.indexOf('drop'));
    expect(order.indexOf('fill')).toBeLessThan(order.indexOf('submit-click'));
  });

  it('skips the attachment step entirely when no file is provided', async () => {
    const fx = mountGeminiFixture({ tempChatActive: true });
    fx.sendButton.addEventListener('click', () => void fx.streamResponse(['quick'], { intervalMs: 10 }));

    const res = await runAutomation(document, request(), { tabId: 1 }, FAST);
    expect(res.status).toBe('ok');
    // temp-chat step completes via idempotent verification (already active);
    // attach-file is skipped because no file was provided.
    if (res.status === 'ok') expect(res.meta.steps).toEqual(['temporary-chat', 'fill-prompt', 'submit', 'extract']);
  });

  it('maps step failures to typed error responses without throwing', async () => {
    mountGeminiFixture({ buttonActivates: false });
    const res = await runAutomation(document, request(), { tabId: 1 }, FAST);
    expect(res.status).toBe('error');
    if (res.status !== 'error') return;
    expect(res.error.code).toBe('TEMP_CHAT_FAILED');
    expect(res.error.step).toBe('temporary-chat');
    expect(res.meta?.steps).toEqual([]);
  });

  it('surfaces ATTACH_NOT_REGISTERED mid-pipeline and never submits', async () => {
    const fx = mountGeminiFixture(); // no drop/change handlers → registration never happens
    let submitted = false;
    fx.sendButton.addEventListener('click', () => {
      submitted = true;
    });

    const res = await runAutomation(document, request({ file: TXT_FILE }), { tabId: 1 }, FAST);
    expect(res.status).toBe('error');
    if (res.status !== 'error') return;
    expect(res.error.code).toBe('ATTACH_NOT_REGISTERED');
    expect(submitted).toBe(false);
  });
});
