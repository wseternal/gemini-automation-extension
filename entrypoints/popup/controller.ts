/**
 * entrypoints/popup/controller.ts — popup UI state machine.
 *
 * Renders its own DOM (single source of truth for the popup markup; the
 * template below is fully static — no user data is ever interpolated) and
 * drives idle → running → success/error transitions off the REAL messaging
 * round-trip with the background script. No mock states.
 */
import {
  ALLOWED_MIME_TYPES,
  AUTOMATION_RUN_REQUEST,
  validateFilePayload,
  type AutomationRunRequest,
  type AutomationRunResponse,
  type FilePayload,
  type TabInfo,
} from '../../types/automation';
import type { LlmProviderId } from '../../types/provider';

export type PopupPhase = 'idle' | 'running' | 'success' | 'error';

export interface PopupTransport {
  run(request: AutomationRunRequest): Promise<AutomationRunResponse>;
  openHistory(): void;
  listTabs(): Promise<TabInfo[]>;
  getSelectedProvider(): Promise<LlmProviderId>;
  setSelectedProvider(id: LlmProviderId): Promise<void>;
}

const TEMPLATE = `
  <h1 class="title">LLM Automation Bridge</h1>
  <form id="ga-form" novalidate>
    <label class="label" for="ga-provider">Provider</label>
    <select id="ga-provider">
      <option value="gemini">Google Gemini</option>
      <option value="deepseek">DeepSeek</option>
    </select>

    <label class="label" for="ga-tab-select">Conversation</label>
    <select id="ga-tab-select" disabled>
      <option value="new">+ New conversation</option>
    </select>

    <label class="label" for="ga-prompt">Prompt</label>
    <textarea id="ga-prompt" rows="4" placeholder="Ask the LLM about the attachment…"></textarea>
    <p id="ga-prompt-error" class="field-error" hidden>Enter a prompt first.</p>

    <label class="label" for="ga-file">Attachment <span class="muted">(optional)</span></label>
    <input id="ga-file" type="file" accept=".pdf,.txt,.md,.markdown,.csv,.json,.html,.png,.jpg,.jpeg,.webp,.gif" />
    <p id="ga-file-meta" class="muted"></p>

    <button id="ga-run" type="submit" class="primary">Run</button>
  </form>
  <button id="ga-history-link" type="button" class="link-button">History</button>

  <section id="ga-status" role="status" aria-live="polite" hidden>
    <span class="spinner" aria-hidden="true"></span>
    <span id="ga-status-text">Running in your LLM tab… this can take a minute while the response streams.</span>
  </section>

  <section id="ga-result" hidden>
    <h2 class="subtitle">Response</h2>
    <pre id="ga-result-text" class="result"></pre>
    <div class="row">
      <button id="ga-copy" type="button">Copy</button>
      <button id="ga-again" type="button">New run</button>
    </div>
  </section>

  <section id="ga-error" role="alert" hidden>
    <h2 class="subtitle">Automation failed</h2>
    <p id="ga-error-text" class="error-text"></p>
    <div class="row">
      <button id="ga-retry" type="button">Retry</button>
    </div>
  </section>
`;

export class PopupController {
  private phase: PopupPhase = 'idle';
  private lastError = '';

