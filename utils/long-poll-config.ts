/**
 * utils/long-poll-config.ts — browser-backed long-poll settings and status.
 *
 * Pure shapes, normalization, and guards live in long-poll-protocol.ts so
 * they can be tested without the extension runtime. This module owns only
 * the storage access.
 */
import { browser } from 'wxt/browser';
import {
  LONG_POLL_CLEAR_PENDING_REQUEST,
  isLongPollClearPendingResponse,
} from '../types/automation';
import {
  LONG_POLL_CONFIG_KEY,
  LONG_POLL_STATUS_KEY,
  coerceLongPollConfig,
  isLongPollStatus,
  type LongPollConfig,
  type LongPollStatus,
} from './long-poll-protocol';

/** Read the saved config. A missing or corrupted value falls back to defaults. */
export async function loadLongPollConfig(): Promise<LongPollConfig> {
  const stored = await browser.storage.local.get(LONG_POLL_CONFIG_KEY);
  return coerceLongPollConfig(stored[LONG_POLL_CONFIG_KEY]);
}

/** Save the config. A storage change restarts the background client. */
export async function saveLongPollConfig(config: LongPollConfig): Promise<void> {
  await browser.storage.local.set({ [LONG_POLL_CONFIG_KEY]: config });
}

/** Ask the background to clear unanswered proxy results for the current proxy. */
export async function clearLongPollPendingAcks(): Promise<number> {
  const response = await browser.runtime.sendMessage({ kind: LONG_POLL_CLEAR_PENDING_REQUEST });
  return isLongPollClearPendingResponse(response) ? response.cleared : 0;
}

/** Listen for normalized config changes. Returns an unsubscribe function. */
export function watchLongPollConfig(
  listener: (config: LongPollConfig) => void,
): () => void {
  const onChanged = (
    changes: Record<string, { newValue?: unknown }>,
    areaName: string,
  ): void => {
    if (areaName !== 'local' || !(LONG_POLL_CONFIG_KEY in changes)) return;
    listener(coerceLongPollConfig(changes[LONG_POLL_CONFIG_KEY].newValue));
  };
  browser.storage.onChanged.addListener(onChanged);
  return () => browser.storage.onChanged.removeListener(onChanged);
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
