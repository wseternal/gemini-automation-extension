/**
 * utils/long-poll-client.ts — HTTP long-polling client that connects to
 * the AI automation proxy server. Receives automation jobs, validates and
 * dispatches them through the existing pipeline, and acknowledges results.
 *
 * The client runs as a background loop inside the service worker. It
 * reconnects with exponential backoff on network errors. Settings live in
 * long-poll-config.ts; pure wire shapes and mapping live in
 * long-poll-protocol.ts.
 */

import {
  err,
  isAutomationRunResponse,
  type AutomationRunRequest,
  type AutomationRunResponse,
} from '../types/automation';
import {
  LONG_POLL_ACK_RETRY_WINDOW_MS,
  LONG_POLL_REQUEST_HEARTBEAT_MS,
  LongPollProtocolError,
  mapPollJobToRequest,
  parsePollJob,
  requestDigest,
  validationErrorResponse,
  type LongPollConfig,
  type LongPollPendingAck,
  type LongPollPendingAckSummary,
  type LongPollStatus,
  type PollJob,
} from './long-poll-protocol';
import { sleep } from './dom-wait';

const DEFAULT_POLL_TIMEOUT_S = 30;
const POLL_TRANSPORT_MARGIN_MS = 10_000;
const IDLE_POLL_DELAY_MS = 500;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const RESULT_POST_TIMEOUT_MS = 8_000;
const RESULT_RETRY_DELAYS_MS = [500, 1_500] as const;
const AUTH_HEADER = 'X-Bridge-Token';

/** Dispatch function type — provided by background.ts. */
export type DispatchFn = (
  request: AutomationRunRequest,
  jobId: string,
) => Promise<AutomationRunResponse>;

export type LongPollClientState = Exclude<LongPollStatus['state'], 'disabled'>;

/** Runtime status fields the client owns; background.ts adds proxyUrl/updatedAt. */
export type LongPollClientStatus = Omit<
  LongPollStatus,
  'state' | 'proxyUrl' | 'updatedAt'
> & {
  readonly state: LongPollClientState;
};

/** Result of a job after dispatch and acknowledgement. */
export interface LongPollJobOutcome {
  readonly jobId: string;
  readonly response: AutomationRunResponse;
  readonly ackOk: boolean;
  readonly ackError?: string;
  /** False when the proxy explicitly rejected the result; true for transport/5xx. */
  readonly ackRetryable?: boolean;
  readonly requestDigest?: string;
}

/** A validated result produced before the worker attempts to POST it. */
export interface LongPollResultReady {
  readonly jobId: string;
  readonly request: AutomationRunRequest;
  readonly response: AutomationRunResponse;
}

/** A job whose request failed mapping, so no automation was dispatched. */
export interface LongPollJobRejection {
  readonly jobId: string;
  readonly code: string;
  readonly message: string;
}

/** Observer hooks. All hooks are optional and failures are isolated. */
export interface LongPollHooks {
  onStatus?: (status: LongPollClientStatus) => void;
  onJobReceived?: (job: PollJob, digest: string) => void | Promise<void>;
  onResultReady?: (ready: LongPollResultReady) => void | Promise<void>;
  onResultDelivered?: (jobId: string) => void | Promise<void>;
  onJobRejected?: (rejection: LongPollJobRejection) => void | Promise<void>;
  onJobFinished?: (outcome: LongPollJobOutcome) => void | Promise<void>;
  onAckFailure?: (outcome: LongPollJobOutcome) => void | Promise<void>;
  /** Called when a retryable pending result ages out of its reuse window. */
  onPendingAckExpired?: (jobId: string) => void | Promise<void>;
  /** Called if the loop itself exits unexpectedly. */
  onExit?: (error: unknown) => void;
}

/**
 * Start the long-polling client. Returns a controller whose stop() resolves
 * only after an in-flight job has finished dispatching and acknowledging.
 */
