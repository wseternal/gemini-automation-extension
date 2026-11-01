/**
 * utils/file-attachment.ts — ingest a file payload into Gemini's prompt bar.
 *
 * The content script runs in Chrome's **isolated world**, where synthetic
 * DataTransfer objects don't properly cross to the page's main-world
 * JavaScript context. Gemini's Angular drop-zone handler receives an empty
 * or inaccessible `dataTransfer.files`, so the upload silently fails.
 *
 * Solution: delegate file upload to a **main-world content script**
 * (upload.world.ts) that runs in the page's JS context. Communication
 * happens via `window.postMessage`:
 *   1. This module posts a `gemini-bridge/upload` message with file data
 *   2. The main-world script performs the upload using native DataTransfer
 *   3. It responds with `gemini-bridge/upload-result`
 *   4. We wait for Gemini to register the attachment (chip/preview visible)
 *
 * Fallback: isolated-world drop event dispatch (may work in some browsers
 * where the cross-world DataTransfer boundary is less strict).
 */
import { AutomationErrorException, validateFilePayload, type FilePayload } from '../types/automation';
import { queryFirst, sleep, waitForCondition, type WaitOptions } from './dom-wait';
import { SELECTORS } from './selectors';

export interface AttachOptions extends WaitOptions {
  /** Budget for the registration confirmation wait. Default 15s. */
  readonly registrationTimeoutMs?: number;
}

const LOG_PREFIX = '[GeminiBridge:attach]';

function log(...args: unknown[]): void {
  console.log(LOG_PREFIX, ...args);
}

function logWarn(...args: unknown[]): void {
  console.warn(LOG_PREFIX, ...args);
}

/** Materialize a validated payload into a `File`. Typed rejection otherwise. */
export function decodeFilePayload(payload: FilePayload): File {
  const verdict = validateFilePayload(payload);
  if (!verdict.ok) {
    throw new AutomationErrorException('INVALID_PAYLOAD', `File payload rejected: ${verdict.reason}`, 'attach-file');
  }
  const binary = atob(payload.dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], payload.name, { type: payload.mimeType });
}

/** Build a DataTransfer carrying exactly one file. */
export function createFileDataTransfer(file: File): DataTransfer {
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);
  return dataTransfer;
}

/** A drag/drop event carrying `dataTransfer`, with a plain-Event fallback. */
export function createTransferEvent(type: 'dragenter' | 'dragover' | 'drop', dataTransfer: DataTransfer): Event {
  let event: Event;
  try {
    event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer });
  } catch {
    event = new Event(type, { bubbles: true, cancelable: true });
  }
  // Some engines construct DragEvent but ignore the dataTransfer init key.
  if ((event as DragEvent).dataTransfer == null) {
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
  }
  return event;
}

/** Dispatch the full native drop sequence on `target` with realistic timing. */
export async function dispatchDropSequence(target: Element, dataTransfer: DataTransfer): Promise<void> {
  dataTransfer.dropEffect = 'copy';
  const types = ['dragenter', 'dragover', 'drop'] as const;
  for (const type of types) {
    target.dispatchEvent(createTransferEvent(type, dataTransfer));
    if (type !== 'drop') await sleep(50);
  }
}

/** Push the files into the hidden input and notify its listeners. */
export function populateFileInput(input: HTMLInputElement, dataTransfer: DataTransfer): void {
  try {
    input.files = dataTransfer.files;
  } catch {
    Object.defineProperty(input, 'files', { value: dataTransfer.files, configurable: true });
  }
  input.dispatchEvent(new Event('focus', { bubbles: true }));
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  try {
    const dropEvent = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer });
    if (dropEvent.dataTransfer == null) {
      Object.defineProperty(dropEvent, 'dataTransfer', { value: dataTransfer });
    }
    input.dispatchEvent(dropEvent);
  } catch {
    // DragEvent constructor unavailable — input/change events already dispatched.
  }
  input.dispatchEvent(new Event('blur', { bubbles: true }));
}

/** Probe: has Gemini registered an attachment (chip/preview visible)? */
export function isAttachmentRegistered(root: ParentNode): boolean {
  return queryFirst(root, SELECTORS.attachmentChip) !== null;
}

function toAttachError(e: unknown): AutomationErrorException {
  if (e instanceof AutomationErrorException) return e;
  return new AutomationErrorException('ATTACH_FAILED', e instanceof Error ? e.message : String(e), 'attach-file');
}

// ---------------------------------------------------------------------------
// Main-world bridge via window.postMessage
// ---------------------------------------------------------------------------

interface UploadRequest {
  type: 'gemini-bridge/upload';
  id: string;
  dataBase64: string;
  name: string;
  mimeType: string;
}

