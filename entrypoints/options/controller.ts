/**
 * entrypoints/options/controller.ts — bridge settings page.
 *
 * Renders the settings form for LongPollConfig and shows the live state of
 * the background long-poll client. The transport is injected so the page
 * logic stays free of direct browser API calls.
 */
import type { LongPollConfig, LongPollStatus } from '../../utils/long-poll-config';
import { normalizeProxyUrl } from '../../utils/long-poll-config';

export interface SettingsTransport {
  loadConfig(): Promise<LongPollConfig>;
  saveConfig(config: LongPollConfig): Promise<void>;
  getStatus(): Promise<LongPollStatus | undefined>;
  /** Listen for status changes. Returns an unsubscribe function. */
  watchStatus(listener: (status: LongPollStatus | undefined) => void): () => void;
}

const TEMPLATE = `
  <header class="page-header">
    <h1 class="title">Bridge Settings</h1>
    <p id="gs-build-info" class="build-info"></p>
  </header>

  <section class="card">
    <h2 class="subtitle">Long-polling client</h2>
    <p class="muted">The client polls a local proxy for automation jobs. Enable the client to accept jobs from the proxy.</p>

    <form id="gs-form" novalidate>
      <label class="switch-row" for="gs-enabled">
        <input id="gs-enabled" type="checkbox" />
        <span>Enable long-polling client</span>
      </label>

      <label class="label" for="gs-proxy-url">Proxy URL</label>
      <input
        id="gs-proxy-url"
        type="text"
        placeholder="http://localhost:9090"
        spellcheck="false"
        autocomplete="off"
        aria-describedby="gs-url-hint gs-url-error"
      />
      <p id="gs-url-error" class="field-error" hidden></p>
      <p id="gs-url-hint" class="hint">The manifest allows http://localhost and http://127.0.0.1 only.</p>

      <button id="gs-save" type="submit" class="primary">Save</button>
      <p id="gs-form-error" class="field-error" hidden></p>
      <p id="gs-saved" class="save-note" role="status" hidden>Saved. The client restarted with the new settings.</p>
    </form>
  </section>

  <section class="card">
    <h2 class="subtitle">Client status</h2>
    <p class="status-line">
      <span id="gs-status-dot" class="status-dot" aria-hidden="true"></span>
      <span id="gs-status-text">Loading status…</span>
    </p>
    <p id="gs-status-time" class="muted" hidden></p>
  </section>
`;

export class SettingsController {
  private savedTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly root: HTMLElement,
    private readonly transport: SettingsTransport,
  ) {
    this.root.innerHTML = TEMPLATE;
    const buildInfo = this.root.querySelector<HTMLElement>('#gs-build-info');
    if (buildInfo) buildInfo.textContent = `${__BUILD_VERSION__} \u00b7 ${__BUILD_TIME__}`;

    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.save();
    });
    this.urlInput.addEventListener('input', () => {
      this.clearUrlError();
      this.hideSaved();
    });
    this.enabledInput.addEventListener('change', () => this.hideSaved());

    void this.load();
  }

  private qs<T extends HTMLElement>(selector: string): T {
    const el = this.root.querySelector<T>(selector);
    if (!el) throw new Error(`settings template missing ${selector}`);
    return el;
  }

  private get form(): HTMLFormElement {
    return this.qs('#gs-form');
  }
  private get enabledInput(): HTMLInputElement {
    return this.qs('#gs-enabled');
  }
  private get urlInput(): HTMLInputElement {
    return this.qs('#gs-proxy-url');
  }
  private get urlError(): HTMLElement {
    return this.qs('#gs-url-error');
  }
  private get formError(): HTMLElement {
    return this.qs('#gs-form-error');
  }
  private get savedNote(): HTMLElement {
    return this.qs('#gs-saved');
  }
  private get statusDot(): HTMLElement {
    return this.qs('#gs-status-dot');
  }
  private get statusText(): HTMLElement {
    return this.qs('#gs-status-text');
  }
  private get statusTime(): HTMLElement {
    return this.qs('#gs-status-time');
  }

  /** Load the saved config and the current client status. */
  private async load(): Promise<void> {
    try {
      const config = await this.transport.loadConfig();
      this.enabledInput.checked = config.enabled;
      this.urlInput.value = config.proxyUrl;
    } catch (error) {
      this.showFormError(`Cannot load settings: ${errorMessage(error)}`);
    }

    try {
      this.renderStatus(await this.transport.getStatus());
    } catch {
      this.renderStatus(undefined);
    }
    this.transport.watchStatus((status) => this.renderStatus(status));
  }

  /** Validate the input, save the config, and show the result. */
  private async save(): Promise<void> {
    const enabled = this.enabledInput.checked;
    const raw = this.urlInput.value.trim();
    let proxyUrl = '';

    if (raw !== '') {
      const normalized = normalizeProxyUrl(raw);
      if (!normalized.ok) {
        this.showUrlError(normalized.reason);
        return;
      }
      proxyUrl = normalized.url;
    }

    if (enabled && proxyUrl === '') {
      this.showUrlError('Enter the proxy URL to enable the client.');
      return;
    }

    this.clearUrlError();
    this.hideFormError();

    try {
      await this.transport.saveConfig({ enabled, proxyUrl });
    } catch (error) {
      this.showFormError(`Save failed: ${errorMessage(error)}`);
      return;
    }

    this.urlInput.value = proxyUrl;
    this.showSaved();
  }

  private renderStatus(status: LongPollStatus | undefined): void {
    if (!status) {
      this.statusDot.className = 'status-dot';
      this.statusText.textContent = 'No status yet.';
      this.statusTime.hidden = true;
      return;
    }

    switch (status.state) {
      case 'disabled':
        this.statusDot.className = 'status-dot status-dot-idle';
        this.statusText.textContent = 'Client is not active.';
        break;
      case 'polling':
        this.statusDot.className = 'status-dot status-dot-ok';
        this.statusText.textContent = status.proxyUrl ? `Polling ${status.proxyUrl}.` : 'Client is active.';
        break;
      case 'error':
        this.statusDot.className = 'status-dot status-dot-error';
        this.statusText.textContent = `Connection error: ${status.message ?? 'unknown error'}`;
        break;
    }

    this.statusTime.textContent = `Last report: ${new Date(status.updatedAt).toLocaleTimeString()}`;
    this.statusTime.hidden = false;
  }

  private showUrlError(message: string): void {
    this.urlError.textContent = message;
    this.urlError.hidden = false;
    this.urlInput.setAttribute('aria-invalid', 'true');
  }

  private clearUrlError(): void {
    this.urlError.textContent = '';
    this.urlError.hidden = true;
    this.urlInput.removeAttribute('aria-invalid');
  }

  private showFormError(message: string): void {
    this.formError.textContent = message;
    this.formError.hidden = false;
  }

  private hideFormError(): void {
    this.formError.textContent = '';
    this.formError.hidden = true;
  }

  private showSaved(): void {
    this.savedNote.hidden = false;
    if (this.savedTimer !== undefined) clearTimeout(this.savedTimer);
    this.savedTimer = setTimeout(() => {
      this.savedNote.hidden = true;
    }, 2_500);
  }

  private hideSaved(): void {
    this.savedNote.hidden = true;
    if (this.savedTimer !== undefined) clearTimeout(this.savedTimer);
    this.savedTimer = undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
