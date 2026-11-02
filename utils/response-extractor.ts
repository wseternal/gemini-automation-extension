/**
 * utils/response-extractor.ts — streaming-aware capture of LLM responses.
 *
 * Resolution rule: the extractor resolves ONLY when
 *   1. the stop-generation indicator is absent, AND
 *   2. the rendered response text has been stable across `stabilityPolls`
 *      consecutive polls.
 * A bounded timeout produces a typed `STREAM_TIMEOUT`; no early or hanging
 * resolutions.
 */
import { AutomationErrorException, DEFAULT_STREAM_TIMEOUT_MS } from '../types/automation';
import type { ProviderSelectors } from '../types/provider';
import { convertDomToMarkdown } from './dom-to-markdown';
import { queryAll, queryFirst, sleep, type WaitOptions } from './dom-wait';

export interface ExtractionOptions extends WaitOptions {
  /** Overall streaming budget. Default {@link DEFAULT_STREAM_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Wait for the response container to first appear. Default 60s. */
  readonly kickoffTimeoutMs?: number;
  /** Consecutive identical snapshots required before resolving. Default 2. */
  readonly stabilityPolls?: number;
  /** Whether to use SVG-based stop detection (DeepSeek). Default false. */
  readonly svgStopDetection?: boolean;
}

export interface ExtractionResult {
  readonly text: string;
  /** Markdown representation of the response (structured content). */
  readonly markdown: string;
  /** True when the stop-generation indicator was observed at least once. */
  readonly streamingDetected: boolean;
}

/** Text of the most recent response container (empty string when none). */
export function latestResponseText(root: ParentNode, selectors: ProviderSelectors): string {
  const containers = queryAll(root, selectors.responseContainer);
  const latest = containers[containers.length - 1];
  return latest?.textContent?.trim() ?? '';
}

/** Latest response container element (or null). */
function latestResponseContainer(root: ParentNode, selectors: ProviderSelectors): Element | null {
  const containers = queryAll(root, selectors.responseContainer);
  return containers[containers.length - 1] ?? null;
}

/**
 * Check if streaming is active. For providers with SVG-based stop detection
 * (DeepSeek), checks the SVG path attribute. Otherwise uses selector-based
 * stop button detection.
 */
export function isStreaming(root: ParentNode, selectors: ProviderSelectors, svgStopDetection = false): boolean {
  if (svgStopDetection) {
    // DeepSeek: same button for send/stop, SVG path changes
    const button = queryFirst(root, selectors.sendButton);
    if (!button) return false;
    const svgPath = button.querySelector('svg path');
    if (!svgPath) return false;
    const d = svgPath.getAttribute('d') ?? '';
    // Square icon = stop (streaming active)
    return d.startsWith('M2 4.88') || d.startsWith('M2 4.8');
  }
  return queryFirst(root, selectors.stopButton) !== null;
}

export async function extractResponse(
  root: ParentNode,
  selectors: ProviderSelectors,
  options: ExtractionOptions = {},
): Promise<ExtractionResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? 250;
  const stabilityPolls = options.stabilityPolls ?? 2;
  const kickoffTimeoutMs = options.kickoffTimeoutMs ?? 60_000;
  const svgStopDetection = options.svgStopDetection ?? false;

  // Wait for the response container to appear at all.
  const deadline = Date.now() + timeoutMs;
  const kickoffDeadline = Date.now() + kickoffTimeoutMs;
  let containerSeen = false;
  let streamingDetected = false;
  let lastText = '';
  let stableCount = 0;
  let cachedContainer: Element | null = null;

  for (;;) {
    // Cache the container element and re-query only when disconnected.
    if (!cachedContainer || !cachedContainer.isConnected) {
      cachedContainer = latestResponseContainer(root, selectors);
    }

    const text = cachedContainer?.textContent?.trim() ?? '';
    const streaming = isStreaming(root, selectors, svgStopDetection);

    if (text.length > 0) containerSeen = true;
    if (streaming) streamingDetected = true;

    // S8: If the container was seen but text disappears, the container was
    // removed mid-stream — return the last captured text rather than timing out.
    if (containerSeen && !streaming && text.length === 0 && lastText.length > 0) {
      const markdown = lastText; // No DOM element to convert — use plain text.
      return { text: lastText, markdown, streamingDetected };
    }

    if (containerSeen && !streaming && text.length > 0) {
      stableCount = text === lastText ? stableCount + 1 : 1;
      if (stableCount >= stabilityPolls) {
        const markdown = cachedContainer ? convertDomToMarkdown(cachedContainer) : text;
        return { text, markdown, streamingDetected };
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
