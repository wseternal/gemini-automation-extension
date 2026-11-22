/**
 * utils/long-poll-protocol.ts — pure long-poll wire types, validation, and
 * job mapping.
 *
 * This module must stay free of browser imports so the normalization,
 * status guards, poll-envelope parser, and request mapper can be tested
 * without mocks or the extension runtime.
 */

import {
  AUTOMATION_RUN_REQUEST,
  AutomationErrorException,
  err,
  isAutomationRunRequest,
  isAutomationRunResponse,
  validateFilePayload,
  type AutomationRunRequest,
  type AutomationRunResponse,
} from '../types/automation';
import { listProviderIds } from '../providers';
import type { LlmProviderId } from '../types/provider';

/** Configuration stored in browser.storage.local under LONG_POLL_CONFIG_KEY. */
export interface LongPollConfig {
  /** Base URL of the proxy server (e.g. "http://localhost:9090"). */
  proxyUrl: string;
  /** Whether the long-poll client is enabled. */
  enabled: boolean;
  /** Optional shared secret sent as the X-Bridge-Token header. */
  token?: string;
}

export const LONG_POLL_CONFIG_KEY = 'llm-automation/long-poll-config';
export const LONG_POLL_STATUS_KEY = 'llm-automation/long-poll-status';
/** In-flight job metadata persisted in storage.session so a suspended worker can reconcile it. */
export const LONG_POLL_LEASE_KEY = 'llm-automation/long-poll-lease';
/** Durable map of jobs whose result has not been acknowledged yet. */
export const LONG_POLL_FAILED_RESULTS_KEY = 'llm-automation/long-poll-failed-results';

/** How soon the status writer may repeat the same unchanged value. */
export const LONG_POLL_STATUS_REFRESH_MS = 30_000;
/** Both UIs mark a status stale after this long without an update. */
export const LONG_POLL_STATUS_STALE_AFTER_MS = 90_000;
/** Live-loop refresh cadence, comfortably below the stale threshold. */
export const LONG_POLL_REQUEST_HEARTBEAT_MS = 20_000;
/** A result may be reused for this long after its last delivery attempt. */
export const LONG_POLL_ACK_RETRY_WINDOW_MS = 10 * 60_000;
/** Bound on retained unacknowledged results. */
export const LONG_POLL_MAX_PENDING_ACKS = 5;
/** Upper bound on a job's requested stream timeout. */
export const MAX_REQUEST_TIMEOUT_MS = 300_000;

export const DEFAULT_LONG_POLL_CONFIG: LongPollConfig = { proxyUrl: '', enabled: false };

/** State of the background client, written by background.ts. */
export type LongPollState = 'disabled' | 'connecting' | 'polling' | 'degraded' | 'error';

/** Source of the last error, so the UI can label it precisely. */
export type LongPollErrorKind = 'transport' | 'protocol' | 'config';

/** Compact, user-facing view of one unacknowledged result. */
export interface LongPollPendingAckSummary {
  readonly jobId: string;
  readonly error: string;
  readonly lastAttemptAt: number;
}

export interface LongPollStatus {
  readonly state: LongPollState;
  /** URL that the running client polls. */
  readonly proxyUrl?: string;
  /** Human-readable detail for the current state. */
  readonly message?: string;
  /** Last poll failure while the client is in the `error` state. */
  readonly lastError?: string;
  /** Kind of the last error; the UI uses it for the label. */
  readonly errorKind?: LongPollErrorKind;
  /** Consecutive poll failures. */
  readonly failureCount?: number;
  /** Most recent result-delivery failure among pending results. */
  readonly lastAckError?: string;
  /** Number of results still awaiting acknowledgement. */
  readonly ackFailures?: number;
  /** Timestamp of the last successful result delivery. */
  readonly lastAckAt?: number;
  /** Inspectable pending records, newest first. */
  readonly pendingAcks?: readonly LongPollPendingAckSummary[];
  readonly updatedAt: number;
}

/** Status access shared by the options page and popup transports. */
export interface LongPollStatusTransport {
  getStatus(): Promise<LongPollStatus | undefined>;
  /** Listen for status changes. Returns an unsubscribe function. */
  watchStatus(listener: (status: LongPollStatus | undefined) => void): () => void;
}

/** Durable metadata for an in-flight job. Never contains the request payload. */
export interface LongPollLease {
  readonly jobId: string;
  readonly requestDigest: string;
  readonly receivedAt: number;
}

/** A result produced for a job that the proxy has not acknowledged yet. */
export interface LongPollPendingAck {
  readonly proxyUrl: string;
  readonly jobId: string;
  readonly requestDigest: string;
  readonly response: AutomationRunResponse;
  readonly error: string;
  readonly attempts: number;
  readonly lastAttemptAt: number;
}

