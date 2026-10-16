import { describe, expect, it, vi } from 'vitest';
import { attachFile, decodeFilePayload } from '../utils/file-attachment';
import { mountGeminiFixture } from './fixtures/gemini-dom';
import type { FilePayload } from '../types/automation';

// "hello" as base64
const TXT_PAYLOAD: FilePayload = { name: 'notes.txt', mimeType: 'text/plain', dataBase64: 'aGVsbG8=', byteLength: 5 };
const FAST = { timeoutMs: 200, intervalMs: 5, registrationTimeoutMs: 60 };

describe('decodeFilePayload', () => {
  it('materializes a File from a valid payload', () => {
    const file = decodeFilePayload(TXT_PAYLOAD);
    expect(file.name).toBe('notes.txt');
    expect(file.type).toBe('text/plain');
    expect(file.size).toBe(5);
  });

  it.each([
    ['oversize', { ...TXT_PAYLOAD, byteLength: 21 * 1024 * 1024, dataBase64: 'aGVsbG8=' }],
    ['disallowed mime', { ...TXT_PAYLOAD, mimeType: 'application/x-msdownload' }],
    ['bad base64', { ...TXT_PAYLOAD, dataBase64: '%%%' }],
  ])('rejects %s payloads with INVALID_PAYLOAD', (_label, payload) => {
    expect(() => decodeFilePayload(payload as FilePayload)).toThrowError(
      expect.objectContaining({ code: 'INVALID_PAYLOAD' }),
    );
  });
});

describe('attachFile', () => {
  it('delivers the file via a synthesized DataTransfer drop and waits for registration', async () => {
    const fx = mountGeminiFixture();
    const droppedFiles: string[] = [];
    // Simulate Gemini's drop handler: reads dataTransfer.files, then registers the chip.
    fx.root.querySelector('.input-area')!.addEventListener('drop', (e) => {
      const dt = (e as DragEvent).dataTransfer!;
      for (const f of Array.from(dt.files)) droppedFiles.push(f.name);
      setTimeout(() => fx.registerAttachment('notes.txt'), 10);
    });

    await attachFile(document, TXT_PAYLOAD, FAST);

    expect(droppedFiles).toEqual(['notes.txt']);
    expect(document.querySelector('.uploader-chip')).not.toBeNull();
  });

  it('falls back to the hidden file input when the drop is not registered', async () => {
    const fx = mountGeminiFixture();
    // No drop handler — the drop falls on deaf ears. Gemini's real uploader listens on the input instead.
    fx.fileInput.addEventListener('change', () => setTimeout(() => fx.registerAttachment('notes.txt'), 10));

    await attachFile(document, TXT_PAYLOAD, FAST);

    expect(fx.fileInput.files?.[0]?.name).toBe('notes.txt');
    expect(document.querySelector('.uploader-chip')).not.toBeNull();
  });

  it('rejects with ATTACH_NOT_REGISTERED when Gemini never confirms the attachment', async () => {
    mountGeminiFixture(); // neither drop nor change handlers wired
    await expect(attachFile(document, TXT_PAYLOAD, FAST)).rejects.toMatchObject({
      code: 'ATTACH_NOT_REGISTERED',
      step: 'attach-file',
    });
  });

  it('rejects with ATTACH_FAILED when neither drop zone nor file input exists', async () => {
    document.body.innerHTML = '<div class="nothing"></div>';
    await expect(attachFile(document, TXT_PAYLOAD, FAST)).rejects.toMatchObject({
      code: 'ATTACH_FAILED',
      step: 'attach-file',
    });
  });

  it('rejects invalid payloads before touching the DOM', async () => {
    const fx = mountGeminiFixture();
    const spy = vi.fn();
    fx.root.addEventListener('drop', spy);
    await expect(
      attachFile(document, { ...TXT_PAYLOAD, mimeType: 'application/x-msdownload' }, FAST),
    ).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
    expect(spy).not.toHaveBeenCalled();
  });
});
