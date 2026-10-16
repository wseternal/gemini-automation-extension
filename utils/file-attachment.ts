/**
 * utils/file-attachment.ts — ingest a file payload into Gemini's prompt bar.
 *
 * Primary path: synthesize a native drag-and-drop sequence (`dragenter` →
 * `dragover` → `drop`) carrying a real `DataTransfer` with the file.
 * Fallback: populate the uploader's hidden `<input type="file">` and fire
 * `change`. Either way, resolution is gated on Gemini *registering* the
 * attachment (chip/preview visible) — the caller is blocked until then, so
 * the prompt can never submit before the upload is in.
 */
import { AutomationErrorException, validateFilePayload, type FilePayload } from '../types/automation';
import { queryFirst, waitForCondition, type WaitOptions } from './dom-wait';
import { SELECTORS } from './selectors';

export interface AttachOptions extends WaitOptions {
  /** Budget for each registration confirmation wait. Default 15s. */
  readonly registrationTimeoutMs?: number;
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

/** Dispatch the full native drop sequence on `target`. */
export function dispatchDropSequence(target: Element, dataTransfer: DataTransfer): void {
  for (const type of ['dragenter', 'dragover', 'drop'] as const) {
    target.dispatchEvent(createTransferEvent(type, dataTransfer));
  }
}

/** Push the files into the hidden input and notify its listeners. */
export function populateFileInput(input: HTMLInputElement, dataTransfer: DataTransfer): void {
  try {
    input.files = dataTransfer.files;
  } catch {
    Object.defineProperty(input, 'files', { value: dataTransfer.files, configurable: true });
  }
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Probe: has Gemini registered an attachment (chip/preview visible)? */
export function isAttachmentRegistered(root: ParentNode): boolean {
  return queryFirst(root, SELECTORS.attachmentChip) !== null;
}

function toAttachError(e: unknown): AutomationErrorException {
  if (e instanceof AutomationErrorException) return e;
  return new AutomationErrorException('ATTACH_FAILED', e instanceof Error ? e.message : String(e), 'attach-file');
}

/**
 * Attach `payload` and resolve only after Gemini confirms registration.
 * Throws `INVALID_PAYLOAD`, `ATTACH_FAILED`, or `ATTACH_NOT_REGISTERED`.
 */
export async function attachFile(root: ParentNode, payload: FilePayload, options: AttachOptions = {}): Promise<void> {
  const registrationTimeoutMs = options.registrationTimeoutMs ?? 15_000;
  const wait = { timeoutMs: registrationTimeoutMs, intervalMs: options.intervalMs ?? 100 };

  // Guardrails run before any DOM interaction.
  const file = decodeFilePayload(payload);
  const dataTransfer = createFileDataTransfer(file);

  const dropZone = queryFirst(root, SELECTORS.dropZone);
  const fileInput = queryFirst(root, SELECTORS.fileInput);
  if (!dropZone && !(fileInput instanceof HTMLInputElement)) {
    throw new AutomationErrorException(
      'ATTACH_FAILED',
      'Neither a drop zone nor a file input exists on the page',
      'attach-file',
    );
  }

  // Primary: synthesized drag-and-drop onto the prompt area.
  if (dropZone) {
    dispatchDropSequence(dropZone, dataTransfer);
    try {
      await waitForCondition(() => isAttachmentRegistered(root) || null, 'attachment registration (drop)', wait);
      return;
    } catch {
      // Fall through to the hidden-input path.
    }
  }

  // Fallback: populate the uploader's hidden file input.
  if (fileInput instanceof HTMLInputElement) {
    try {
      populateFileInput(fileInput, dataTransfer);
    } catch (e) {
      throw toAttachError(e);
    }
    try {
      await waitForCondition(() => isAttachmentRegistered(root) || null, 'attachment registration (input)', wait);
      return;
    } catch {
      // Fall through to the typed not-registered error below.
    }
  }

  throw new AutomationErrorException(
    'ATTACH_NOT_REGISTERED',
    `Gemini did not register attachment "${payload.name}" within the registration timeout`,
    'attach-file',
  );
}