export type LongPollPendingAckMap = Record<string, LongPollPendingAck>;

/** A job as received from the proxy. `request` stays untrusted until mapped. */
export interface PollJob {
  readonly job_id: string;
  readonly request: unknown;
}

/** A malformed wire payload — distinct from a transport failure. */
export class LongPollProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LongPollProtocolError';
  }
}

export type ProxyUrlResult = { ok: true; url: string } | { ok: false; reason: string };

/**
 * Normalize user input into a base URL that the manifest can reach.
 * The manifest grants host access to http://localhost and http://127.0.0.1 only.
 */
export function normalizeProxyUrl(raw: string): ProxyUrlResult {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: 'Enter the proxy URL.' };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'Enter a full URL, such as http://localhost:9090.' };
  }

  if (parsed.protocol !== 'http:') {
    return { ok: false, reason: 'Use an http:// URL. The manifest does not grant access to https hosts.' };
  }
  if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    return { ok: false, reason: 'Use localhost or 127.0.0.1. The manifest grants access to no other host.' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'Remove the username and password from the URL. Use the optional token field instead.' };
  }
  if (parsed.search || parsed.hash) {
    return { ok: false, reason: 'Remove the query string and the hash from the URL.' };
  }

  const path = parsed.pathname.replace(/\/+$/, '');
  return { ok: true, url: `${parsed.origin}${path}` };
}

const LONG_POLL_STATES: readonly LongPollState[] = [
  'disabled',
  'connecting',
  'polling',
  'degraded',
  'error',
];

const LONG_POLL_ERROR_KINDS: readonly LongPollErrorKind[] = ['transport', 'protocol', 'config'];

/** Type guard for a status value read from storage. */
export function isLongPollStatus(value: unknown): value is LongPollStatus {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (!LONG_POLL_STATES.includes(record.state as LongPollState)) return false;
  if (typeof record.updatedAt !== 'number' || !Number.isFinite(record.updatedAt)) return false;
  if (record.proxyUrl !== undefined && typeof record.proxyUrl !== 'string') return false;
  if (record.message !== undefined && typeof record.message !== 'string') return false;
  if (record.lastError !== undefined && typeof record.lastError !== 'string') return false;
  if (
    record.errorKind !== undefined &&
    !LONG_POLL_ERROR_KINDS.includes(record.errorKind as LongPollErrorKind)
  ) {
    return false;
  }
  if (record.lastAckError !== undefined && typeof record.lastAckError !== 'string') return false;
  if (!isOptionalCount(record.failureCount)) return false;
  if (!isOptionalCount(record.ackFailures)) return false;
  if (record.lastAckAt !== undefined && (typeof record.lastAckAt !== 'number' || !Number.isFinite(record.lastAckAt))) {
    return false;
  }
  if (record.pendingAcks !== undefined) {
    if (!Array.isArray(record.pendingAcks)) return false;
    if (!record.pendingAcks.every(isPendingAckSummary)) return false;
  }
  return true;
}

function isOptionalCount(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'number' && Number.isInteger(value) && value >= 0)
  );
}

function isPendingAckSummary(value: unknown): value is LongPollPendingAckSummary {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.jobId === 'string' &&
    record.jobId.length > 0 &&
    typeof record.error === 'string' &&
    typeof record.lastAttemptAt === 'number' &&
    Number.isFinite(record.lastAttemptAt)
  );
}

/** Type guard for a persisted in-flight lease. */
export function isLongPollLease(value: unknown): value is LongPollLease {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.jobId === 'string' &&
    record.jobId.length > 0 &&
    typeof record.requestDigest === 'string' &&
    record.requestDigest.length > 0 &&
    typeof record.receivedAt === 'number' &&
    Number.isFinite(record.receivedAt) &&
    record.receivedAt > 0 &&
    !('request' in record)
  );
}

/** Stable, storage-safe key for a pending result. */
export function pendingAckKey(proxyUrl: string, jobId: string): string {
  return `${proxyUrl}|${jobId}`;
}

/**
 * A short request fingerprint. Deliberately does not contain the prompt body
 * or file bytes; it is only used to ensure a redelivered job is the same job
 * that produced the stored result.
 */
