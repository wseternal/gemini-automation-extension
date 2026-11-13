/**
 * utils/history-storage.ts — CRUD for automation run history.
 *
 * Stores entries in `browser.storage.local` under a single key.
 * Entries are capped at {@link MAX_HISTORY_ENTRIES} to bound storage usage.
 * The base64 file data is NOT stored — only attachment metadata.
 */
import { browser } from 'wxt/browser';
import type { HistoryEntry } from '../types/automation';

const HISTORY_KEY = 'llm-automation/history' as const;
const MAX_HISTORY_ENTRIES = 200;

/** Append an entry to history storage. Prunes oldest when cap exceeded. */
export async function saveHistoryEntry(entry: HistoryEntry): Promise<void> {
  const entries = await readRaw();
  entries.unshift(entry);
  if (entries.length > MAX_HISTORY_ENTRIES) {
    entries.length = MAX_HISTORY_ENTRIES;
  }
  await browser.storage.local.set({ [HISTORY_KEY]: entries });
}

/** Return all history entries sorted newest-first. */
export async function listHistoryEntries(): Promise<HistoryEntry[]> {
  const entries = await readRaw();
  entries.sort((a, b) => b.timestamp - a.timestamp);
  return entries;
}

/** A unique conversation extracted from history for the popup dropdown. */
export interface HistoryConversation {
  readonly url: string;
  readonly prompt: string;
  readonly providerId: HistoryEntry['providerId'];
}

/** Return unique conversation URLs from recent history (newest first). */
export async function listHistoryConversations(limit = 30): Promise<HistoryConversation[]> {
  const entries = await readRaw();
  entries.sort((a, b) => b.timestamp - a.timestamp);
  const seen = new Set<string>();
  const result: HistoryConversation[] = [];
  for (const entry of entries) {
    if (!entry.conversationUrl || entry.status !== 'ok') continue;
    if (seen.has(entry.conversationUrl)) continue;
    seen.add(entry.conversationUrl);
    result.push({
      url: entry.conversationUrl,
      prompt: entry.prompt,
      providerId: entry.providerId,
    });
    if (result.length >= limit) break;
  }
  return result;
}

/** Look up a single entry by id. */
export async function getHistoryEntry(id: string): Promise<HistoryEntry | undefined> {
  const entries = await readRaw();
  return entries.find((e) => e.id === id);
}

/** Remove all history entries from storage. */
export async function clearHistory(): Promise<void> {
  await browser.storage.local.remove(HISTORY_KEY);
}

/** Remove a single history entry by id. */
export async function deleteHistoryEntry(id: string): Promise<void> {
  const entries = await readRaw();
  const filtered = entries.filter((e) => e.id !== id);
  if (filtered.length === 0) {
    await browser.storage.local.remove(HISTORY_KEY);
  } else {
    await browser.storage.local.set({ [HISTORY_KEY]: filtered });
  }
}

async function readRaw(): Promise<HistoryEntry[]> {
  const result = await browser.storage.local.get(HISTORY_KEY);
  const raw = result[HISTORY_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter(isHistoryEntryShape);
}

const KNOWN_PROVIDER_IDS = new Set(['gemini', 'deepseek']);

function isAttachmentShape(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === 'string' &&
    typeof v.mimeType === 'string' &&
    typeof v.byteLength === 'number' &&
    v.byteLength > 0
  );
}

function isHistoryEntryShape(value: unknown): value is HistoryEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' && v.id.length > 0 &&
    typeof v.timestamp === 'number' && v.timestamp > 1_600_000_000_000 &&
    typeof v.providerId === 'string' && KNOWN_PROVIDER_IDS.has(v.providerId) &&
    typeof v.prompt === 'string' &&
    (v.status === 'ok' || v.status === 'error') &&
    typeof v.responseText === 'string' &&
    (v.conversationUrl === undefined || typeof v.conversationUrl === 'string') &&
    (v.responseMarkdown === undefined || typeof v.responseMarkdown === 'string') &&
    (v.attachment === undefined || isAttachmentShape(v.attachment))
  );
}

/** Generate a short unique id for a history entry. */
export function generateHistoryId(): string {
  return `h_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
