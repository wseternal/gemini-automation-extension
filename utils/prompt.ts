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
 * Grace after a Send-button click to see a kickoff. A backgrounded composer can
 * swallow the synthetic click, so if nothing starts within this window the
 * Enter-key path is retried before we give up.
 */
const CLICK_KICKOFF_GRACE_MS = 2_500;

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

/** Resolve the prompt editor as an HTML element, or throw a submit error. */
async function getPromptEditor(
  root: ParentNode,
  selectors: ProviderSelectors,
  options: PromptOptions,
): Promise<HTMLElement> {
  let editor: Element;
  try {
    editor = await waitForElement(root, selectors.promptEditor, 'prompt editor', options);
  } catch (e) {
    throw toPromptError('SUBMIT_FAILED', e, 'submit');
  }
  if (!(editor instanceof HTMLElement)) {
    throw new AutomationErrorException('SUBMIT_FAILED', 'prompt editor is not an HTML element', 'submit');
  }
  return editor;
}

/** Dispatch a synthetic Enter that submits the editor on its key handler. */
function dispatchEnter(editor: HTMLElement): void {
  dispatchKeyboardEvent(editor, 'keydown', 'Enter', 'Enter', 13);
  dispatchKeyboardEvent(editor, 'keypress', 'Enter', 'Enter', 13);
  dispatchKeyboardEvent(editor, 'keyup', 'Enter', 'Enter', 13);
}

/** True once a stop indicator or response container shows generation started. */
function kickoffPresent(root: ParentNode, selectors: ProviderSelectors): boolean {
  return (
    queryFirst(root, selectors.stopButton) !== null ||
    queryFirst(root, selectors.responseContainer) !== null
  );
}

/**
 * Dispatch the submission event: send-button click when present, with an
 * Enter-key retry if the click does not start generation; Enter is the only
 * path when no usable button appears. Resolves once generation shows signs of
 * starting (stop indicator or response container); throws `SUBMIT_FAILED`
 * otherwise.
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
    // A backgrounded composer can swallow the synthetic click. Give it a short
    // grace to kick off; if nothing starts, retry through the Enter path.
    try {
      await waitForCondition(
        () => kickoffPresent(root, selectors),
        'generation kickoff',
        { timeoutMs: CLICK_KICKOFF_GRACE_MS, intervalMs: options.intervalMs ?? 100 },
      );
      return;
    } catch (error) {
      if (!(error instanceof WaitTimeoutError)) {
        throw toPromptError('SUBMIT_FAILED', error, 'submit');
      }
    }
    dispatchEnter(await getPromptEditor(root, selectors, options));
  } else {
    // No usable button: submit through the editor's Enter handler.
    dispatchEnter(await getPromptEditor(root, selectors, options));
  }

  // Confirm generation actually kicked off: a stop-generation indicator or
  // a response container must appear.
  try {
    await waitForCondition(
      () => kickoffPresent(root, selectors),
      'generation kickoff',
      { timeoutMs: options.kickoffTimeoutMs ?? 8_000, intervalMs: options.intervalMs ?? 100 },
    );
  } catch (e) {
    throw toPromptError('SUBMIT_FAILED', e, 'submit');
  }
}
