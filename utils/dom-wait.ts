/**
 * utils/dom-wait.ts — timeout-aware polling primitives shared by every
 * pipeline step. All functions are `root`-parameterized so they run against
 * any document/fragment (production: the Gemini tab; tests: fixtures).
 */

export interface WaitOptions {
  /** Total budget before a {@link WaitTimeoutError}. Default 10s. */
  readonly timeoutMs?: number;
  /** Poll interval. Default 100ms. */
  readonly intervalMs?: number;
}

export class WaitTimeoutError extends Error {
  readonly what: string;
  readonly timeoutMs: number;
  constructor(what: string, timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms waiting for: ${what}`);
    this.name = 'WaitTimeoutError';
    this.what = what;
    this.timeoutMs = timeoutMs;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll `probe` until it returns a truthy value; resolve with that value. */
export async function waitForCondition<T>(
  probe: () => T | null | false | undefined,
  what: string,
  options: WaitOptions = {},
): Promise<T> {
  const { timeoutMs = 10_000, intervalMs = 100 } = options;
  const deadline = Date.now() + timeoutMs;
  // Always probe once before sleeping so already-satisfied conditions are instant.
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() >= deadline) throw new WaitTimeoutError(what, timeoutMs);
    await sleep(intervalMs);
  }
}

/** Query `root` with each fallback selector in order; first match wins. */
export function queryFirst(root: ParentNode, selectors: readonly string[]): Element | null {
  for (const selector of selectors) {
    try {
      const el = root.querySelector(selector);
      if (el) return el;
    } catch {
      // A selector that the current engine can't parse is skipped, not fatal.
    }
  }
  return null;
}

/** Query all matches across every fallback selector (deduplicated, DOM order). */
export function queryAll(root: ParentNode, selectors: readonly string[]): Element[] {
  const seen = new Set<Element>();
  for (const selector of selectors) {
    try {
      for (const el of root.querySelectorAll(selector)) seen.add(el);
    } catch {
      // skip unparseable selector
    }
  }
  return [...seen];
}

/** Wait until any fallback selector matches under `root`. */
export function waitForElement(
  root: ParentNode,
  selectors: readonly string[],
  what: string,
  options: WaitOptions = {},
): Promise<Element> {
  return waitForCondition(() => queryFirst(root, selectors), what, options);
}
