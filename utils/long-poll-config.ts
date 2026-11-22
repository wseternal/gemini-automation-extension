/**
 * utils/long-poll-config.ts — long-poll settings and runtime status.
 *
 * One module owns the storage keys, the stored shape, and the input
 * validation. The background client, the options page, and the popup
 * import this module instead of working with raw storage values.
 */
import { browser } from 'wxt/browser';

/** Configuration stored in browser.storage.local under LONG_POLL_CONFIG_KEY. */
export interface LongPollConfig {
  /** Base URL of the proxy server (e.g. "http://localhost:9090"). */
  proxyUrl: string;
  /** Whether the long-poll client is enabled. */
  enabled: boolean;
}

export const LONG_POLL_CONFIG_KEY = 'llm-automation/long-poll-config';
export const LONG_POLL_STATUS_KEY = 'llm-automation/long-poll-status';

export const DEFAULT_LONG_POLL_CONFIG: LongPollConfig = { proxyUrl: '', enabled: false };

/** State of the background client, written by background.ts. */
export type LongPollState = 'disabled' | 'polling' | 'error';

export interface LongPollStatus {
  readonly state: LongPollState;
  /** URL that the running client polls. */
  readonly proxyUrl?: string;
  /** Last error message, present when state is 'error'. */
  readonly message?: string;
  readonly updatedAt: number;
}

/** Read the saved config. A missing or corrupted value falls back to defaults. */
export async function loadLongPollConfig(): Promise<LongPollConfig> {
  const stored = await browser.storage.local.get(LONG_POLL_CONFIG_KEY);
  return coerceLongPollConfig(stored[LONG_POLL_CONFIG_KEY]);
}

/** Save the config. A storage change restarts the background client. */
export async function saveLongPollConfig(config: LongPollConfig): Promise<void> {
  await browser.storage.local.set({ [LONG_POLL_CONFIG_KEY]: config });
}

/** Read the last known client status. */
export async function getLongPollStatus(): Promise<LongPollStatus | undefined> {
  const stored = await browser.storage.local.get(LONG_POLL_STATUS_KEY);
  const value = stored[LONG_POLL_STATUS_KEY];
  return isLongPollStatus(value) ? value : undefined;
}

/** Listen for client status changes. Returns an unsubscribe function. */
export function watchLongPollStatus(
  listener: (status: LongPollStatus | undefined) => void,
): () => void {
  const onChanged = (
    changes: Record<string, { newValue?: unknown }>,
    areaName: string,
  ): void => {
    if (areaName !== 'local' || !(LONG_POLL_STATUS_KEY in changes)) return;
    const value = changes[LONG_POLL_STATUS_KEY].newValue;
    listener(isLongPollStatus(value) ? value : undefined);
  };
  browser.storage.onChanged.addListener(onChanged);
  return () => browser.storage.onChanged.removeListener(onChanged);
}

export type ProxyUrlResult = { ok: true; url: string } | { ok: false; reason: string };

/**
 * Normalize user input into a base URL that the manifest can reach.
 * The manifest grants host access to http://localhost and http://127.0.0.1 only.
 */
export function normalizeProxyUrl(raw: string): ProxyUrlResult {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: 'Enter the proxy URL.' };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'Enter a full URL, such as http://localhost:9090.' };
  }

  if (parsed.protocol !== 'http:') {
    return { ok: false, reason: 'Use an http:// URL. The manifest does not grant access to https hosts.' };
  }
  if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    return { ok: false, reason: 'Use localhost or 127.0.0.1. The manifest grants access to no other host.' };
  }
  if (parsed.search || parsed.hash) {
    return { ok: false, reason: 'Remove the query string and the hash from the URL.' };
  }

  const path = parsed.pathname.replace(/\/+$/, '');
  return { ok: true, url: `${parsed.origin}${path}` };
}

/** Type guard for a status value read from storage. */
export function isLongPollStatus(value: unknown): value is LongPollStatus {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.state !== 'disabled' && record.state !== 'polling' && record.state !== 'error') {
    return false;
  }
  if (typeof record.updatedAt !== 'number') return false;
  if (record.proxyUrl !== undefined && typeof record.proxyUrl !== 'string') return false;
  if (record.message !== undefined && typeof record.message !== 'string') return false;
  return true;
}

function coerceLongPollConfig(value: unknown): LongPollConfig {
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_LONG_POLL_CONFIG };
  const record = value as Record<string, unknown>;
  return {
    proxyUrl: typeof record.proxyUrl === 'string' ? record.proxyUrl : '',
    enabled: record.enabled === true,
  };
}
