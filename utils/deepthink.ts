/**
 * utils/deepthink.ts — activate DeepThink/DeepReasoning mode for providers
 * that require it (e.g., DeepSeek).
 *
 * DeepThink mode is toggled via a button that changes its `aria-pressed`
 * state. This module finds the toggle, clicks it if not already active,
 * and verifies the state change.
 */
import { AutomationErrorException } from '../types/automation';
import type { SelectorList } from '../types/provider';
import { queryFirst, waitForCondition, WaitTimeoutError, type WaitOptions } from './dom-wait';

const DEEPTHINK_LABEL_RE = /deepthink/i;

/**
 * Check if DeepThink is currently active by examining toggle button state.
 * Returns true if a toggle button with "DeepThink" text has aria-pressed="true".
 */
export function isDeepThinkActive(root: ParentNode, toggleSelectors: SelectorList): boolean {
  const toggles = root.querySelectorAll(toggleSelectors.join(', '));
  for (const toggle of toggles) {
    const text = (toggle.textContent ?? '').trim();
    if (DEEPTHINK_LABEL_RE.test(text)) {
      return toggle.getAttribute('aria-pressed') === 'true';
    }
  }
  return false;
}

/**
 * Ensure DeepThink mode is active. Idempotent: if already active, nothing
 * is clicked. Throws `DEEP_THINK_FAILED` when the toggle is missing or
 * the state never materializes.
 */
export async function ensureDeepThink(
  root: ParentNode,
  toggleSelectors: SelectorList,
  options: WaitOptions = {},
): Promise<void> {
  if (isDeepThinkActive(root, toggleSelectors)) return;

  // Find the DeepThink toggle button
  const toggles = root.querySelectorAll(toggleSelectors.join(', '));
  let targetToggle: Element | null = null;
  for (const toggle of toggles) {
    const text = (toggle.textContent ?? '').trim();
    if (DEEPTHINK_LABEL_RE.test(text)) {
      targetToggle = toggle;
      break;
    }
  }

  if (!targetToggle) {
    throw new AutomationErrorException(
      'DEEP_THINK_FAILED',
      'Could not find DeepThink toggle button',
      'deep-think',
    );
  }

  if (!(targetToggle instanceof HTMLElement)) {
    throw new AutomationErrorException(
      'DEEP_THINK_FAILED',
      'DeepThink toggle is not an interactive element',
      'deep-think',
    );
  }

  targetToggle.click();

  try {
    await waitForCondition(
      () => (isDeepThinkActive(root, toggleSelectors) ? true : null),
      'DeepThink active state',
      { timeoutMs: options.timeoutMs ?? 5_000, intervalMs: options.intervalMs ?? 100 },
    );
  } catch (e) {
    if (e instanceof AutomationErrorException) throw e;
    const reason = e instanceof WaitTimeoutError ? e.message : e instanceof Error ? e.message : String(e);
    throw new AutomationErrorException(
      'DEEP_THINK_FAILED',
      `Could not activate DeepThink — ${reason}`,
      'deep-think',
    );
  }
}
