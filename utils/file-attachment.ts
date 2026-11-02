/**
 * utils/file-attachment.ts — ingest a file payload into the LLM prompt bar.
 *
 * The content script runs in Chrome's **isolated world**, where synthetic
 * DataTransfer objects don't properly cross to the page's main-world
 * JavaScript context. Some providers (e.g., Gemini) need a main-world
 * bridge script for paste events. Others (e.g., DeepSeek) accept direct
 * file input.
 */
import { AutomationErrorException, validateFilePayload, type FilePayload } from '../types/automation';
import type { LlmProvider, ProviderSelectors } from '../types/provider';
import { queryFirst, sleep, waitForCondition, type WaitOptions } from './dom-wait';

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

/** Probe: has the provider registered an attachment (chip/preview visible)? */
export function isAttachmentRegistered(root: ParentNode, selectors: ProviderSelectors): boolean {
  return queryFirst(root, selectors.attachmentChip) !== null;
}

function toAttachError(e: unknown): AutomationErrorException {
  if (e instanceof AutomationErrorException) return e;
  return new AutomationErrorException('ATTACH_FAILED', e instanceof Error ? e.message : String(e), 'attach-file');
}

// ---------------------------------------------------------------------------
// Main-world bridge via window.postMessage
// ---------------------------------------------------------------------------

interface UploadRequest {
  type: 'llm-bridge/upload';
  id: string;
  nonce: string;
  dataBase64: string;
  name: string;
  mimeType: string;
}

interface UploadResult {
  type: 'llm-bridge/upload-result';
  id: string;
  ok: boolean;
  error?: string;
}

/**
 * Request the main-world content script to perform the file upload.
 * Uses a shared nonce set on the DOM to prevent accidental processing
 * by unrelated scripts on the page.
 * Returns the result from the main world, or times out.
 */
function requestMainWorldUpload(
  payload: FilePayload,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ ok: boolean; error?: string }> {
  const id = `upload_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const nonce = `nonce_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  // Set nonce on DOM so the main-world script can validate it.
  document.documentElement.dataset.bridgeNonce = nonce;

  return new Promise((resolve) => {
    const cleanup = () => {
      window.removeEventListener('message', handler);
      clearTimeout(timer);
      delete document.documentElement.dataset.bridgeNonce;
      signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      cleanup();
      resolve({ ok: false, error: 'upload aborted by caller' });
    };

    const handler = (event: MessageEvent) => {
      // Only accept messages from the same window.
      if (event.source !== window) return;

      const data = event.data as UploadResult | undefined;
      if (
        data?.type === 'llm-bridge/upload-result' &&
        data.id === id
      ) {
        cleanup();
        resolve({ ok: data.ok, error: data.error });
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      resolve({ ok: false, error: 'main-world upload request timed out' });
    }, timeoutMs);

    signal?.addEventListener('abort', onAbort, { once: true });
    window.addEventListener('message', handler);

    const request: UploadRequest = {
      type: 'llm-bridge/upload',
      id,
      nonce,
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
 * Attach `payload` and resolve only after the provider confirms registration.
 * Throws `INVALID_PAYLOAD`, `ATTACH_FAILED`, or `ATTACH_NOT_REGISTERED`.
 */
export async function attachFile(
  root: ParentNode,
  provider: LlmProvider,
  payload: FilePayload,
  options: AttachOptions = {},
): Promise<void> {
  const registrationTimeoutMs = options.registrationTimeoutMs ?? 15_000;
  const wait = { timeoutMs: registrationTimeoutMs, intervalMs: options.intervalMs ?? 100 };
  const selectors = provider.selectors;

  // Guardrails: validate payload before any DOM interaction.
  const verdict = validateFilePayload(payload);
  if (!verdict.ok) {
    throw new AutomationErrorException('INVALID_PAYLOAD', `File payload rejected: ${verdict.reason}`, 'attach-file');
  }

  log(`Starting attachment for "${payload.name}" (${payload.mimeType}, ${payload.byteLength} bytes)`);

  // ---- Strategy based on provider's file attachment strategy ----
  if (provider.fileAttachmentStrategy === 'paste-bridge') {
    // Gemini-style: Main-world bridge via postMessage
    log('Strategy: Main-world bridge via postMessage');
    const injectionResult = await requestMainWorldUpload(payload, 10_000);
    log(`Main-world bridge result: ok=${injectionResult.ok}, error=${injectionResult.error ?? 'none'}`);

    if (injectionResult.ok) {
      try {
        await waitForCondition(
          () => isAttachmentRegistered(root, selectors) || null,
          'attachment registration (main-world)',
          wait,
        );
        log('SUCCESS — attachment registered after main-world upload');
        return;
      } catch {
        log('Main-world upload executed but attachment not registered within timeout');
      }
    }
  } else if (provider.fileAttachmentStrategy === 'file-input') {
    // DeepSeek-style: Direct file input
    log('Strategy: Direct file input');
    const file = decodeFilePayload(payload);
    const dataTransfer = createFileDataTransfer(file);
    const fileInput = queryFirst(root, selectors.fileInput);
    if (fileInput instanceof HTMLInputElement) {
      populateFileInput(fileInput, dataTransfer);
      try {
        await waitForCondition(
          () => isAttachmentRegistered(root, selectors) || null,
          'attachment registration (file-input)',
          wait,
        );
        log('SUCCESS — attachment registered via file input');
        return;
      } catch {
        log('File input strategy also failed');
      }
    }
  }

  // ---- Fallback: Isolated-world drop ----
  log('Fallback: Isolated-world drop');
  const file = decodeFilePayload(payload);
  const dataTransfer = createFileDataTransfer(file);
  const dropZone = queryFirst(root, selectors.dropZone);

  if (dropZone) {
    log(`Drop zone found: ${dropZone.tagName}.${dropZone.className.slice(0, 60)}`);
    await dispatchDropSequence(dropZone, dataTransfer);
    try {
      await waitForCondition(
        () => isAttachmentRegistered(root, selectors) || null,
        'attachment registration (isolated-world)',
        wait,
      );
      log('SUCCESS — attachment registered after isolated-world drop');
      return;
    } catch {
      log('Isolated-world drop also failed');
    }
  }

  // ---- Final fallback: File input ----
  const fileInput = queryFirst(root, selectors.fileInput);
  if (fileInput instanceof HTMLInputElement) {
    log('Final fallback: File input');
    try {
      populateFileInput(fileInput, dataTransfer);
      await waitForCondition(
        () => isAttachmentRegistered(root, selectors) || null,
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
    `${provider.name} did not register attachment "${payload.name}" within the registration timeout`,
    'attach-file',
  );
}
