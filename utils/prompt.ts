/**
 * utils/prompt.ts — populate Gemini's rich-text prompt editor and dispatch
 * the submission event. Text injection is strictly DOM-safe (`textContent`,
 * never `innerHTML` with caller content — security gate 8).
 */
import { AutomationErrorException } from '../types/automation';
import { queryFirst, waitForCondition, waitForElement, WaitTimeoutError, type WaitOptions } from './dom-wait';
import { SELECTORS } from './selectors';

export interface PromptOptions extends WaitOptions {
  /** How long to wait for evidence that generation kicked off. Default 8s. */
  readonly kickoffTimeoutMs?: number;
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
export async function fillPrompt(root: ParentNode, text: string, options: PromptOptions = {}): Promise<void> {
  let editor: Element;
  try {
    editor = await waitForElement(root, SELECTORS.promptEditor, 'prompt editor', options);
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
}

/**
 * Dispatch the submission event: send-button click when present, Enter-key
 * fallback otherwise. Resolves once generation shows signs of starting
 * (stop indicator or response container); throws `SUBMIT_FAILED` otherwise.
 */
export async function submitPrompt(root: ParentNode, options: PromptOptions = {}): Promise<void> {
  const sendButton = queryFirst(root, SELECTORS.sendButton);

  if (sendButton instanceof HTMLElement) {
    sendButton.click();
  } else {
    // Enter fallback on the editor.
    let editor: Element | null;
    try {
      editor = await waitForElement(root, SELECTORS.promptEditor, 'prompt editor', options);
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
        queryFirst(root, SELECTORS.stopButton) !== null ||
        queryFirst(root, SELECTORS.responseContainer) !== null ||
        null,
      'generation kickoff',
      { timeoutMs: options.kickoffTimeoutMs ?? 8_000, intervalMs: options.intervalMs ?? 100 },
    );
  } catch (e) {
    throw toPromptError('SUBMIT_FAILED', e, 'submit');
  }
}
