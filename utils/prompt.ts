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
function dispatchKeyboardEvent(
  editor: HTMLElement,
  type: 'keydown' | 'keyup' | 'keypress',
  key: string,
  code: string,
  keyCode: number,
): void {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, key, code });
  // KeyboardEventInit no longer carries keyCode/which; legacy handlers still read them.
  try {
    Object.defineProperty(event, 'keyCode', { value: keyCode, configurable: true });
    Object.defineProperty(event, 'which', { value: keyCode, configurable: true });
    Object.defineProperty(event, 'charCode', { value: type === 'keypress' ? keyCode : 0, configurable: true });
  } catch {
    // A locked-down event object simply falls back to key/code.
  }
  editor.dispatchEvent(event);
}

function reportKeyboardActivity(editor: HTMLElement): void {
  dispatchKeyboardEvent(editor, 'keydown', 'a', 'KeyA', 65);
  dispatchKeyboardEvent(editor, 'keyup', 'a', 'KeyA', 65);
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

function isDisabledSendButton(el: HTMLElement, selectors: ProviderSelectors): boolean {
  if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') return true;
  // The custom-element host (e.g. Gemini's `gem-icon-button`) carries the
  // disabled state even when the inner button does not expose it.
  const host = el.closest('[aria-disabled="true"]');
  if (host && host !== el) return true;
  for (const selector of selectors.sendButtonDisabled ?? []) {
    try {
      if (el.matches(selector)) return true;
    } catch {
      // Ignore a provider selector the current engine cannot parse.
    }
  }
  return false;
}

/** Return the send button only when it is present, enabled, and rendered. */
function findEnabledSendButton(root: ParentNode, selectors: ProviderSelectors): HTMLElement | null {
  const el = queryFirst(root, selectors.sendButton);
  if (!(el instanceof HTMLElement)) return null;
  if (isDisabledSendButton(el, selectors)) return null;
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
  // Wait the full budget for an enabled, rendered Send button. The button can
  // appear one tick after the fill, when the editor's framework state updates;
  // only fall back to Enter when no usable button shows in time.
  let sendButton: HTMLElement | null = null;
  try {
    sendButton = await waitForCondition(
      () => findEnabledSendButton(root, selectors),
      'enabled send button',
      { timeoutMs: SEND_BUTTON_TIMEOUT_MS, intervalMs: options.intervalMs ?? 50 },
    );
  } catch (error) {
    if (!(error instanceof WaitTimeoutError)) {
      throw toPromptError('SUBMIT_FAILED', error, 'submit');
    }
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
    if (!(editor instanceof HTMLElement)) {
      throw new AutomationErrorException('SUBMIT_FAILED', 'prompt editor is not an HTML element', 'submit');
    }
    dispatchKeyboardEvent(editor, 'keydown', 'Enter', 'Enter', 13);
    dispatchKeyboardEvent(editor, 'keypress', 'Enter', 'Enter', 13);
    dispatchKeyboardEvent(editor, 'keyup', 'Enter', 'Enter', 13);
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
