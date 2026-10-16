import { describe, expect, it, vi } from 'vitest';
import { PopupController, bytesToBase64, type PopupTransport } from '../entrypoints/popup/controller';
import { AUTOMATION_RUN_REQUEST, err, ok, type AutomationRunRequest } from '../types/automation';

function mount(transport: PopupTransport): { controller: PopupController; root: HTMLElement } {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const controller = new PopupController(root, transport);
  return { controller, root };
}

function setPrompt(root: HTMLElement, value: string): void {
  const textarea = root.querySelector<HTMLTextAreaElement>('#ga-prompt')!;
  textarea.value = value;
}

function setFile(root: HTMLElement, file: File | null): void {
  const input = root.querySelector<HTMLInputElement>('#ga-file')!;
  Object.defineProperty(input, 'files', { value: file ? [file] : [], configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('PopupController', () => {
  it('starts idle with all regions hidden and controls enabled', () => {
    const { root } = mount({ run: vi.fn() });
    expect(root.querySelector<HTMLButtonElement>('#ga-run')!.disabled).toBe(false);
    expect(root.querySelector<HTMLElement>('#ga-status')!.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>('#ga-result')!.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>('#ga-error')!.hidden).toBe(true);
  });

  it('runs a prompt-only automation and renders the success state', async () => {
    const run = vi.fn().mockResolvedValue(
      ok('Gemini says hi', { tabId: 3, durationMs: 10, streamingDetected: true, steps: ['extract'] }),
    );
    const { controller, root } = mount({ run });

    setPrompt(root, 'Say hi');
    const res = await controller.run();

    expect(run).toHaveBeenCalledTimes(1);
    const sent = run.mock.calls[0][0] as AutomationRunRequest;
    expect(sent.kind).toBe(AUTOMATION_RUN_REQUEST);
    expect(sent.prompt).toBe('Say hi');
    expect(sent.file).toBeUndefined();

    expect(res?.status).toBe('ok');
    expect(controller.getPhase()).toBe('success');
    expect(root.querySelector<HTMLElement>('#ga-result')!.hidden).toBe(false);
    expect(root.querySelector<HTMLElement>('#ga-result-text')!.textContent).toBe('Gemini says hi');
    expect(root.querySelector<HTMLElement>('#ga-status')!.hidden).toBe(true);
  });

  it('encodes a picked file into the request payload', async () => {
    const run = vi.fn().mockResolvedValue(ok('ok', { tabId: 1, durationMs: 1, streamingDetected: false, steps: [] }));
    const { controller, root } = mount({ run });

    setPrompt(root, 'Summarize');
    setFile(root, new File(['hello'], 'notes.txt', { type: 'text/plain' }));
    await controller.run();

    const sent = run.mock.calls[0][0] as AutomationRunRequest;
    expect(sent.file).toEqual({ name: 'notes.txt', mimeType: 'text/plain', dataBase64: 'aGVsbG8=', byteLength: 5 });
  });

  it('renders typed errors and returns to idle via retry', async () => {
    const run = vi.fn().mockResolvedValue(err('TEMP_CHAT_FAILED', 'control not found', 'temporary-chat'));
    const { controller, root } = mount({ run });

    setPrompt(root, 'go');
    await controller.run();

    expect(controller.getPhase()).toBe('error');
    const errorSection = root.querySelector<HTMLElement>('#ga-error')!;
    expect(errorSection.hidden).toBe(false);
    expect(root.querySelector<HTMLElement>('#ga-error-text')!.textContent).toContain('TEMP_CHAT_FAILED');

    root.querySelector<HTMLButtonElement>('#ga-retry')!.click();
    expect(controller.getPhase()).toBe('idle');
    expect(errorSection.hidden).toBe(true);
  });

  it('blocks empty prompts before any messaging happens', async () => {
    const run = vi.fn();
    const { controller, root } = mount({ run });

    setPrompt(root, '   ');
    const res = await controller.run();

    expect(res).toBeNull();
    expect(run).not.toHaveBeenCalled();
    expect(root.querySelector<HTMLElement>('#ga-prompt-error')!.hidden).toBe(false);
  });

  it('rejects disallowed attachments client-side without messaging', async () => {
    const run = vi.fn();
    const { controller, root } = mount({ run });

    setPrompt(root, 'go');
    setFile(root, new File(['MZ'], 'evil.exe', { type: 'application/x-msdownload' }));
    await controller.run();

    expect(run).not.toHaveBeenCalled();
    expect(controller.getPhase()).toBe('error');
    expect(root.querySelector<HTMLElement>('#ga-error-text')!.textContent).toContain('Attachment rejected');
  });

  it('bytesToBase64 round-trips ASCII content', () => {
    expect(bytesToBase64(new TextEncoder().encode('hello'))).toBe('aGVsbG8=');
  });
});
