/**
 * types/automation.ts — the single messaging contract for the extension.
 *
 * Every cross-context message (popup ↔ background ↔ content script) is
 * described here. Importing this module is the only sanctioned way to
 * construct, validate, or narrow automation messages.
 */

// ---------------------------------------------------------------------------
// Message discriminators
// ---------------------------------------------------------------------------

export const AUTOMATION_RUN_REQUEST = 'gemini-automation/run' as const;
export const AUTOMATION_RUN_RESPONSE = 'gemini-automation/result' as const;

// ---------------------------------------------------------------------------
// File payload guardrails (security gate 8)
// ---------------------------------------------------------------------------

/** Hard cap on decoded file size accepted by the extension. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MiB

/** MIME types Gemini's uploader accepts that we are willing to forward. */
export const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'application/json',
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;

export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/** A file handed to the extension for attachment. Bytes travel as base64. */
export interface FilePayload {
  readonly name: string;
  readonly mimeType: string;
  /** base64-encoded file bytes (no data-URL prefix). */
  readonly dataBase64: string;
  /** Decoded byte length — must match the decoded `dataBase64`. */
  readonly byteLength: number;
}

export interface AutomationRunRequest {
  readonly kind: typeof AUTOMATION_RUN_REQUEST;
  /** Query string placed into the Gemini prompt editor. */
  readonly prompt: string;
  /** Optional file to attach before submitting. */
  readonly file?: FilePayload;
  /** Whether to force Temporary Chat mode first. Defaults to `true`. */
  readonly temporaryChat?: boolean;
  /** Overall streaming timeout in ms. Defaults to {@link DEFAULT_STREAM_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export type AutomationStep = 'temporary-chat' | 'attach-file' | 'fill-prompt' | 'submit' | 'extract';

export type AutomationErrorCode =
  | 'NO_GEMINI_TAB'
  | 'TAB_LOAD_TIMEOUT'
  | 'TEMP_CHAT_FAILED'
  | 'ATTACH_FAILED'
  | 'ATTACH_NOT_REGISTERED'
  | 'PROMPT_NOT_FOUND'
  | 'SUBMIT_FAILED'
  | 'STREAM_TIMEOUT'
  | 'EXTRACTION_FAILED'
  | 'INVALID_PAYLOAD'
  | 'INTERNAL';

export interface AutomationError {
  readonly code: AutomationErrorCode;
  readonly message: string;
  readonly step?: AutomationStep;
}

export interface AutomationRunMeta {
  readonly tabId: number;
  readonly durationMs: number;
  /** True when the stop-generation indicator was observed during streaming. */
  readonly streamingDetected: boolean;
  /** Pipeline steps that completed, in order. */
  readonly steps: readonly AutomationStep[];
}

export interface AutomationRunOk {
  readonly kind: typeof AUTOMATION_RUN_RESPONSE;
  readonly status: 'ok';
  /** Complete rendered response text, captured after streaming finished. */
  readonly text: string;
  readonly meta: AutomationRunMeta;
}

export interface AutomationRunError {
  readonly kind: typeof AUTOMATION_RUN_RESPONSE;
  readonly status: 'error';
  readonly error: AutomationError;
  readonly meta?: Partial<AutomationRunMeta>;
}

export type AutomationRunResponse = AutomationRunOk | AutomationRunError;

export const DEFAULT_STREAM_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export function ok(text: string, meta: AutomationRunMeta): AutomationRunOk {
  return { kind: AUTOMATION_RUN_RESPONSE, status: 'ok', text, meta };
}

export function err(code: AutomationErrorCode, message: string, step?: AutomationStep): AutomationRunError {
  return { kind: AUTOMATION_RUN_RESPONSE, status: 'error', error: step ? { code, message, step } : { code, message } };
}

