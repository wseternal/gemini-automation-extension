/**
 * entrypoints/options/controller.ts — bridge settings page.
 *
 * Renders the settings form for LongPollConfig and shows the live state of
 * the background long-poll client. The transport is injected so the page
 * logic stays free of direct browser API calls.
 */
import type {
  LongPollConfig,
  LongPollStatus,
  LongPollStatusTransport,
} from '../../utils/long-poll-protocol';
import { LONG_POLL_STATUS_STALE_AFTER_MS, normalizeProxyUrl } from '../../utils/long-poll-protocol';

export interface SettingsTransport extends LongPollStatusTransport {
  loadConfig(): Promise<LongPollConfig>;
  saveConfig(config: LongPollConfig): Promise<void>;
  clearPendingAcks(): Promise<number>;
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

      <label class="label" for="gs-proxy-token">Proxy token <span class="muted">(optional)</span></label>
      <input
        id="gs-proxy-token"
        type="password"
        placeholder="Shared secret"
        spellcheck="false"
        autocomplete="off"
        aria-describedby="gs-token-hint"
      />
      <p id="gs-token-hint" class="hint">Sent as the X-Bridge-Token header. Leave empty when the proxy has no token.</p>

      <button id="gs-save" type="submit" class="primary">Save</button>
      <p id="gs-form-error" class="field-error" hidden></p>
      <p id="gs-saved" class="save-note" role="status" hidden>Saved. The client restarted with the new settings.</p>
    </form>
  </section>

