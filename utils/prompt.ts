/**
 * utils/prompt.ts — populate the LLM prompt editor and dispatch
 * the submission event. Text injection is strictly DOM-safe (`textContent`,
 * never `innerHTML` with caller content — security gate 8).
 */
import { AutomationErrorException } from '../types/automation';
import type { ProviderSelectors } from '../types/provider';
import { queryFirst, waitForCondition, waitForElement, WaitTimeoutError, type WaitOptions } from './dom-wait';

export interface PromptOptions extends WaitOptions {
  /** How long to wait for evidence that generation kicked off. Default 8s. */
  readonly kickoffTimeoutMs?: number;
}

/** Budget for the Send button to appear and enable after a programmatic fill. */
const SEND_BUTTON_TIMEOUT_MS = 2_000;

/**
 * Notify editors that track keyboard activity. Gemini's composer shows and
 * enables its Send button from key events only. `execCommand` and DOM writes
 * fire `input` events, which Gemini ignores.
 */
function reportKeyboardActivity(editor: HTMLElement): void {
  for (const type of ['keydown', 'keyup'] as const) {
    editor.dispatchEvent(
      new KeyboardEvent(type, { bubbles: true, cancelable: true, key: 'a', code: 'KeyA', keyCode: 65 }),
    );
  }
}

function toPromptError(code: 'PROMPT_NOT_FOUND' | 'SUBMIT_FAILED', e: unknown, step: 'fill-prompt' | 'submit'): AutomationErrorException {
  const reason = e instanceof WaitTimeoutError || e instanceof Error ? e.message : String(e);
  return new AutomationErrorException(code, reason, step);
}

/**
 * Write `text` into the prompt editor. Prefers `execCommand('insertText')`
 * (keeps Quill-style editors' internal state in sync); falls back to direct
 * DOM population + `input` events when execCommand is unavailable.
 */
export async function fillPrompt(
  root: ParentNode,
  selectors: ProviderSelectors,
  text: string,
  options: PromptOptions = {},
): Promise<void> {
  let editor: Element;
  try {
    editor = await waitForElement(root, selectors.promptEditor, 'prompt editor', options);
  } catch (e) {
    throw toPromptError('PROMPT_NOT_FOUND', e, 'fill-prompt');
  }
  if (!(editor instanceof HTMLElement)) {
    throw new AutomationErrorException('PROMPT_NOT_FOUND', 'prompt editor is not an HTML element', 'fill-prompt');
  }

  editor.focus();

  // Textarea path: set value directly and dispatch framework events.
  if (editor instanceof HTMLTextAreaElement) {
    editor.value = text;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }

  let inserted = false;
  try {
    // Select existing content, then replace it with the new prompt.
    const doc = editor.ownerDocument;
    inserted =
      typeof doc.execCommand === 'function' &&
      doc.execCommand('selectAll', false) &&
      doc.execCommand('insertText', false, text) &&
      editor.textContent === text;
  } catch {
    inserted = false;
  }

  if (!inserted) {
    // DOM-safe fallback: clear and set as plain text, then notify listeners.
    editor.textContent = text;
    editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }

  reportKeyboardActivity(editor);
}

/** Return a send button that is present, enabled, and rendered. */
function findEnabledSendButton(root: ParentNode, selectors: ProviderSelectors): HTMLElement | null {
  const el = queryFirst(root, selectors.sendButton);
  if (!(el instanceof HTMLElement)) return null;
  if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') return null;
  if (el.getClientRects().length === 0) return null;
  return el;
}

/**
 * Dispatch the submission event: send-button click when present, Enter-key
 * fallback otherwise. Resolves once generation shows signs of starting
 * (stop indicator or response container); throws `SUBMIT_FAILED` otherwise.
 */
export async function submitPrompt(
  root: ParentNode,
  selectors: ProviderSelectors,
  options: PromptOptions = {},
): Promise<void> {
  // The Send button can appear one tick after the fill, when the editor's
  // framework state updates. Wait for it before falling back to Enter.
  let sendButton: HTMLElement | null = null;
  try {
    sendButton = await waitForCondition(
      () => findEnabledSendButton(root, selectors),
      'send button',
      { timeoutMs: SEND_BUTTON_TIMEOUT_MS, intervalMs: options.intervalMs ?? 50 },
    );
  } catch {
    sendButton = null;
  }

  if (sendButton) {
    sendButton.click();
  } else {
    // Enter fallback on the editor.
    let editor: Element | null;
    try {
      editor = await waitForElement(root, selectors.promptEditor, 'prompt editor', options);
    } catch (e) {
      throw toPromptError('SUBMIT_FAILED', e, 'submit');
    }
    for (const type of ['keydown', 'keypress', 'keyup'] as const) {
      editor.dispatchEvent(
        new KeyboardEvent(type, { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13 }),
      );
    }
  }

  // Confirm generation actually kicked off: a stop-generation indicator or
  // a response container must appear.
  try {
    await waitForCondition(
      () =>
        queryFirst(root, selectors.stopButton) !== null ||
        queryFirst(root, selectors.responseContainer) !== null ||
        null,
      'generation kickoff',
      { timeoutMs: options.kickoffTimeoutMs ?? 8_000, intervalMs: options.intervalMs ?? 100 },
    );
  } catch (e) {
    throw toPromptError('SUBMIT_FAILED', e, 'submit');
  }
}
