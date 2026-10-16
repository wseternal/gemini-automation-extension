/**
 * tests/helpers.ts — shared test helpers.
 *
 * The fake browser's `tabs.update` type omits `status` even though the fake
 * accepts it at runtime; `markTabComplete` centralizes the single cast.
 */
import { fakeBrowser } from 'wxt/testing';

export async function markTabComplete(tabId: number): Promise<void> {
  await setTabStatus(tabId, 'complete');
}

export async function markTabLoading(tabId: number): Promise<void> {
  await setTabStatus(tabId, 'loading');
}

async function setTabStatus(tabId: number, status: 'complete' | 'loading'): Promise<void> {
  const update = fakeBrowser.tabs.update as unknown as (
    id: number,
    props: Record<string, unknown>,
  ) => Promise<unknown>;
  await update(tabId, { status });
}
