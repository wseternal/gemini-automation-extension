/**
 * entrypoints/upload.world.ts — main-world file upload bridge.
 *
 * Runs in the page's MAIN world (not the extension's isolated world).
 * This is necessary because:
 *   1. Content scripts run in an isolated world where synthetic DataTransfer
 *      objects don't properly cross to the page's main-world JS context.
 *   2. The content script's CSP blocks inline <script> injection.
 *   3. By running in the main world, DataTransfer + DragEvent are native
 *      objects in the same JS context as Gemini's Angular event handlers.
 *
 * Communication protocol with the isolated-world content script:
 *   - Listens for `window.postMessage` with type `gemini-bridge/upload`
 *   - Performs the file upload in the main world
 *   - Posts result back via `window.postMessage` with type `gemini-bridge/upload-result`
 */
import { defineContentScript } from 'wxt/sandbox';

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

function isUploadRequest(data: unknown): data is UploadRequest {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as Record<string, unknown>).type === 'gemini-bridge/upload' &&
    typeof (data as Record<string, unknown>).id === 'string' &&
    typeof (data as Record<string, unknown>).dataBase64 === 'string' &&
    typeof (data as Record<string, unknown>).name === 'string' &&
    typeof (data as Record<string, unknown>).mimeType === 'string'
  );
}

/**
 * Attempt to upload a file by dispatching a paste event on Gemini's
 * Quill editor. Gemini's Angular app handles paste events on the editor
 * and processes files from the clipboard DataTransfer.
 *
 * Falls back to drop events on the editor and drop zone if paste fails.
 * Runs entirely in the page's main world where DataTransfer is native.
 */
function performUpload(dataBase64: string, name: string, mimeType: string): { ok: boolean; error?: string } {
  try {
    // 1. Reconstruct the File in the main world context.
    const binary = atob(dataBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const file = new File([bytes], name, { type: mimeType });

    // 2. Find the Quill editor (Gemini's prompt input).
    const editor =
      document.querySelector('.ql-editor[contenteditable="true"]') ||
      document.querySelector('[contenteditable="true"][role="textbox"]');

    // 3. Strategy A: Paste event on the Quill editor.
    //    Gemini's Angular app listens for paste events and processes
    //    files from the clipboardData. This is the most reliable method.
    if (editor) {
      const dt = new DataTransfer();
      dt.items.add(file);

      try {
        const pasteEvent = new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: dt,
        });
        // If ClipboardEvent constructor doesn't carry clipboardData, patch it.
        if (!pasteEvent.clipboardData) {
          Object.defineProperty(pasteEvent, 'clipboardData', { value: dt });
        }
        editor.dispatchEvent(pasteEvent);
      } catch {
        // ClipboardEvent constructor may fail — use plain Event fallback.
        const evt = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(evt, 'clipboardData', { value: dt });
        editor.dispatchEvent(evt);
      }
    }

    // 4. Strategy B: Drop event on the editor (backup).
    //    Some browsers may handle drop but not paste for file uploads.
    if (editor) {
      const dt2 = new DataTransfer();
      dt2.items.add(file);
      dt2.dropEffect = 'copy';
      const eventTypes = ['dragenter', 'dragover', 'drop'] as const;
      for (const evtType of eventTypes) {
        const evt = new DragEvent(evtType, {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt2,
        });
        if (!evt.dataTransfer) {
          Object.defineProperty(evt, 'dataTransfer', { value: dt2 });
        }
        editor.dispatchEvent(evt);
      }
    }

    // 5. Strategy C: Drop on the drop zone directive element (final backup).
    const dropZone =
      document.querySelector('[xapfileselectordropzone]') ||
      document.querySelector('[file-drop-zone]') ||
      document.querySelector('.xap-uploader-dropzone');
    if (dropZone) {
      const dt3 = new DataTransfer();
      dt3.items.add(file);
      dt3.dropEffect = 'copy';
      const eventTypes = ['dragenter', 'dragover', 'drop'] as const;
      for (const evtType of eventTypes) {
        const evt = new DragEvent(evtType, {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt3,
        });
        if (!evt.dataTransfer) {
          Object.defineProperty(evt, 'dataTransfer', { value: dt3 });
        }
        dropZone.dispatchEvent(evt);
      }
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export default defineContentScript({
  matches: ['https://gemini.google.com/*'],
  world: 'MAIN',
  main() {
    window.addEventListener('message', (event: MessageEvent) => {
      // Only accept messages from the same window.
      if (event.source !== window) return;

      const data = event.data;
      if (!isUploadRequest(data)) return;

      const result = performUpload(data.dataBase64, data.name, data.mimeType);

      const response: UploadResult = {
        type: 'gemini-bridge/upload-result',
        id: data.id,
        ok: result.ok,
        error: result.error,
      };

      window.postMessage(response, '*');
    });
  },
});
