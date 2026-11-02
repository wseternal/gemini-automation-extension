/**
 * entrypoints/upload-main.content.ts — main-world file upload bridge.
 *
 * Runs in the page's MAIN world (not the extension's isolated world).
 * This is necessary because:
 *   1. Content scripts run in an isolated world where synthetic DataTransfer
 *      objects don't properly cross to the page's main-world JS context.
 *   2. The content script's CSP blocks inline <script> injection.
 *   3. By running in the main world, DataTransfer + DragEvent are native
 *      objects in the same JS context as the provider's event handlers.
 *
 * Communication protocol with the isolated-world content script:
 *   - Listens for `window.postMessage` with type `llm-bridge/upload`
 *   - Performs the file upload in the main world
 *   - Posts result back via `window.postMessage` with type `llm-bridge/upload-result`
 */
import { defineContentScript } from 'wxt/sandbox';

interface UploadRequest {
  type: 'llm-bridge/upload';
  id: string;
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

function isUploadRequest(data: unknown): data is UploadRequest {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as Record<string, unknown>).type === 'llm-bridge/upload' &&
    typeof (data as Record<string, unknown>).id === 'string' &&
    typeof (data as Record<string, unknown>).dataBase64 === 'string' &&
    typeof (data as Record<string, unknown>).name === 'string' &&
    typeof (data as Record<string, unknown>).mimeType === 'string'
  );
}

/**
 * Attempt to upload a file using provider-appropriate strategies.
 *
 * Strategy A: Direct file input (works for DeepSeek and many others).
 * Strategy B: Paste event on contenteditable editor (Gemini).
 * Strategy C: Drop events on editor and drop zones (backup).
 * Runs entirely in the page's main world where DataTransfer is native.
 */
function performUpload(dataBase64: string, name: string, mimeType: string): { ok: boolean; error?: string } {
  try {
    // 1. Reconstruct the File in the main world context.
    const binary = atob(dataBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const file = new File([bytes], name, { type: mimeType });

    // 2. Strategy A: Direct file input (DeepSeek and generic sites).
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement | null;
    if (fileInput) {
      const dt = new DataTransfer();
      dt.items.add(file);
      try {
        fileInput.files = dt.files;
      } catch {
        Object.defineProperty(fileInput, 'files', { value: dt.files, configurable: true });
      }
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      fileInput.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // 3. Strategy B: Paste event on contenteditable editor (Gemini).
    const editor =
      document.querySelector('.ql-editor[contenteditable="true"]') ||
      document.querySelector('[contenteditable="true"][role="textbox"]');
    if (editor) {
      const dt = new DataTransfer();
      dt.items.add(file);
      try {
        const pasteEvent = new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: dt,
        });
        if (!pasteEvent.clipboardData) {
          Object.defineProperty(pasteEvent, 'clipboardData', { value: dt });
        }
        editor.dispatchEvent(pasteEvent);
      } catch {
        const evt = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(evt, 'clipboardData', { value: dt });
        editor.dispatchEvent(evt);
      }
    }

    // 4. Strategy C: Drop events on editor (backup).
    if (editor) {
      const dt2 = new DataTransfer();
      dt2.items.add(file);
      dt2.dropEffect = 'copy';
      for (const evtType of ['dragenter', 'dragover', 'drop'] as const) {
        const evt = new DragEvent(evtType, { bubbles: true, cancelable: true, dataTransfer: dt2 });
        if (!evt.dataTransfer) {
          Object.defineProperty(evt, 'dataTransfer', { value: dt2 });
        }
        editor.dispatchEvent(evt);
      }
    }

    // 5. Strategy D: Drop on drop zone directive element (final backup).
    const dropZone =
      document.querySelector('[xapfileselectordropzone]') ||
      document.querySelector('[file-drop-zone]') ||
      document.querySelector('.xap-uploader-dropzone');
    if (dropZone) {
      const dt3 = new DataTransfer();
      dt3.items.add(file);
      dt3.dropEffect = 'copy';
      for (const evtType of ['dragenter', 'dragover', 'drop'] as const) {
        const evt = new DragEvent(evtType, { bubbles: true, cancelable: true, dataTransfer: dt3 });
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
  matches: ['https://gemini.google.com/*', 'https://chat.deepseek.com/*'],
  world: 'MAIN',
  main() {
    window.addEventListener('message', (event: MessageEvent) => {
      // Only accept messages from the same window.
      if (event.source !== window) return;

      const data = event.data;
      if (!isUploadRequest(data)) return;

      const result = performUpload(data.dataBase64, data.name, data.mimeType);

      const response: UploadResult = {
        type: 'llm-bridge/upload-result',
        id: data.id,
        ok: result.ok,
        error: result.error,
      };

      window.postMessage(response, '*');
    });
  },
});
