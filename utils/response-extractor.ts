/**
 * utils/response-extractor.ts — streaming-aware capture of Gemini's response.
 *
 * Resolution rule (gate 5): the extractor resolves ONLY when
 *   1. the stop-generation indicator is absent, AND
 *   2. the rendered response text has been stable across `stabilityPolls`
 *      consecutive polls.
 * A bounded timeout produces a typed `STREAM_TIMEOUT`; no early or hanging
 * resolutions.
 */
import { AutomationErrorException, DEFAULT_STREAM_TIMEOUT_MS } from '../types/automation';
import { queryAll, queryFirst, sleep, type WaitOptions } from './dom-wait';
import { SELECTORS } from './selectors';

export interface ExtractionOptions extends WaitOptions {
  /** Overall streaming budget. Default {@link DEFAULT_STREAM_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Wait for the response container to first appear. Default 15s. */
  readonly kickoffTimeoutMs?: number;
  /** Consecutive identical snapshots required before resolving. Default 2. */
  readonly stabilityPolls?: number;
}

export interface ExtractionResult {
  readonly text: string;
  /** True when the stop-generation indicator was observed at least once. */
  readonly streamingDetected: boolean;
}

/** Text of the most recent response container (empty string when none). */
export function latestResponseText(root: ParentNode): string {
  const containers = queryAll(root, SELECTORS.responseContainer);
  const latest = containers[containers.length - 1];
  return latest?.textContent?.trim() ?? '';
}

export function isStreaming(root: ParentNode): boolean {
  return queryFirst(root, SELECTORS.stopButton) !== null;
}

export async function extractResponse(root: ParentNode, options: ExtractionOptions = {}): Promise<ExtractionResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? 250;
  const stabilityPolls = options.stabilityPolls ?? 2;
  const kickoffTimeoutMs = options.kickoffTimeoutMs ?? 15_000;

  // Wait for the response container to appear at all.
  const deadline = Date.now() + timeoutMs;
  const kickoffDeadline = Date.now() + kickoffTimeoutMs;
  let containerSeen = false;
  let streamingDetected = false;
  let lastText = '';
  let stableCount = 0;

  for (;;) {
    const text = latestResponseText(root);
    const streaming = isStreaming(root);

    if (text.length > 0) containerSeen = true;
    if (streaming) streamingDetected = true;

    if (containerSeen && !streaming && text.length > 0) {
      stableCount = text === lastText ? stableCount + 1 : 1;
      if (stableCount >= stabilityPolls) {
        return { text, streamingDetected };
      }
    } else {
      stableCount = 0;
    }
    lastText = text;

    if (!containerSeen && Date.now() >= kickoffDeadline) {
      throw new AutomationErrorException(
        'EXTRACTION_FAILED',
        `No response appeared within ${kickoffTimeoutMs}ms of submission`,
        'extract',
      );
    }
    if (Date.now() >= deadline) {
      throw new AutomationErrorException(
        'STREAM_TIMEOUT',
        `Response streaming did not finish within ${timeoutMs}ms`,
        'extract',
      );
    }
    await sleep(intervalMs);
  }
}
