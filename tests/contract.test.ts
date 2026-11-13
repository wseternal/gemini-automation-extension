import { describe, expect, it } from 'vitest';
import {
  ALLOWED_MIME_TYPES,
  AUTOMATION_RUN_REQUEST,
  AUTOMATION_RUN_RESPONSE,
  AutomationErrorException,
  DEFAULT_STREAM_TIMEOUT_MS,
  MAX_FILE_BYTES,
  isAutomationRunRequest,
  isAutomationRunResponse,
  ok,
  err,
  validateFilePayload,
  type AutomationRunRequest,
} from '../types/automation';
import { escapeMarkdown, cleanOutput } from '../utils/dom-to-markdown';

describe('messaging contract', () => {
  const validRequest: AutomationRunRequest = {
    kind: AUTOMATION_RUN_REQUEST,
    prompt: 'Summarize this file',
    file: { name: 'a.pdf', mimeType: 'application/pdf', dataBase64: 'QUJD', byteLength: 3 },
  };

  it('accepts a well-formed run request', () => {
    expect(isAutomationRunRequest(validRequest)).toBe(true);
  });

  it('accepts a request without a file', () => {
    expect(isAutomationRunRequest({ kind: AUTOMATION_RUN_REQUEST, prompt: 'hi' })).toBe(true);
  });

  it.each([
    ['wrong kind', { kind: 'nope', prompt: 'x' }],
    ['empty prompt', { kind: AUTOMATION_RUN_REQUEST, prompt: '' }],
    ['non-string prompt', { kind: AUTOMATION_RUN_REQUEST, prompt: 42 }],
    ['null', null],
    ['array', []],
    ['file missing fields', { kind: AUTOMATION_RUN_REQUEST, prompt: 'x', file: { name: 'a.pdf' } }],
  ])('rejects malformed request: %s', (_label, msg) => {
    expect(isAutomationRunRequest(msg)).toBe(false);
  });

  it('builds and recognizes an ok response', () => {
    const res = ok('full text', { tabId: 7, providerId: 'gemini', durationMs: 12, streamingDetected: true, steps: ['extract'] });
    expect(res.kind).toBe(AUTOMATION_RUN_RESPONSE);
    expect(res.status).toBe('ok');
    expect(isAutomationRunResponse(res)).toBe(true);
    if (res.status === 'ok') expect(res.text).toBe('full text');
  });

  it('builds and recognizes an error response', () => {
    const res = err('STREAM_TIMEOUT', 'timed out', 'extract');
    expect(res.status).toBe('error');
    expect(isAutomationRunResponse(res)).toBe(true);
    if (res.status === 'error') {
      expect(res.error.code).toBe('STREAM_TIMEOUT');
      expect(res.error.step).toBe('extract');
    }
  });

  it('rejects responses with unknown status', () => {
    expect(isAutomationRunResponse({ kind: AUTOMATION_RUN_RESPONSE, status: 'maybe' })).toBe(false);
  });

  it('validates file payloads against guardrails', () => {
    expect(validateFilePayload({ name: 'a.pdf', mimeType: 'application/pdf', dataBase64: 'QUJD', byteLength: 3 }).ok).toBe(true);

    const tooBig = validateFilePayload({
      name: 'big.pdf',
      mimeType: 'application/pdf',
      dataBase64: 'QUJD',
      byteLength: MAX_FILE_BYTES + 1,
    });
    expect(tooBig.ok).toBe(false);

    const badType = validateFilePayload({ name: 'x.exe', mimeType: 'application/x-msdownload', dataBase64: 'QUJD', byteLength: 3 });
    expect(badType.ok).toBe(false);

    const badBase64 = validateFilePayload({ name: 'a.pdf', mimeType: 'application/pdf', dataBase64: '!!!', byteLength: 3 });
    expect(badBase64.ok).toBe(false);

    const mismatch = validateFilePayload({ name: 'a.pdf', mimeType: 'application/pdf', dataBase64: 'QUJD', byteLength: 99 });
    expect(mismatch.ok).toBe(false);
  });

  it('exposes sane defaults and allow-list', () => {
    expect(DEFAULT_STREAM_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
    expect(ALLOWED_MIME_TYPES).toContain('application/pdf');
    expect(ALLOWED_MIME_TYPES).toContain('image/png');
    expect(ALLOWED_MIME_TYPES).toContain('text/plain');
  });

  it('AutomationErrorException carries code and step', () => {
    const e = new AutomationErrorException('ATTACH_FAILED', 'boom', 'attach-file');
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('ATTACH_FAILED');
    expect(e.step).toBe('attach-file');
    expect(e.toAutomationError()).toEqual({ code: 'ATTACH_FAILED', message: 'boom', step: 'attach-file' });
  });
});

describe('escapeMarkdown', () => {
  it('escapes ampersands', () => {
    expect(escapeMarkdown('a & b')).toBe('a &amp; b');
  });

  it('escapes angle brackets', () => {
    expect(escapeMarkdown('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes backslashes', () => {
    expect(escapeMarkdown('path\\to\\file')).toBe('path\\\\to\\\\file');
  });

  it('escapes backticks', () => {
    expect(escapeMarkdown('code `block` here')).toBe('code \\`block\\` here');
  });

  it('handles empty string', () => {
    expect(escapeMarkdown('')).toBe('');
  });

  it('leaves plain text unchanged', () => {
    expect(escapeMarkdown('hello world')).toBe('hello world');
  });
});

describe('cleanOutput', () => {
  it('collapses 3+ newlines to 2', () => {
    expect(cleanOutput('a\n\n\n\nb')).toBe('a\n\nb');
  });

  it('trims leading and trailing whitespace', () => {
    expect(cleanOutput('  \n\nhello\n\n  ')).toBe('hello');
  });

  it('preserves double newlines', () => {
    expect(cleanOutput('a\n\nb')).toBe('a\n\nb');
  });

  it('handles empty string', () => {
    expect(cleanOutput('')).toBe('');
  });

  it('handles only whitespace', () => {
    expect(cleanOutput('   \n\n   ')).toBe('');
  });

  it('strips leading Gemini said attribution', () => {
    expect(cleanOutput('Gemini said\nHello world')).toBe('Hello world');
  });

  it('strips leading DeepSeek said attribution', () => {
    expect(cleanOutput('DeepSeek said\nSome response')).toBe('Some response');
  });

  it('strips case-insensitive ChatGPT said attribution', () => {
    expect(cleanOutput('chatgpt said\nAnswer here')).toBe('Answer here');
  });

  it('does not strip attribution mid-text', () => {
    expect(cleanOutput('Hello\nGemini said\nworld')).toBe('Hello\nGemini said\nworld');
  });

  it('strips attribution with trailing newlines', () => {
    expect(cleanOutput('Claude said\n\nActual content')).toBe('Actual content');
  });
});