export function requestDigest(request: AutomationRunRequest): string {
  const fileBytes = request.file?.byteLength ?? 0;
  const fingerprint = [
    request.providerId ?? 'gemini',
    request.targetUrl ?? '',
    request.prompt.length,
    request.prompt.slice(0, 64),
    fileBytes,
  ].join('\n');
  return `v1:${fnv1a(fingerprint).toString(16)}:${request.prompt.length}:${fileBytes}`;
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Type guard for a persisted pending-ack record. */
export function isLongPollPendingAck(value: unknown): value is LongPollPendingAck {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.proxyUrl === 'string' &&
    record.proxyUrl.length > 0 &&
    typeof record.jobId === 'string' &&
    record.jobId.length > 0 &&
    typeof record.requestDigest === 'string' &&
    record.requestDigest.length > 0 &&
    typeof record.error === 'string' &&
    typeof record.attempts === 'number' &&
    Number.isInteger(record.attempts) &&
    record.attempts >= 0 &&
    typeof record.lastAttemptAt === 'number' &&
    Number.isFinite(record.lastAttemptAt) &&
    record.lastAttemptAt > 0 &&
    isAutomationRunResponse(record.response)
  );
}

/** Type guard for the durable pending-ack map. */
export function isLongPollPendingAckMap(value: unknown): value is LongPollPendingAckMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  for (const [key, item] of Object.entries(record)) {
    if (!isLongPollPendingAck(item)) return false;
    if (pendingAckKey(item.proxyUrl, item.jobId) !== key) return false;
  }
  return true;
}

/** Validate the top-level poll envelope without dereferencing `request`. */
export function parsePollJob(value: unknown): PollJob {
  if (!isRecord(value)) throw new LongPollProtocolError('poll body is not an object');
  if (typeof value.job_id !== 'string' || value.job_id.trim().length === 0) {
    throw new LongPollProtocolError('poll body is missing a non-empty job_id');
  }
  return { job_id: value.job_id, request: value.request };
}

/** Convert an untrusted poll request into a validated AutomationRunRequest. */
export function mapPollJobToRequest(job: PollJob): AutomationRunRequest {
  if (!isRecord(job.request)) throw new Error('job request is not an object');
  const raw = job.request;
  if (typeof raw.prompt !== 'string' || raw.prompt.trim().length === 0) {
    throw new Error('job request prompt is missing');
  }

  const providerId = readProviderId(raw.provider_id);
  const timeoutMs = readTimeoutMs(raw.timeout_ms);
  const targetUrl = readOptionalString(raw.target_url, 'target_url');
  const file = readFilePayload(raw.file);

  const request: AutomationRunRequest = {
    kind: AUTOMATION_RUN_REQUEST,
    prompt: raw.prompt,
    ...(providerId ? { providerId } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(targetUrl ? { targetUrl } : {}),
    ...(file ? { file } : {}),
  };

  if (!isAutomationRunRequest(request)) {
    throw new Error('job request failed automation contract validation');
  }
  return request;
}

/** Turn a validation failure into a typed result the proxy can understand. */
export function validationErrorResponse(error: unknown): AutomationRunResponse {
  if (error instanceof AutomationErrorException) {
    return err(error.code, error.message, error.step);
  }
  return err('INVALID_PAYLOAD', error instanceof Error ? error.message : String(error));
}

function readProviderId(value: unknown): LlmProviderId | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new AutomationErrorException('INVALID_PROVIDER', 'provider_id must be a non-empty string');
  }
  if (!listProviderIds().includes(value as LlmProviderId)) {
    throw new AutomationErrorException('INVALID_PROVIDER', `Unknown provider: ${value}`);
  }
  return value as LlmProviderId;
}

function readTimeoutMs(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('timeout_ms must be a finite number');
  }
  return Math.min(MAX_REQUEST_TIMEOUT_MS, Math.max(1, Math.floor(value)));
}

function readOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function readFilePayload(value: unknown): AutomationRunRequest['file'] {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('job file is not an object');
  const { name, mime_type, data_base64, byte_length } = value;
  if (
    typeof name !== 'string' ||
    typeof mime_type !== 'string' ||
    typeof data_base64 !== 'string' ||
    typeof byte_length !== 'number'
  ) {
    throw new Error('job file fields are invalid');
  }
  const file = { name, mimeType: mime_type, dataBase64: data_base64, byteLength: byte_length };
  const verdict = validateFilePayload(file);
  if (!verdict.ok) throw new Error(`job file rejected: ${verdict.reason}`);
  return file;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Normalize a stored config value; invalid URLs disable the client. */
export function coerceLongPollConfig(value: unknown): LongPollConfig {
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_LONG_POLL_CONFIG };
  const record = value as Record<string, unknown>;
  const rawUrl = typeof record.proxyUrl === 'string' ? record.proxyUrl : '';
  const normalizedUrl = normalizeProxyUrl(rawUrl);
  const token = typeof record.token === 'string' ? record.token.trim() : '';
  const safeToken = token && !/[\r\n]/.test(token) ? token : '';
  return {
    proxyUrl: normalizedUrl.ok ? normalizedUrl.url : '',
    enabled: record.enabled === true && normalizedUrl.ok,
    ...(safeToken ? { token: safeToken } : {}),
  };
}
