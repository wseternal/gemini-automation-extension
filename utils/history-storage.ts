/**
 * utils/history-storage.ts — CRUD for automation run history.
 *
 * Stores entries in `browser.storage.local` under a single key.
 * Entries are capped at {@link MAX_HISTORY_ENTRIES} to bound storage usage.
 * The base64 file data is NOT stored — only attachment metadata.
 */
import { browser } from 'wxt/browser';
import type { HistoryEntry } from '../types/automation';

const HISTORY_KEY = 'gemini-automation/history' as const;
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

/** Look up a single entry by id. */
export async function getHistoryEntry(id: string): Promise<HistoryEntry | undefined> {
  const entries = await readRaw();
  return entries.find((e) => e.id === id);
}

/** Remove all history entries from storage. */
export async function clearHistory(): Promise<void> {
  await browser.storage.local.remove(HISTORY_KEY);
}

async function readRaw(): Promise<HistoryEntry[]> {
  const result = await browser.storage.local.get(HISTORY_KEY);
  const raw = result[HISTORY_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter(isHistoryEntryShape);
}

function isHistoryEntryShape(value: unknown): value is HistoryEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.timestamp === 'number' &&
    typeof v.prompt === 'string' &&
    (v.status === 'ok' || v.status === 'error') &&
    typeof v.responseText === 'string' &&
    (v.conversationUrl === undefined || typeof v.conversationUrl === 'string') &&
    (v.responseMarkdown === undefined || typeof v.responseMarkdown === 'string')
  );
}

/** Generate a short unique id for a history entry. */
export function generateHistoryId(): string {
  return `h_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
