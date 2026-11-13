/**
 * entrypoints/history/controller.ts — full-page history view.
 *
 * Renders the conversation history list and detail views in a full browser
 * tab (not the popup). Provides more space for reading long responses and
 * browsing past runs.
 */
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { HistoryEntry } from '../../types/automation';
import {
  clearHistory,
  listHistoryEntries,
  getHistoryEntry,
  deleteHistoryEntry,
} from '../../utils/history-storage';

export type HistoryPhase = 'list' | 'detail';

const TEMPLATE = `
  <header class="history-page-header">
    <h1 class="title">Automation History</h1>
    <div class="header-actions">
      <button id="gh-clear" type="button" class="link-button">Clear all</button>
    </div>
  </header>

  <section id="gh-list-section">
    <p id="gh-empty" class="muted empty-state" hidden>No history yet. Run an automation from the popup to see it here.</p>
    <ul id="gh-list" class="history-list"></ul>
  </section>

  <section id="gh-detail" hidden>
    <button id="gh-detail-back" type="button" class="link-button back-link">&larr; Back to history</button>
    <div class="detail-card">
      <div class="detail-meta">
        <span id="gh-detail-status" class="status-badge"></span>
        <span id="gh-detail-time" class="detail-time"></span>
      </div>
      <a id="gh-detail-url" class="conversation-link" hidden target="_blank" rel="noopener">Open in Gemini</a>
      <div class="detail-section-header">
        <h2 class="subtitle">Prompt</h2>
        <button id="gh-copy-prompt" type="button" class="copy-button">Copy</button>
      </div>
      <div id="gh-detail-prompt" class="result-block markdown-body"></div>
      <div class="detail-section-header">
        <h2 class="subtitle" id="gh-detail-response-label">Response</h2>
        <button id="gh-copy-response" type="button" class="copy-button">Copy</button>
      </div>
      <div id="gh-detail-response" class="result-block markdown-body"></div>
      <div id="gh-detail-attachment" hidden>
        <h2 class="subtitle">Attachment</h2>
        <p id="gh-detail-attachment-info" class="muted"></p>
      </div>
    </div>
  </section>
`;

export class HistoryController {
  private phase: HistoryPhase = 'list';

  constructor(private readonly root: HTMLElement) {
    this.root.innerHTML = TEMPLATE;
    this.clearButton.addEventListener('click', () => void this.onClearHistory());
    this.detailBack.addEventListener('click', () => void this.showList());
    this.copyPromptButton.addEventListener('click', () => void this.copyMarkdown(this.detailPrompt, this.copyPromptButton));
    this.copyResponseButton.addEventListener('click', () => void this.copyMarkdown(this.detailResponse, this.copyResponseButton));
    void this.showList();
  }

  private qs<T extends HTMLElement>(selector: string): T {
    const el = this.root.querySelector<T>(selector);
    if (!el) throw new Error(`history template missing ${selector}`);
    return el;
  }

  private get listSection(): HTMLElement {
    return this.qs('#gh-list-section');
  }
  private get listEl(): HTMLUListElement {
    return this.qs('#gh-list');
  }
  private get emptyEl(): HTMLElement {
    return this.qs('#gh-empty');
  }
  private get clearButton(): HTMLButtonElement {
    return this.qs('#gh-clear');
  }
  private get detailSection(): HTMLElement {
    return this.qs('#gh-detail');
  }
  private get detailBack(): HTMLButtonElement {
    return this.qs('#gh-detail-back');
  }
  private get detailStatus(): HTMLElement {
    return this.qs('#gh-detail-status');
  }
  private get detailTime(): HTMLElement {
    return this.qs('#gh-detail-time');
  }
  private get detailUrl(): HTMLAnchorElement {
    return this.qs('#gh-detail-url');
  }
  private get detailPrompt(): HTMLElement {
    return this.qs('#gh-detail-prompt');
  }
  private get detailResponseLabel(): HTMLElement {
    return this.qs('#gh-detail-response-label');
  }
  private get detailResponse(): HTMLElement {
    return this.qs('#gh-detail-response');
  }
  private get detailAttachment(): HTMLElement {
    return this.qs('#gh-detail-attachment');
  }
  private get detailAttachmentInfo(): HTMLElement {
    return this.qs('#gh-detail-attachment-info');
  }
  private get copyPromptButton(): HTMLButtonElement {
    return this.qs('#gh-copy-prompt');
  }
  private get copyResponseButton(): HTMLButtonElement {
    return this.qs('#gh-copy-response');
  }

  private setPhase(phase: HistoryPhase): void {
    this.phase = phase;
    this.listSection.hidden = phase !== 'list';
    this.detailSection.hidden = phase !== 'detail';
  }

  /** Load and display the history list. */
  private async showList(): Promise<void> {
    const entries = await listHistoryEntries();
    this.renderList(entries);
    this.setPhase('list');
  }