export function startLongPollClient(
  config: LongPollConfig,
  dispatch: DispatchFn,
  hooks: LongPollHooks = {},
  pendingAcks: readonly LongPollPendingAck[] = [],
): { stop: () => Promise<void>; clearPendingAcks: () => Promise<number> } {
  let running = true;
  let connected = false;
  let backoffMs = INITIAL_BACKOFF_MS;
  let pollAbort: AbortController | undefined;
  let activeJob: Promise<LongPollJobOutcome> | undefined;
  let failureCount = 0;
  let lastError: string | undefined;
  let lastErrorKind: LongPollStatus['errorKind'];
  let lastAckAt: number | undefined;

  const pending = new Map<string, LongPollPendingAckSummary>();
  for (const record of pendingAcks) {
    if (Date.now() - record.lastAttemptAt > LONG_POLL_ACK_RETRY_WINDOW_MS) continue;
    pending.set(record.jobId, {
      jobId: record.jobId,
      error: record.error,
      lastAttemptAt: record.lastAttemptAt,
    });
  }
  const sortedPending = (): LongPollPendingAckSummary[] =>
    Array.from(pending.values()).sort((a, b) => b.lastAttemptAt - a.lastAttemptAt);

  let ackFailures = pending.size;
  let lastAckError = latestPendingAckError();

  function latestPendingAckError(): string | undefined {
    return sortedPending()[0]?.error;
  }

  const refreshAckCounters = (): void => {
    ackFailures = pending.size;
    lastAckError = latestPendingAckError();
  };

  const emit = (state: LongPollClientState, message?: string): void => {
    const summaries = sortedPending();
    const status: LongPollClientStatus = {
      state,
      ...(message ? { message } : {}),
      ...(lastError ? { lastError } : {}),
      ...(lastErrorKind ? { errorKind: lastErrorKind } : {}),
      ...(failureCount > 0 ? { failureCount } : {}),
      ...(lastAckError ? { lastAckError } : {}),
      ...(ackFailures > 0 ? { ackFailures } : {}),
      ...(lastAckAt ? { lastAckAt } : {}),
      ...(summaries.length > 0 ? { pendingAcks: summaries } : {}),
    };
    try {
      hooks.onStatus?.(status);
    } catch (error) {
      console.warn('[long-poll] status hook failed:', error);
    }
  };

  const emitCurrent = (message?: string): void => {
    if (failureCount > 0) {
      emit('error', message ?? lastError);
    } else if (ackFailures > 0) {
      emit('degraded', message ?? `Result delivery failed: ${lastAckError ?? 'unknown error'}`);
    } else {
      emit(connected ? 'polling' : 'connecting', message);
    }
  };

  const markAckSuccess = (jobId: string): void => {
    pending.delete(jobId);
    refreshAckCounters();
    lastAckAt = Date.now();
  };

  const expirePendingAcks = (): void => {
    const now = Date.now();
    const expired: string[] = [];
    for (const [jobId, summary] of pending) {
      if (now - summary.lastAttemptAt <= LONG_POLL_ACK_RETRY_WINDOW_MS) continue;
      pending.delete(jobId);
      expired.push(jobId);
    }
    if (expired.length === 0) return;
    refreshAckCounters();
    for (const jobId of expired) {
      void Promise.resolve()
        .then(() => hooks.onPendingAckExpired?.(jobId))
        .catch((error) => console.warn('[long-poll] pending-ack expiry hook failed:', error));
    }
    emitCurrent();
  };

  const markAckFailure = (outcome: LongPollJobOutcome): void => {
    const error = outcome.ackError ?? 'unknown result delivery error';
    if (outcome.ackRetryable === false) {
      // A terminal 4xx means the proxy has decided this result is invalid or
      // already known. Retrying forever would leave a permanent amber dot.
      pending.delete(outcome.jobId);
      refreshAckCounters();
      lastAckError = error;
      emit('degraded', `Result rejected: ${error}`);
      return;
    }

    pending.set(outcome.jobId, {
      jobId: outcome.jobId,
      error,
      lastAttemptAt: Date.now(),
    });
    refreshAckCounters();
    lastAckError = error;
    emitCurrent(`Result delivery failed: ${error}`);
  };

  const loop = async (): Promise<void> => {
    emit('connecting', 'Connecting to the proxy.');
    while (running) {
      try {
        pollAbort = new AbortController();
        const job = await pollForJob(config, pollAbort.signal);
        if (!running) break;

        // Any successful poll (including 204) proves the transport is healthy.
        connected = true;
        failureCount = 0;
        lastError = undefined;
        lastErrorKind = undefined;
        backoffMs = INITIAL_BACKOFF_MS;
        emitCurrent(ackFailures > 0 ? 'Result delivery failed; proxy redelivery is required.' : undefined);

        if (!job) {
          await sleep(IDLE_POLL_DELAY_MS);
          continue;
        }

        const jobPromise = handleJob(config, job, dispatch, hooks);
        activeJob = jobPromise;
        let outcome: LongPollJobOutcome;
        try {
          outcome = await jobPromise;
        } finally {
          activeJob = undefined;
        }
        if (!running) break;

        if (outcome.ackOk) {
          markAckSuccess(outcome.jobId);
          emitCurrent();
        } else {
          markAckFailure(outcome);
        }
      } catch (error) {
        if (!running) break;
        const kind: LongPollStatus['errorKind'] =
          error instanceof LongPollProtocolError ? 'protocol' : 'transport';
        const message = error instanceof Error ? error.message : String(error);
        console.error('[long-poll] error:', error);
        failureCount += 1;
        lastError = message;
        lastErrorKind = kind;
        emit('error', message);
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      }
    }
  };

  // A long stream can outlive the UI's stale threshold while the loop is
  // healthy and awaiting dispatch. Heartbeats keep status.updatedAt fresh;
  // a dead worker stops heartbeating and the lease is never treated as proof.
  const heartbeat = setInterval(() => {
    if (!running) return;
    expirePendingAcks();
    emitCurrent();
  }, LONG_POLL_REQUEST_HEARTBEAT_MS);

  void loop().catch((error) => {
    console.error('[long-poll] loop crashed:', error);
    if (!running) return;
    running = false;
    clearInterval(heartbeat);
    failureCount += 1;
    lastError = error instanceof Error ? error.message : String(error);
    lastErrorKind = 'transport';
    emit('error', lastError);
    try {
      hooks.onExit?.(error);
    } catch (hookError) {
      console.warn('[long-poll] exit hook failed:', hookError);
    }
  });

  return {
    stop: async () => {
      running = false;
      clearInterval(heartbeat);
      pollAbort?.abort();
      const inFlight = activeJob;
      if (inFlight) await inFlight.catch(() => undefined);
    },
    clearPendingAcks: async (): Promise<number> => {
      const jobIds = Array.from(pending.keys());
      for (const jobId of jobIds) pending.delete(jobId);
      refreshAckCounters();
      emitCurrent();
      const hook = hooks.onPendingAckExpired;
      if (hook) {
        await Promise.all(
          jobIds.map((jobId) =>
            Promise.resolve()
              .then(() => hook(jobId))
              .catch((error) => console.warn('[long-poll] pending-ack clear hook failed:', error)),
          ),
        );
      }
      return jobIds.length;
    },
  };
}

