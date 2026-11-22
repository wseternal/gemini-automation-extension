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
  isLongPollClearPendingRequest,
  isLongPollClearPendingResponse,
  LONG_POLL_CLEAR_PENDING_REQUEST,
  LONG_POLL_CLEAR_PENDING_RESPONSE,
  ok,
  err,
  validateFilePayload,
  type AutomationRunRequest,
} from '../types/automation';
import { escapeMarkdown, cleanOutput } from '../utils/dom-to-markdown';
import {
  coerceLongPollConfig,
  isLongPollLease,
  isLongPollPendingAckMap,
  isLongPollStatus,
  mapPollJobToRequest,
  normalizeProxyUrl,
  parsePollJob,
  pendingAckKey,
  requestDigest,
} from '../utils/long-poll-protocol';
import { deepseekProvider } from '../providers/deepseek';
import { geminiProvider } from '../providers/gemini';

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

  it('builds and recognizes a BUSY error response', () => {
    const res = err('BUSY', 'another run is active', 'submit');
    expect(isAutomationRunResponse(res)).toBe(true);
    if (res.status === 'error') expect(res.error.code).toBe('BUSY');
  });

  it('recognizes the clear-pending request and response', () => {
    expect(isLongPollClearPendingRequest({ kind: LONG_POLL_CLEAR_PENDING_REQUEST })).toBe(true);
    expect(isLongPollClearPendingRequest({ kind: 'other' })).toBe(false);
    expect(
      isLongPollClearPendingResponse({ kind: LONG_POLL_CLEAR_PENDING_RESPONSE, cleared: 2 }),
    ).toBe(true);
    expect(
      isLongPollClearPendingResponse({ kind: LONG_POLL_CLEAR_PENDING_RESPONSE, cleared: -1 }),
    ).toBe(false);
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

describe('normalizeProxyUrl', () => {
  it('normalizes a loopback URL and strips a trailing slash', () => {
    expect(normalizeProxyUrl('  http://localhost:9090/  ')).toEqual({
      ok: true,
      url: 'http://localhost:9090',
    });
    expect(normalizeProxyUrl('http://127.0.0.1:9090/api/')).toEqual({
      ok: true,
      url: 'http://127.0.0.1:9090/api',
    });
  });

  it.each([
    ['empty', ''],
    ['relative', 'localhost:9090'],
    ['https', 'https://localhost:9090'],
    ['remote host', 'http://example.com:9090'],
    ['query', 'http://localhost:9090/?token=x'],
    ['hash', 'http://localhost:9090/#x'],
    ['credentials', 'http://user:pass@localhost:9090'],
  ])('rejects %s URL input', (_label, raw) => {
    expect(normalizeProxyUrl(raw).ok).toBe(false);
  });
});

describe('coerceLongPollConfig', () => {
  it('normalizes a stored URL and preserves a token', () => {
    expect(
      coerceLongPollConfig({
        proxyUrl: 'http://localhost:9090/proxy/',
        enabled: true,
        token: '  secret  ',
      }),
    ).toEqual({
      proxyUrl: 'http://localhost:9090/proxy',
      enabled: true,
      token: 'secret',
    });
  });

  it('disables and clears a malformed stored URL', () => {
    expect(
      coerceLongPollConfig({
        proxyUrl: 'http://user:pass@localhost:9090/?bad=1',
        enabled: true,
      }),
    ).toEqual({ proxyUrl: '', enabled: false });
  });

  it('drops a stored token that contains line breaks', () => {
    expect(
      coerceLongPollConfig({
        proxyUrl: 'http://localhost:9090',
        enabled: true,
        token: 'secret\r\nX-Injected: 1',
      }),
    ).toEqual({ proxyUrl: 'http://localhost:9090', enabled: true });
  });
});

describe('isLongPollStatus', () => {
  it.each(['disabled', 'connecting', 'polling', 'degraded', 'error'])(
    'accepts the %s state',
    (state) => {
      expect(isLongPollStatus({ state, updatedAt: 1 })).toBe(true);
    },
  );

  it('accepts ack and failure detail', () => {
    expect(
      isLongPollStatus({
        state: 'degraded',
        proxyUrl: 'http://localhost:9090',
        message: 'result delivery failed',
        errorKind: 'protocol',
        lastError: 'poll timeout',
        failureCount: 2,
        lastAckError: 'result rejected',
        ackFailures: 1,
        lastAckAt: 1_700_000_000_000,
        pendingAcks: [{ jobId: 'j_1', error: 'result rejected', lastAttemptAt: 1_700_000_000_000 }],
        updatedAt: 1_700_000_000_001,
      }),
    ).toBe(true);
  });

  it.each([
    ['unknown state', { state: 'maybe', updatedAt: 1 }],
    ['missing timestamp', { state: 'polling' }],
    ['negative failure count', { state: 'polling', updatedAt: 1, failureCount: -1 }],
    ['fractional ack count', { state: 'polling', updatedAt: 1, ackFailures: 1.5 }],
    ['non-string last error', { state: 'polling', updatedAt: 1, lastError: 3 }],
    ['unknown error kind', { state: 'error', updatedAt: 1, errorKind: 'oops' }],
    ['non-array pending acks', { state: 'degraded', updatedAt: 1, pendingAcks: 'j_1' }],
    ['malformed pending ack', { state: 'degraded', updatedAt: 1, pendingAcks: [{ jobId: 'j_1' }] }],
  ])('rejects malformed status: %s', (_label, value) => {
    expect(isLongPollStatus(value)).toBe(false);
  });
});

describe('poll job parsing', () => {
  it('preserves the job id and leaves the request untrusted', () => {
    const job = parsePollJob({ job_id: 'j_1', request: { prompt: 'hi' } });
    expect(job.job_id).toBe('j_1');
    expect(job.request).toEqual({ prompt: 'hi' });
  });

  it('keeps a job with a missing request so it can be acknowledged', () => {
    const job = parsePollJob({ job_id: 'j_2' });
    expect(job.job_id).toBe('j_2');
    expect(job.request).toBeUndefined();
  });

  it.each([
    ['array', []],
    ['null', null],
    ['missing job id', { request: { prompt: 'hi' } }],
    ['empty job id', { job_id: '   ', request: { prompt: 'hi' } }],
  ])('rejects a malformed poll envelope: %s', (_label, value) => {
    expect(() => parsePollJob(value)).toThrow();
  });
});

describe('mapPollJobToRequest', () => {
  it('maps snake_case fields and clamps an excessive timeout', () => {
    const request = mapPollJobToRequest({
      job_id: 'j_3',
      request: {
        prompt: 'Summarize',
        provider_id: 'deepseek',
        timeout_ms: 999_999,
        target_url: 'https://chat.deepseek.com/',
        file: {
          name: 'a.pdf',
          mime_type: 'application/pdf',
          data_base64: 'QUJD',
          byte_length: 3,
        },
      },
    });
    expect(request).toEqual({
      kind: AUTOMATION_RUN_REQUEST,
      prompt: 'Summarize',
      providerId: 'deepseek',
      timeoutMs: 300_000,
      targetUrl: 'https://chat.deepseek.com/',
      file: { name: 'a.pdf', mimeType: 'application/pdf', dataBase64: 'QUJD', byteLength: 3 },
    });
  });

  it('rejects an unknown provider with a typed error', () => {
    try {
      mapPollJobToRequest({ job_id: 'j_4', request: { prompt: 'hi', provider_id: 'nope' } });
      throw new Error('expected mapPollJobToRequest to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AutomationErrorException);
      expect((error as AutomationErrorException).code).toBe('INVALID_PROVIDER');
    }
  });

  it('surfaces the file guardrail reason instead of discarding it', () => {
    try {
      mapPollJobToRequest({
        job_id: 'j_8',
        request: {
          prompt: 'hi',
          file: {
            name: 'x.exe',
            mime_type: 'application/x-msdownload',
            data_base64: 'QUJD',
            byte_length: 3,
          },
        },
      });
      throw new Error('expected mapPollJobToRequest to throw');
    } catch (error) {
      expect((error as Error).message).toContain('mime type not allowed');
    }
  });

  it.each([
    ['missing request', { job_id: 'j_5', request: undefined }],
    ['missing prompt', { job_id: 'j_6', request: { provider_id: 'gemini' } }],
    ['non-numeric timeout', { job_id: 'j_7', request: { prompt: 'hi', timeout_ms: 'soon' } }],
    ['malformed file', { job_id: 'j_8', request: { prompt: 'hi', file: { name: 'a.pdf' } } }],
  ])('rejects %s', (_label, job) => {
    expect(() => mapPollJobToRequest(job)).toThrow();
  });
});

describe('lease shape', () => {
  it('accepts metadata only and rejects a persisted request body', () => {
    expect(
      isLongPollLease({
        jobId: 'j_1',
        requestDigest: 'v1:1:1:0',
        receivedAt: 1_700_000_000_000,
      }),
    ).toBe(true);
    expect(
      isLongPollLease({
        jobId: 'j_1',
        requestDigest: 'v1:1:1:0',
        receivedAt: 1_700_000_000_000,
        request: { prompt: 'x', file: { data_base64: 'QUJD' } },
      }),
    ).toBe(false);
  });
});

describe('pending-ack identity', () => {
  it('scopes keys by proxy and job id', () => {
    expect(pendingAckKey('http://localhost:9090', 'j_1')).toBe('http://localhost:9090|j_1');
    expect(pendingAckKey('http://localhost:9091', 'j_1')).not.toBe(
      pendingAckKey('http://localhost:9090', 'j_1'),
    );
  });

  it('changes the digest when the target or file size changes', () => {
    const base: AutomationRunRequest = {
      kind: AUTOMATION_RUN_REQUEST,
      prompt: 'Summarize this document and keep the important details',
      providerId: 'gemini',
    };
    const digest = requestDigest(base);
    expect(digest).not.toContain(base.prompt);
    expect(requestDigest({ ...base })).toBe(digest);
    expect(requestDigest({ ...base, targetUrl: 'https://gemini.google.com/app/x' })).not.toBe(digest);
    expect(
      requestDigest({
        ...base,
        file: { name: 'a.pdf', mimeType: 'application/pdf', dataBase64: 'QUJD', byteLength: 3 },
      }),
    ).not.toBe(digest);
  });

  it('accepts a well-keyed pending map and rejects a mismatched key', () => {
    const response = ok('full text', {
      tabId: 7,
      providerId: 'gemini',
      durationMs: 12,
      streamingDetected: true,
      steps: ['extract'],
    });
    const record = {
      proxyUrl: 'http://localhost:9090',
      jobId: 'j_1',
      requestDigest: 'v1:1:1:0',
      response,
      error: 'result rejected',
      attempts: 1,
      lastAttemptAt: 1_700_000_000_000,
    };
    expect(isLongPollPendingAckMap({ [pendingAckKey('http://localhost:9090', 'j_1')]: record })).toBe(true);
    expect(isLongPollPendingAckMap({ wrong: record })).toBe(false);
  });
});

describe('provider URL families', () => {
  it('accepts a DeepSeek conversation URL', () => {
    expect(deepseekProvider.isProviderUrl('https://chat.deepseek.com/a/chat/s/abc123')).toBe(true);
  });

  it('accepts Gemini multi-account app URLs', () => {
    expect(geminiProvider.isProviderUrl('https://gemini.google.com/u/0/app/abc123')).toBe(true);
    expect(geminiProvider.isProviderUrl('https://gemini.google.com/u/2/app')).toBe(true);
  });

  it.each([
    ['deepseek lookalike path', deepseekProvider, 'https://chat.deepseek.com/a/chat-evil/s/1'],
    ['deepseek credentials', deepseekProvider, 'https://user:pass@chat.deepseek.com/a/chat/s/1'],
    ['gemini lookalike path', geminiProvider, 'https://gemini.google.com/u/0/application'],
    ['gemini non-app path', geminiProvider, 'https://gemini.google.com/u/0/other'],
    ['gemini credentials', geminiProvider, 'https://user:pass@gemini.google.com/u/0/app'],
  ])('rejects %s', (_label, provider, url) => {
    expect(provider.isProviderUrl(url)).toBe(false);
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
