/**
 * utils/temporary-chat.ts — activate Gemini's "Temporary chat" mode from the
 * top-right control bar and positively verify the state before the pipeline
 * proceeds. All failures surface as typed `TEMP_CHAT_FAILED` errors.
 */
import { AutomationErrorException } from '../types/automation';
import { queryFirst, waitForCondition, waitForElement, WaitTimeoutError, type WaitOptions } from './dom-wait';
import { SELECTORS } from './selectors';

const TEMP_CHAT_LABEL_RE = /temporary chat/i;

/**
 * True when the page shows evidence of an active Temporary Chat: either a
 * DOM marker from the selector registry, or a short heading/banner label.
 */
export function isTemporaryChatActive(root: ParentNode): boolean {
  if (queryFirst(root, SELECTORS.tempChatActiveMarker)) return true;

  // Text probe — a compact label reading "Temporary Chat" (banner/heading),
  // guarding against false positives from long paragraphs that merely
  // mention the feature.
  for (const el of root.querySelectorAll('h1, h2, h3, [role="heading"], span, div')) {
    const text = (el.textContent ?? '').trim();
    if (text.length > 0 && text.length <= 40 && TEMP_CHAT_LABEL_RE.test(text) && el.childElementCount <= 2) {
      return true;
    }
  }
  return false;
}

/**
 * Ensure the page is in Temporary Chat mode. Idempotent: if the mode is
 * already active nothing is clicked. Throws `TEMP_CHAT_FAILED` when the
 * control is missing or the state never materializes.
 */
export async function ensureTemporaryChat(root: ParentNode, options: WaitOptions = {}): Promise<void> {
  if (isTemporaryChatActive(root)) return;
  try {
    const button = await waitForElement(root, SELECTORS.tempChatButton, 'temporary chat control', options);
    if (!(button instanceof HTMLElement)) {
      throw new Error('temporary chat control is not an interactive element');
    }
    button.click();
    await waitForCondition(
      () => (isTemporaryChatActive(root) ? true : null),
      'temporary chat active state',
      options,
    );
  } catch (e) {
    if (e instanceof AutomationErrorException) throw e;
    const reason = e instanceof WaitTimeoutError ? e.message : e instanceof Error ? e.message : String(e);
    throw new AutomationErrorException('TEMP_CHAT_FAILED', `Could not activate Temporary Chat — ${reason}`, 'temporary-chat');
  }
}