/** Poll the server for a pending job. Returns null on 204 No Content. */
async function pollForJob(config: LongPollConfig, outer?: AbortSignal): Promise<PollJob | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    (DEFAULT_POLL_TIMEOUT_S * 1_000) + POLL_TRANSPORT_MARGIN_MS,
  );
  const abort = () => controller.abort();
  if (outer?.aborted) {
    controller.abort();
  } else {
    outer?.addEventListener('abort', abort, { once: true });
  }

  try {
    const resp = await fetch(
      `${config.proxyUrl}/poll?timeout=${DEFAULT_POLL_TIMEOUT_S}`,
      { signal: controller.signal, headers: authHeaders(config.token), redirect: 'error' },
    );
    if (resp.status === 204) return null;
    if (!resp.ok) {
      throw new Error(`poll failed: ${resp.status} ${resp.statusText}`);
    }
    let body: unknown;
    try {
      body = await resp.json();
    } catch {
      throw new LongPollProtocolError('poll body is not valid JSON');
    }
    return parsePollJob(body);
  } finally {
    clearTimeout(timeoutId);
    outer?.removeEventListener('abort', abort);
  }
}

/** Dispatch one job, always attempting to acknowledge it. */
async function handleJob(
  config: LongPollConfig,
  job: PollJob,
  dispatch: DispatchFn,
  hooks: LongPollHooks,
): Promise<LongPollJobOutcome> {
  console.info('[long-poll] job received', { jobId: job.job_id });

  let request: AutomationRunRequest | undefined;
  let digest: string | undefined;
  let rejection: AutomationRunResponse | undefined;

  try {
    request = mapPollJobToRequest(job);
    digest = requestDigest(request);
  } catch (error) {
    rejection = validationErrorResponse(error);
    console.warn('[long-poll] rejected job payload', {
      jobId: job.job_id,
      error: rejection.status === 'error' ? rejection.error.message : 'unknown validation error',
    });
    if (rejection.status === 'error') {
      try {
        await hooks.onJobRejected?.({
          jobId: job.job_id,
          code: rejection.error.code,
          message: rejection.error.message,
        });
      } catch (hookError) {
        console.warn('[long-poll] rejection hook failed:', hookError);
      }
    }
  }

  if (request && digest) {
    try {
      await hooks.onJobReceived?.(job, digest);
    } catch (error) {
      console.warn('[long-poll] lease hook failed:', error);
    }

    try {
      console.info('[long-poll] dispatching job', {
        jobId: job.job_id,
        providerId: request.providerId ?? 'gemini',
      });
      rejection = await dispatch(request, job.job_id);
      if (!isAutomationRunResponse(rejection)) {
        rejection = err('INTERNAL', 'dispatch returned an unrecognized response shape');
      }
    } catch (error) {
      rejection = err('INTERNAL', error instanceof Error ? error.message : String(error));
    }
  }

  const finalResponse = rejection ?? err('INTERNAL', 'job produced no response');

  // Persist the result before the POST so a worker crash mid-ack can reuse it.
  if (request) {
    try {
      await hooks.onResultReady?.({
        jobId: job.job_id,
        request,
        response: finalResponse,
      });
    } catch (error) {
      console.warn('[long-poll] result-ready hook failed:', error);
    }
  }

  const ack = await postResult(config, job.job_id, finalResponse);
  const outcome: LongPollJobOutcome = {
    jobId: job.job_id,
    response: finalResponse,
    ackOk: ack.ok,
    ...(ack.ok ? {} : { ackError: ack.error, ackRetryable: ack.retryable }),
    ...(digest ? { requestDigest: digest } : {}),
  };

  if (ack.ok) {
    try {
      await hooks.onResultDelivered?.(job.job_id);
    } catch (error) {
      console.warn('[long-poll] result-delivered hook failed:', error);
    }
  }

  try {
    await hooks.onJobFinished?.(outcome);
  } catch (error) {
    console.warn('[long-poll] job-finished hook failed:', error);
  }

  if (ack.ok) {
    console.info('[long-poll] result acknowledged', { jobId: job.job_id });
  } else {
    console.error('[long-poll] result delivery failed', { jobId: job.job_id, error: ack.error });
    try {
      await hooks.onAckFailure?.(outcome);
    } catch (error) {
      console.warn('[long-poll] ack-failure hook failed:', error);
    }
  }

  return outcome;
}

/** POST the result with a timeout and bounded retries for transient failures. */
async function postResult(
  config: LongPollConfig,
  jobId: string,
  response: AutomationRunResponse,
): Promise<{ ok: true } | { ok: false; error: string; retryable: boolean }> {
  const body = JSON.stringify({ job_id: jobId, result: response });
  let lastError = 'result POST failed';

  for (let attempt = 0; attempt <= RESULT_RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) await sleep(RESULT_RETRY_DELAYS_MS[attempt - 1]);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), RESULT_POST_TIMEOUT_MS);
    try {
      const resp = await fetch(`${config.proxyUrl}/result`, {
        method: 'POST',
        headers: {
          ...authHeaders(config.token),
          'Content-Type': 'application/json',
        },
        body,
        signal: controller.signal,
        redirect: 'error',
      });
      if (resp.ok) return { ok: true };

      lastError = `result POST failed: ${resp.status} ${resp.statusText}`;
      if (!isRetryableStatus(resp.status)) {
        return { ok: false, error: lastError, retryable: false };
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  return { ok: false, error: lastError, retryable: true };
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function authHeaders(token?: string): Record<string, string> {
  if (!token || /[\r\n]/.test(token)) return {};
  return { [AUTH_HEADER]: token };
}
