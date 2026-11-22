/**
 * utils/long-poll-client.ts — HTTP long-polling client that connects to
 * the AI automation proxy server. Receives automation jobs, dispatches
 * them through the existing pipeline, and returns results.
 *
 * The client runs as a background loop inside the service worker. It
 * reconnects with exponential backoff on network errors. Settings live in
 * utils/long-poll-config.ts.
 */

import type { AutomationRunRequest, AutomationRunResponse } from '../types/automation';
import { AUTOMATION_RUN_REQUEST, AUTOMATION_RUN_RESPONSE } from '../types/automation';
import type { LongPollConfig } from './long-poll-config';

const DEFAULT_POLL_TIMEOUT_S = 30;
const MAX_BACKOFF_MS = 30_000;

/** A pending job received from the proxy server. */
interface PollJob {
  job_id: string;
  request: {
    prompt: string;
    file?: {
      name: string;
      mime_type: string;
      data_base64: string;
      byte_length: number;
    };
    provider_id?: string;
    timeout_ms?: number;
    target_url?: string;
  };
}

/** Dispatch function type — provided by background.ts. */
type DispatchFn = (request: AutomationRunRequest) => Promise<AutomationRunResponse>;

/** Observer for the loop health. Fires when the loop starts or fails. */
interface LongPollHooks {
  onState?: (state: 'polling' | 'error', message?: string) => void;
}

/**
 * Start the long-polling client. Returns a controller with a stop() method.
 * The client runs until stop() is called or the service worker suspends.
 */
export function startLongPollClient(
  config: LongPollConfig,
  dispatch: DispatchFn,
  hooks: LongPollHooks = {},
): { stop: () => void } {
  let running = true;
  let backoffMs = 1_000;
  let pollAbort: AbortController | undefined;

  const report = (state: 'polling' | 'error', message?: string): void => {
    hooks.onState?.(state, message);
  };

  const loop = async () => {
    report('polling');
    while (running) {
      try {
        pollAbort = new AbortController();
        const job = await pollForJob(config.proxyUrl, pollAbort.signal);
        if (!running) break;
        if (job) {
          await handleJob(config.proxyUrl, job, dispatch);
          // Reset backoff on successful job processing.
          backoffMs = 1_000;
        }
        // 204 No Content — no job available, immediately re-poll.
        report('polling');
      } catch (error) {
        if (!running) break;
        console.error('[long-poll] error:', error);
        report('error', error instanceof Error ? error.message : String(error));
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      }
    }
  };

  loop();

  return {
    stop: () => {
      running = false;
      // Abort the in-flight poll so a restart does not leave a second
      // request that could take a job and drop it.
      pollAbort?.abort();
    },
  };
}

/** Poll the server for a pending job. Returns null on 204 No Content. */
async function pollForJob(proxyUrl: string, outer?: AbortSignal): Promise<PollJob | null> {
  const controller = new AbortController();
  // Abort after timeout + 10s margin to prevent dangling requests.
  const timeoutId = setTimeout(
    () => controller.abort(),
    (DEFAULT_POLL_TIMEOUT_S + 10) * 1_000,
  );
  const abort = () => controller.abort();
  outer?.addEventListener('abort', abort, { once: true });

  try {
    const resp = await fetch(
      `${proxyUrl}/poll?timeout=${DEFAULT_POLL_TIMEOUT_S}`,
      { signal: controller.signal },
    );
    if (resp.status === 204) return null;
    if (!resp.ok) {
      throw new Error(`poll failed: ${resp.status} ${resp.statusText}`);
    }
    return (await resp.json()) as PollJob;
  } finally {
    clearTimeout(timeoutId);
    outer?.removeEventListener('abort', abort);
  }
}

/** Convert a poll job request into an AutomationRunRequest and dispatch it. */
async function handleJob(
  proxyUrl: string,
  job: PollJob,
  dispatch: DispatchFn,
): Promise<void> {
  const req: AutomationRunRequest = {
    kind: AUTOMATION_RUN_REQUEST,
    prompt: job.request.prompt,
    ...(job.request.provider_id ? { providerId: job.request.provider_id as any } : {}),
    ...(job.request.timeout_ms ? { timeoutMs: job.request.timeout_ms } : {}),
    ...(job.request.target_url ? { targetUrl: job.request.target_url } : {}),
    ...(job.request.file
      ? {
          file: {
            name: job.request.file.name,
            mimeType: job.request.file.mime_type,
            dataBase64: job.request.file.data_base64,
            byteLength: job.request.file.byte_length,
          },
        }
      : {}),
  };

  let response: AutomationRunResponse;
  try {
    response = await dispatch(req);
  } catch (error) {
    response = {
      kind: AUTOMATION_RUN_RESPONSE,
      status: 'error',
      error: {
        code: 'INTERNAL',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }

  // Post the result back to the proxy server.
  try {
    const resp = await fetch(`${proxyUrl}/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: job.job_id, result: response }),
    });
    if (!resp.ok) {
      console.error(`[long-poll] result POST failed: ${resp.status}`);
    }
  } catch (error) {
    console.error('[long-poll] result POST error:', error);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