interface UploadResult {
  type: 'gemini-bridge/upload-result';
  id: string;
  ok: boolean;
  error?: string;
}

/**
 * Request the main-world content script to perform the file upload.
 * Returns the result from the main world, or times out.
 */
function requestMainWorldUpload(payload: FilePayload, timeoutMs: number): Promise<{ ok: boolean; error?: string }> {
  const id = `upload_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  return new Promise((resolve) => {
    const handler = (event: MessageEvent) => {
      // Only accept messages from the same window.
      if (event.source !== window) return;

      const data = event.data as UploadResult | undefined;
      if (
        data?.type === 'gemini-bridge/upload-result' &&
        data.id === id
      ) {
        window.removeEventListener('message', handler);
        clearTimeout(timer);
        resolve({ ok: data.ok, error: data.error });
      }
    };

    const timer = setTimeout(() => {
      window.removeEventListener('message', handler);
      resolve({ ok: false, error: 'main-world upload request timed out' });
    }, timeoutMs);

    window.addEventListener('message', handler);

    const request: UploadRequest = {
      type: 'gemini-bridge/upload',
      id,
      dataBase64: payload.dataBase64,
      name: payload.name,
      mimeType: payload.mimeType,
    };

    window.postMessage(request, '*');
  });
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Attach `payload` and resolve only after Gemini confirms registration.
 * Throws `INVALID_PAYLOAD`, `ATTACH_FAILED`, or `ATTACH_NOT_REGISTERED`.
 */
export async function attachFile(root: ParentNode, payload: FilePayload, options: AttachOptions = {}): Promise<void> {
  const registrationTimeoutMs = options.registrationTimeoutMs ?? 15_000;
  const wait = { timeoutMs: registrationTimeoutMs, intervalMs: options.intervalMs ?? 100 };

  // Guardrails: validate payload before any DOM interaction.
  const verdict = validateFilePayload(payload);
  if (!verdict.ok) {
    throw new AutomationErrorException('INVALID_PAYLOAD', `File payload rejected: ${verdict.reason}`, 'attach-file');
  }

  log(`Starting attachment for "${payload.name}" (${payload.mimeType}, ${payload.byteLength} bytes)`);

  // ---- Strategy 1: Main-world bridge via postMessage ----
  // The main-world content script (upload.world.ts) runs in the page's JS
  // context where DataTransfer is a native object.
  log('Strategy 1: Main-world bridge via postMessage');
  const injectionResult = await requestMainWorldUpload(payload, 10_000);
  log(`Main-world bridge result: ok=${injectionResult.ok}, error=${injectionResult.error ?? 'none'}`);

  if (injectionResult.ok) {
    try {
      await waitForCondition(
        () => isAttachmentRegistered(root) || null,
        'attachment registration (main-world)',
        wait,
      );
      log('SUCCESS — attachment registered after main-world upload');
      return;
    } catch {
      log('Main-world upload executed but attachment not registered within timeout');
    }
  }

  // ---- Strategy 2: Isolated-world drop (fallback) ----
  // In case the main-world bridge didn't work, try the traditional
  // isolated-world approach as a fallback.
  log('Strategy 2: Isolated-world drop fallback');
  const file = decodeFilePayload(payload);
  const dataTransfer = createFileDataTransfer(file);
  const dropZone = queryFirst(root, SELECTORS.dropZone);

  if (dropZone) {
    log(`Drop zone found: ${dropZone.tagName}.${dropZone.className.slice(0, 60)}`);
    await dispatchDropSequence(dropZone, dataTransfer);
    try {
      await waitForCondition(
        () => isAttachmentRegistered(root) || null,
        'attachment registration (isolated-world)',
        wait,
      );
      log('SUCCESS — attachment registered after isolated-world drop');
      return;
    } catch {
      log('Isolated-world drop also failed');
    }
  }

  // ---- Strategy 3: File input fallback ----
  const fileInput = queryFirst(root, SELECTORS.fileInput);
  if (fileInput instanceof HTMLInputElement) {
    log('Strategy 3: File input fallback');
    try {
      populateFileInput(fileInput, dataTransfer);
      await waitForCondition(
        () => isAttachmentRegistered(root) || null,
        'attachment registration (input)',
        wait,
      );
      log('SUCCESS — attachment registered via file input');
      return;
    } catch {
      log('File input fallback also failed');
    }
  }

  logWarn('All strategies exhausted — attachment not registered');
  throw new AutomationErrorException(
    'ATTACH_NOT_REGISTERED',
    `Gemini did not register attachment "${payload.name}" within the registration timeout`,
    'attach-file',
  );
}