// ---------------------------------------------------------------------------
// Validation & type guards
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export function validateFilePayload(file: unknown): { ok: true } | { ok: false; reason: string } {
  if (!isRecord(file)) return { ok: false, reason: 'file payload is not an object' };
  const { name, mimeType, dataBase64, byteLength } = file;
  if (typeof name !== 'string' || name.trim().length === 0) return { ok: false, reason: 'file name missing' };
  if (typeof mimeType !== 'string' || !(ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType)) {
    return { ok: false, reason: `mime type not allowed: ${String(mimeType)}` };
  }
  if (typeof dataBase64 !== 'string' || dataBase64.length === 0 || dataBase64.length % 4 !== 0 || !BASE64_RE.test(dataBase64)) {
    return { ok: false, reason: 'dataBase64 is not valid base64' };
  }
  if (typeof byteLength !== 'number' || !Number.isInteger(byteLength) || byteLength <= 0) {
    return { ok: false, reason: 'byteLength must be a positive integer' };
  }
  if (byteLength > MAX_FILE_BYTES) {
    return { ok: false, reason: `file exceeds ${MAX_FILE_BYTES} byte limit` };
  }
  // base64 expands 4 chars per 3 bytes; padding trims 1–2 bytes.
  const padding = dataBase64.endsWith('==') ? 2 : dataBase64.endsWith('=') ? 1 : 0;
  const decodedLength = (dataBase64.length / 4) * 3 - padding;
  if (decodedLength !== byteLength) {
    return { ok: false, reason: `byteLength ${byteLength} does not match decoded base64 length ${decodedLength}` };
  }
  return { ok: true };
}

export function isFilePayload(value: unknown): value is FilePayload {
  return validateFilePayload(value).ok;
}

export function isAutomationRunRequest(msg: unknown): msg is AutomationRunRequest {
  if (!isRecord(msg)) return false;
  if (msg.kind !== AUTOMATION_RUN_REQUEST) return false;
  if (typeof msg.prompt !== 'string' || msg.prompt.trim().length === 0) return false;
  if (msg.file !== undefined && !isFilePayload(msg.file)) return false;
  if (msg.temporaryChat !== undefined && typeof msg.temporaryChat !== 'boolean') return false;
  if (msg.timeoutMs !== undefined && (typeof msg.timeoutMs !== 'number' || msg.timeoutMs <= 0)) return false;
  return true;
}

const ERROR_CODES: readonly AutomationErrorCode[] = [
  'NO_GEMINI_TAB',
  'TAB_LOAD_TIMEOUT',
  'TEMP_CHAT_FAILED',
  'ATTACH_FAILED',
  'ATTACH_NOT_REGISTERED',
  'PROMPT_NOT_FOUND',
  'SUBMIT_FAILED',
  'STREAM_TIMEOUT',
  'EXTRACTION_FAILED',
  'INVALID_PAYLOAD',
  'INTERNAL',
];

export function isAutomationRunResponse(msg: unknown): msg is AutomationRunResponse {
  if (!isRecord(msg) || msg.kind !== AUTOMATION_RUN_RESPONSE) return false;
  if (msg.status === 'ok') return typeof msg.text === 'string' && isRecord(msg.meta);
  if (msg.status === 'error') {
    return (
      isRecord(msg.error) &&
      typeof msg.error.message === 'string' &&
      ERROR_CODES.includes(msg.error.code as AutomationErrorCode)
    );
  }
  return false;
}

// ---------------------------------------------------------------------------
// Internal exception used to ferry typed failures through the pipeline
// ---------------------------------------------------------------------------

export class AutomationErrorException extends Error {
  readonly code: AutomationErrorCode;
  readonly step?: AutomationStep;

  constructor(code: AutomationErrorCode, message: string, step?: AutomationStep) {
    super(message);
    this.name = 'AutomationErrorException';
    this.code = code;
    this.step = step;
  }

  toAutomationError(): AutomationError {
    return this.step ? { code: this.code, message: this.message, step: this.step } : { code: this.code, message: this.message };
  }
}