  <section class="card">
    <h2 class="subtitle">Client status</h2>
    <p class="status-line" role="status" aria-live="polite">
      <span id="gs-status-dot" class="status-dot" aria-hidden="true"></span>
      <span id="gs-status-text">Loading status…</span>
    </p>
    <p id="gs-status-time" class="muted" hidden></p>
    <p id="gs-clear-pending-note" class="muted" role="status" aria-live="polite" hidden></p>
    <button id="gs-clear-pending" type="button" hidden>Clear unanswered results</button>
  </section>
`;

export class SettingsController {
  private savedTimer: ReturnType<typeof setTimeout> | undefined;
  private unwatchStatus: (() => void) | undefined;
  private lastStatusAt = -1;

  private readonly onPageHide = (): void => {
    this.unwatchStatus?.();
    this.unwatchStatus = undefined;
    if (this.savedTimer !== undefined) clearTimeout(this.savedTimer);
    this.savedTimer = undefined;
  };

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
    this.tokenInput.addEventListener('input', () => {
      this.hideFormError();
      this.hideSaved();
    });
    this.enabledInput.addEventListener('change', () => this.hideSaved());
    this.clearPendingButton.addEventListener('click', () => {
      void this.clearPending();
    });
    window.addEventListener('pagehide', this.onPageHide);

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
  private get tokenInput(): HTMLInputElement {
    return this.qs('#gs-proxy-token');
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
  private get clearPendingButton(): HTMLButtonElement {
    return this.qs('#gs-clear-pending');
  }
  private get clearPendingNote(): HTMLElement {
    return this.qs('#gs-clear-pending-note');
  }

  /** Load the saved config and the current client status. */
  private async load(): Promise<void> {
    try {
      const config = await this.transport.loadConfig();
      this.enabledInput.checked = config.enabled;
      this.urlInput.value = config.proxyUrl;
      this.tokenInput.value = config.token ?? '';
    } catch (error) {
      this.showFormError(`Cannot load settings: ${errorMessage(error)}`);
    }

    // Subscribe first, then read once. A change between the two calls is
    // replayed by the watcher; the timestamp guard ignores the stale read.
    this.unwatchStatus = this.transport.watchStatus((status) => this.renderStatus(status));
    try {
      this.renderStatus(await this.transport.getStatus());
    } catch {
      this.renderStatus(undefined);
    }
  }

  /** Validate the input, save the config, and show the result. */
  private async save(): Promise<void> {
    const enabled = this.enabledInput.checked;
    const raw = this.urlInput.value.trim();
    const token = this.tokenInput.value.trim();
    let proxyUrl = '';

    if (token && /[\r\n]/.test(token)) {
      this.showFormError('The proxy token must not contain line breaks.');
      return;
    }

    if (raw !== '') {
      const normalized = normalizeProxyUrl(raw);
      if (!normalized.ok) {
        // An invalid URL must not block turning the client off.
        if (enabled) {
          this.showUrlError(normalized.reason);
          return;
        }
        proxyUrl = '';
      } else {
        proxyUrl = normalized.url;
      }
    }

    if (enabled && proxyUrl === '') {
      this.showUrlError('Enter the proxy URL to enable the client.');
      return;
    }

    this.clearUrlError();
    this.hideFormError();

    try {
      await this.transport.saveConfig({
        enabled,
        proxyUrl,
        ...(token ? { token } : {}),
      });
    } catch (error) {
      this.showFormError(`Save failed: ${errorMessage(error)}`);
      return;
    }

    this.urlInput.value = proxyUrl;
    this.tokenInput.value = token;
    this.showSaved();
  }

  private renderStatus(status: LongPollStatus | undefined): void {
    // A removed key must be able to render "No status yet". Reset the clock
    // rather than letting a synthetic timestamp block every later update.
    if (!status) {
      this.lastStatusAt = 0;
      this.statusDot.className = 'status-dot';
      this.statusText.textContent = 'No status yet.';
      this.statusTime.hidden = true;
      this.clearPendingButton.hidden = true;
      return;
    }
    if (status.updatedAt < this.lastStatusAt) return;
    this.lastStatusAt = status.updatedAt;

    const pending = status.pendingAcks ?? [];
    this.updateClearPendingAction(pending.length);

    const stale =
      status.state !== 'disabled' &&
      Date.now() - status.updatedAt > LONG_POLL_STATUS_STALE_AFTER_MS;

    if (stale) {
      this.statusDot.className = 'status-dot status-dot-idle';
      this.statusText.textContent = 'Status is stale. The background worker may be suspended.';
      this.statusTime.textContent = `Last report: ${new Date(status.updatedAt).toLocaleTimeString()}`;
      this.statusTime.hidden = false;
      return;
    }

    switch (status.state) {
      case 'disabled':
        this.statusDot.className = 'status-dot status-dot-idle';
        this.statusText.textContent = 'Client is not active.';
        break;
      case 'connecting': {
        this.statusDot.className = 'status-dot status-dot-connecting';
        const retries = status.failureCount ? ` (${status.failureCount} consecutive)` : '';
        const detail = status.lastError ? ` Last attempt: ${status.lastError}${retries}.` : '';
        this.statusText.textContent = `${status.message ?? 'Connecting to the proxy…'}${detail}`;
        break;
      }
      case 'polling': {
        this.statusDot.className = 'status-dot status-dot-ok';
        this.statusText.textContent = status.proxyUrl ? `Polling ${status.proxyUrl}.` : 'Client is active.';
        break;
      }
      case 'degraded': {
        this.statusDot.className = 'status-dot status-dot-degraded';
        const failures = status.ackFailures ? ` (${status.ackFailures} unacknowledged)` : '';
        this.statusText.textContent = `Result delivery failed: ${status.lastAckError ?? status.message ?? 'unknown error'}${failures}.`;
        break;
      }
      case 'error': {
        this.statusDot.className = 'status-dot status-dot-error';
        const label =
          status.errorKind === 'config'
            ? 'Settings error'
            : status.errorKind === 'protocol'
              ? 'Protocol error'
              : 'Connection error';
        const failures = status.failureCount ? ` (${status.failureCount} consecutive)` : '';
        this.statusText.textContent = `${label}: ${status.message ?? 'unknown error'}${failures}.`;
        break;
      }
    }

    if (pending.length > 0) {
      const first = pending[0];
      this.statusText.textContent +=
        ` ${pending.length} result${pending.length === 1 ? '' : 's'} record${pending.length === 1 ? '' : 's'} pending locally` +
        ` (job ${first.jobId}, last attempt ${new Date(first.lastAttemptAt).toLocaleTimeString()}): ${first.error}.`;
    }

    let timeText = `Last report: ${new Date(status.updatedAt).toLocaleTimeString()}`;
    if (status.lastAckAt !== undefined) {
      timeText += ` · Last result acknowledged: ${new Date(status.lastAckAt).toLocaleTimeString()}`;
    }
    this.statusTime.textContent = timeText;
    this.statusTime.hidden = false;
  }

  private updateClearPendingAction(count: number): void {
    this.clearPendingButton.hidden = count === 0;
    this.clearPendingButton.textContent =
      count === 1 ? 'Clear unanswered result' : `Clear ${count} unanswered results`;
  }

  /** Clear proxy results that could not be acknowledged, without exposing their contents. */
  private async clearPending(): Promise<void> {
    this.clearPendingButton.disabled = true;
    this.clearPendingNote.hidden = true;
    try {
      const cleared = await this.transport.clearPendingAcks();
      this.clearPendingNote.textContent =
        cleared > 0
          ? `Cleared ${cleared} unanswered result${cleared === 1 ? '' : 's'}.`
          : 'No unanswered results were stored.';
      this.clearPendingNote.hidden = false;
      // The watcher will publish the refreshed status. Do not re-read here:
      // that read can race the background's queued status write and re-show
      // a button that was just cleared.
      if (cleared > 0) this.clearPendingButton.hidden = true;
    } catch (error) {
      this.clearPendingNote.textContent = `Could not clear unanswered results: ${errorMessage(error)}`;
      this.clearPendingNote.hidden = false;
    } finally {
      this.clearPendingButton.disabled = false;
    }
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