  constructor(
    private readonly root: HTMLElement,
    private readonly transport: PopupTransport,
  ) {
    this.root.innerHTML = TEMPLATE;
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.run();
    });
    this.retryButton.addEventListener('click', () => this.setPhase('idle'));
    this.againButton.addEventListener('click', () => this.setPhase('idle'));
    this.copyButton.addEventListener('click', () => void this.copyResult());
    this.fileInput.addEventListener('change', () => this.renderFileMeta());
    this.historyLink.addEventListener('click', () => this.openHistoryPage());
    this.providerSelect.addEventListener('change', () => void this.onProviderChange());
    this.setPhase('idle');
    void this.loadProvider();
  }

  private qs<T extends HTMLElement>(selector: string): T {
    const el = this.root.querySelector<T>(selector);
    if (!el) throw new Error(`popup template missing ${selector}`);
    return el;
  }

  private get form(): HTMLFormElement {
    return this.qs('#ga-form');
  }
  private get providerSelect(): HTMLSelectElement {
    return this.qs('#ga-provider');
  }
  private get tabSelect(): HTMLSelectElement {
    return this.qs('#ga-tab-select');
  }
  private get promptInput(): HTMLTextAreaElement {
    return this.qs('#ga-prompt');
  }
  private get promptError(): HTMLElement {
    return this.qs('#ga-prompt-error');
  }
  private get fileInput(): HTMLInputElement {
    return this.qs('#ga-file');
  }
  private get fileMeta(): HTMLElement {
    return this.qs('#ga-file-meta');
  }
  private get runButton(): HTMLButtonElement {
    return this.qs('#ga-run');
  }
  private get statusSection(): HTMLElement {
    return this.qs('#ga-status');
  }
  private get resultSection(): HTMLElement {
    return this.qs('#ga-result');
  }
  private get resultText(): HTMLElement {
    return this.qs('#ga-result-text');
  }
  private get errorSection(): HTMLElement {
    return this.qs('#ga-error');
  }
  private get errorText(): HTMLElement {
    return this.qs('#ga-error-text');
  }
  private get retryButton(): HTMLButtonElement {
    return this.qs('#ga-retry');
  }
  private get againButton(): HTMLButtonElement {
    return this.qs('#ga-again');
  }
  private get copyButton(): HTMLButtonElement {
    return this.qs('#ga-copy');
  }
  private get historyLink(): HTMLButtonElement {
    return this.qs('#ga-history-link');
  }

  getPhase(): PopupPhase {
    return this.phase;
  }

  private setPhase(phase: PopupPhase): void {
    this.phase = phase;
    this.statusSection.hidden = phase !== 'running';
    this.resultSection.hidden = phase !== 'success';
    this.errorSection.hidden = phase !== 'error';

    const showForm = phase === 'idle' || phase === 'running' || phase === 'success' || phase === 'error';
    this.root.querySelector<HTMLElement>('#ga-form')!.hidden = !showForm;
    this.historyLink.hidden = !showForm;

    this.form.classList.toggle('dimmed', phase === 'running');
    this.runButton.disabled = phase === 'running';
    this.promptInput.disabled = phase === 'running';
    this.fileInput.disabled = phase === 'running';
    this.tabSelect.disabled = phase === 'running';
    if (phase === 'error') this.errorText.textContent = this.lastError;
  }

  private renderFileMeta(): void {
    const file = this.fileInput.files?.[0];
    this.fileMeta.textContent = file ? `${file.name} — ${file.size.toLocaleString()} bytes` : '';
  }

  private async readFilePayload(file: File): Promise<FilePayload> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return {
      name: file.name,
      mimeType: file.type || 'application/octet-stream',
      dataBase64: bytesToBase64(bytes),
      byteLength: bytes.byteLength,
    };
  }

  /** Populate the conversation dropdown from open LLM tabs. */
  private async loadTabs(): Promise<void> {
    try {
      const tabs = await this.transport.listTabs();
      const select = this.tabSelect;
      select.innerHTML = '<option value="new">+ New conversation</option>';
      for (const tab of tabs) {
        const opt = document.createElement('option');
        opt.value = String(tab.tabId);
        const shortTitle = tab.title.length > 40 ? tab.title.slice(0, 40) + '…' : tab.title;
        opt.textContent = shortTitle || tab.url;
        select.appendChild(opt);
      }
      select.disabled = false;
    } catch {
      // If tab listing fails, keep the dropdown with just "New conversation".
      this.tabSelect.disabled = false;
    }
  }

  /** Load the saved provider selection. */
  private async loadProvider(): Promise<void> {
    try {
      const savedProvider = await this.transport.getSelectedProvider();
      this.providerSelect.value = savedProvider;
    } catch {
      // Default to gemini if loading fails.
      this.providerSelect.value = 'gemini';
    }
    await this.loadTabs();
  }

  /** Handle provider selection change. */
  private async onProviderChange(): Promise<void> {
    const providerId = this.providerSelect.value as LlmProviderId;
    await this.transport.setSelectedProvider(providerId);
    await this.loadTabs();
  }

  /** Run one automation round. Public (and awaitable) for tests. */
  async run(): Promise<AutomationRunResponse | null> {
    const prompt = this.promptInput.value.trim();
    if (prompt.length === 0) {
      this.promptError.hidden = false;
      this.promptInput.setAttribute('aria-invalid', 'true');
      return null;
    }
    this.promptError.hidden = true;
    this.promptInput.removeAttribute('aria-invalid');

    let filePayload: FilePayload | undefined;
    const picked = this.fileInput.files?.[0];
    if (picked) {
      filePayload = await this.readFilePayload(picked);
      const verdict = validateFilePayload(filePayload);
      if (!verdict.ok) {
        this.lastError = `Attachment rejected: ${verdict.reason}. Allowed types: ${ALLOWED_MIME_TYPES.join(', ')}`;
        this.setPhase('error');
        return null;
      }
    }

    const selectedValue = this.tabSelect.value;
    const targetTabId = selectedValue === 'new' ? undefined : Number(selectedValue);

    const providerId = this.providerSelect.value as LlmProviderId;
    const request: AutomationRunRequest = {
      kind: AUTOMATION_RUN_REQUEST,
      prompt,
      providerId,
      ...(filePayload ? { file: filePayload } : {}),
      ...(targetTabId !== undefined ? { targetTabId } : {}),
    };

    this.setPhase('running');
    let response: AutomationRunResponse;
    try {
      response = await this.transport.run(request);
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.setPhase('error');
      return null;
    }

    if (response.status === 'ok') {
      this.resultText.textContent = response.text;
      this.setPhase('success');
    } else {
      this.lastError = `[${response.error.code}] ${response.error.message}`;
      this.setPhase('error');
    }
    return response;
  }

  private async copyResult(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.resultText.textContent ?? '');
      this.copyButton.textContent = 'Copied!';
    } catch {
      this.copyButton.textContent = 'Copy failed';
    }
  }

  /** Open the full-page history view in a new tab. */
  private openHistoryPage(): void {
    this.transport.openHistory();
  }
}

/** Chunked base64 encoder safe for multi-MiB payloads. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