  private renderList(entries: HistoryEntry[]): void {
    this.listEl.innerHTML = '';
    this.emptyEl.hidden = entries.length > 0;
    this.listEl.hidden = entries.length === 0;

    for (const entry of entries) {
      const li = document.createElement('li');
      li.className = 'history-item';
      li.setAttribute('role', 'button');
      li.setAttribute('tabindex', '0');

      const statusIcon = entry.status === 'ok' ? '✓' : '✗';
      const statusClass = entry.status === 'ok' ? 'status-ok' : 'status-error';
      const preview = entry.prompt.length > 120 ? entry.prompt.slice(0, 120) + '…' : entry.prompt;
      const timeLabel = formatRelativeTime(entry.timestamp);

      const responsePreview =
        entry.status === 'ok'
          ? entry.responseText.length > 80
            ? entry.responseText.slice(0, 80) + '…'
            : entry.responseText
          : `[${entry.errorCode ?? 'ERROR'}] ${entry.errorMessage ?? 'Unknown error'}`;

      li.innerHTML =
        `<span class="history-status ${statusClass}">${statusIcon}</span>` +
        `<div class="history-content">` +
        `<div class="history-preview">${escapeHtml(preview)}</div>` +
        `<div class="history-response-preview">${escapeHtml(responsePreview)}</div>` +
        `</div>` +
        `<span class="history-time">${timeLabel}</span>` +
        `<button type="button" class="history-delete" title="Delete" aria-label="Delete entry">&times;</button>`;

      const deleteBtn = li.querySelector<HTMLButtonElement>('.history-delete');
      if (deleteBtn) {
        deleteBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          void this.onDeleteEntry(entry.id);
        });
        deleteBtn.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            e.stopPropagation();
            void this.onDeleteEntry(entry.id);
          }
        });
      }

      li.addEventListener('click', () => void this.showDetail(entry.id));
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          void this.showDetail(entry.id);
        }
      });
      this.listEl.appendChild(li);
    }
  }

  /** Load and display a single history entry detail. */
  private async showDetail(id: string): Promise<void> {
    const entry = await getHistoryEntry(id);
    if (!entry) {
      await this.showList();
      return;
    }

    // Status badge
    if (entry.status === 'ok') {
      this.detailStatus.textContent = 'Success';
      this.detailStatus.className = 'status-badge status-ok';
    } else {
      this.detailStatus.textContent = 'Error';
      this.detailStatus.className = 'status-badge status-error';
    }

    // Timestamp
    this.detailTime.textContent = new Date(entry.timestamp).toLocaleString();

    // Conversation URL link
    if (entry.conversationUrl) {
      this.detailUrl.href = entry.conversationUrl;
      this.detailUrl.hidden = false;
    } else {
      this.detailUrl.hidden = true;
    }

    // Prompt (rendered as markdown)
    this.detailPrompt.dataset.markdown = entry.prompt;
    this.detailPrompt.innerHTML = renderSafeMarkdown(entry.prompt);

    // Response or error (rendered as markdown)
    if (entry.status === 'ok') {
      this.detailResponseLabel.textContent = 'Response';
      // Prefer structured markdown when available; fall back to plain text.
      const md = entry.responseMarkdown || entry.responseText || '(empty response)';
      this.detailResponse.dataset.markdown = md;
      this.detailResponse.innerHTML = renderSafeMarkdown(md);
      this.detailResponse.classList.remove('error-text');
    } else {
      this.detailResponseLabel.textContent = 'Error';
      const errorText = `[${entry.errorCode ?? 'UNKNOWN'}] ${entry.errorMessage ?? 'Unknown error'}`;
      this.detailResponse.dataset.markdown = errorText;
      this.detailResponse.textContent = errorText;
      this.detailResponse.classList.add('error-text');
    }

    // Attachment
    if (entry.attachment) {
      this.detailAttachment.hidden = false;
      this.detailAttachmentInfo.textContent =
        `${entry.attachment.name} — ${entry.attachment.byteLength.toLocaleString()} bytes (${entry.attachment.mimeType})`;
    } else {
      this.detailAttachment.hidden = true;
    }

    this.setPhase('detail');
  }

  private async onClearHistory(): Promise<void> {
    await clearHistory();
    this.renderList([]);
  }

  private async onDeleteEntry(id: string): Promise<void> {
    await deleteHistoryEntry(id);
    await this.showList();
  }

  /** Copy the raw markdown source of a section to the clipboard. */
  private async copyMarkdown(el: HTMLElement, btn: HTMLButtonElement): Promise<void> {
    const source = el.dataset.markdown || el.innerText || el.textContent || '';
    try {
      await navigator.clipboard.writeText(source);
      const original = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = original; }, 1500);
    } catch {
      /* clipboard access denied — silently ignore */
    }
  }
}

/** Format a timestamp as a short relative time string. */
function formatRelativeTime(epochMs: number): string {
  const diffMs = Date.now() - epochMs;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return new Date(epochMs).toLocaleDateString();
}

/**
 * Render Markdown to HTML with XSS protection.
 * `marked` v18+ does not sanitize HTML by default, so raw `<script>`,
 * `<iframe>`, and event handlers would execute. DOMPurify strips all
 * dangerous elements and attributes after Markdown parsing.
 */
function renderSafeMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text) as string);
}

/** Minimal HTML escaping for user-generated text inserted via innerHTML. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
