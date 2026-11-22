/**
 * entrypoints/background.ts — tab orchestration and message dispatch.
 *
 * Receives typed run requests (popup or programmatic), resolves the provider
 * tab via the tab manager (reuse-first), dispatches to the content script,
 * stamps tab metadata, and hands the latest result off via storage.session
 * so a reopened popup can recover it.
 *
 * Also starts the long-polling client when configured, enabling the AI
 * automation proxy to deliver jobs to this extension.
 */
import { browser as wxtBrowser } from 'wxt/browser';
import type { Runtime } from 'wxt/browser';
import { defineBackground } from 'wxt/sandbox';
import {
  AutomationErrorException,
  err,
  isAutomationRunRequest,
  isAutomationRunResponse,
  isLongPollClearPendingRequest,
  isTabListRequest,
  LONG_POLL_CLEAR_PENDING_RESPONSE,
  TAB_LIST_RESPONSE,
  type AutomationRunRequest,
  type AutomationRunResponse,
  type ConversationInfo,
  type HistoryEntry,
  type LongPollClearPendingResponse,
  type TabListResponse,
} from '../types/automation';
import { getProvider, ALL_PROVIDERS } from '../providers';
import type { LlmProviderId } from '../types/provider';
import { resolveTargetTab, listAllProviderTabs, waitForTabComplete, type BrowserLike } from '../utils/tab-manager';
import { generateHistoryId, saveHistoryEntry, listHistoryConversations } from '../utils/history-storage';
import {
  startLongPollClient,
  type LongPollJobOutcome,
  type LongPollJobRejection,
  type LongPollResultReady,
} from '../utils/long-poll-client';
import { loadLongPollConfig, watchLongPollConfig } from '../utils/long-poll-config';
import {
  LONG_POLL_ACK_RETRY_WINDOW_MS,
  LONG_POLL_FAILED_RESULTS_KEY,
  LONG_POLL_LEASE_KEY,
  LONG_POLL_MAX_PENDING_ACKS,
  LONG_POLL_STATUS_KEY,
  LONG_POLL_STATUS_REFRESH_MS,
  isLongPollLease,
  isLongPollPendingAckMap,
  pendingAckKey,
  requestDigest,
  type LongPollConfig,
  type LongPollPendingAck,
  type LongPollPendingAckMap,
  type LongPollStatus,
  type PollJob,
} from '../utils/long-poll-protocol';

export const LAST_RESULT_KEY = 'llm-automation/last-result' as const;

export interface DispatchOptions {
  readonly loadTimeoutMs?: number;
  readonly source?: 'popup' | 'proxy';
  readonly remoteJobId?: string;
}

function withTabId(response: AutomationRunResponse, tabId: number): AutomationRunResponse {
  if (response.status === 'ok') return { ...response, meta: { ...response.meta, tabId } };
  return response.meta ? { ...response, meta: { ...response.meta, tabId } } : response;
}

/**
 * Core dispatch: resolve tab → send request → validate → stamp → persist.
 * On a connection failure (content script not yet injected, e.g. the tab
 * predates the extension install) the tab is reloaded once and the dispatch
 * retried once — within the frozen permission set, a reload is what
 * re-registers the manifest content script.
 */
export async function dispatchAutomation(
  browserApi: BrowserLike,
  request: AutomationRunRequest,
  options: DispatchOptions = {},
): Promise<AutomationRunResponse> {
  // Resolve provider from request or use default.
  const providerId = request.providerId ?? 'gemini';
  const provider = getProvider(providerId);
  if (!provider) {
    return err('INVALID_PROVIDER', `Unknown provider: ${providerId}`);
  }

  let managed: Awaited<ReturnType<typeof resolveTargetTab>> | undefined;
  let tabId: number | undefined;
  let succeeded = false;
  let errorCode: string | undefined;
  try {
    managed = await resolveTargetTab(browserApi, provider, request.targetTabId, { loadTimeoutMs: options.loadTimeoutMs }, request.targetUrl);
    tabId = managed.tabId;

    let raw: unknown;
    try {
      raw = await browserApi.tabs.sendMessage(tabId, request);
    } catch (firstError) {
      // Content script not present → reload the tab once and retry once.
      await browserApi.tabs.reload(tabId).catch(() => undefined);
      await waitForTabComplete(browserApi, tabId, options.loadTimeoutMs ?? 30_000).catch(() => undefined);
      try {
        raw = await browserApi.tabs.sendMessage(tabId, request);
      } catch {
        throw firstError;
      }
    }

    if (!isAutomationRunResponse(raw)) {
      throw new AutomationErrorException('INTERNAL', 'content script returned an unrecognized response shape');
    }

    const stamped = withTabId(raw, tabId);
    await browserApi.storage.session.set({ [LAST_RESULT_KEY]: stamped });
    const conversationUrl = await getTabUrl(browserApi, tabId);
    await persistHistory(request, provider.id, stamped, conversationUrl, options);
    succeeded = stamped.status === 'ok';
    if (stamped.status === 'error') errorCode = stamped.error.code;
    return stamped;
  } catch (e) {
    if (e instanceof AutomationErrorException) {
      const response = err(e.code, e.message, e.step);
      errorCode = e.code;
      const stamped = tabId === undefined ? response : withTabId(response, tabId);
      const conversationUrl = tabId !== undefined ? await getTabUrl(browserApi, tabId) : undefined;
      await persistHistory(request, provider.id, stamped, conversationUrl, options);
      return stamped;
    }
    const message = e instanceof Error ? e.message : String(e);
    const response = err('INTERNAL', `automation dispatch failed: ${message}`);
    errorCode = 'INTERNAL';
    const stamped = tabId === undefined ? response : withTabId(response, tabId);
    const conversationUrl = tabId !== undefined ? await getTabUrl(browserApi, tabId) : undefined;
    await persistHistory(request, provider.id, stamped, conversationUrl, options);
    return stamped;
  } finally {
    // Close background tabs that automation created.
    // On success: always close.
    // On hard failures (tab not found, load timeout, invalid provider):
    //   close — the tab state is not diagnostic.
    // On soft failures (extraction, submit, attach):
    //   keep open so the user can inspect what went wrong.
    if (managed?.shouldCloseAfter) {
      const hardFailures = new Set(['NO_TAB', 'TAB_LOAD_TIMEOUT', 'INVALID_PROVIDER']);
      const shouldClose =
        succeeded ||
        (options.source === 'proxy' && errorCode !== undefined) ||
        (errorCode !== undefined && hardFailures.has(errorCode));
      if (shouldClose) {
        await browserApi.tabs.remove(managed.tabId).catch(() => undefined);
      }
    }
  }
}

let dispatchQueue: Promise<AutomationRunResponse | undefined> = Promise.resolve(undefined);

/**
 * Serialize runs globally. Popup and proxy callers share the tab composer,
 * extraction DOM, `storage.session` last-result slot, and history storage,
 * so only one automation run may be in flight at a time.
 */
function enqueueDispatch(
  browserApi: BrowserLike,
  request: AutomationRunRequest,
  options: DispatchOptions = {},
): Promise<AutomationRunResponse> {
  const next = dispatchQueue
    .catch(() => undefined)
    .then(() => dispatchAutomation(browserApi, request, options));
  dispatchQueue = next;
  return next;
}

const LONG_POLL_ALARM = 'llm-automation/long-poll-wake';
const LONG_POLL_ALARM_PERIOD_MINUTES = 1;

type LongPollClientHandle = ReturnType<typeof startLongPollClient>;

let longPollClient: LongPollClientHandle | undefined;
let restartQueue: Promise<void> = Promise.resolve();
let lastLongPollStatus = '';
let lastLongPollStatusAt = 0;
let statusWriteQueue: Promise<void> = Promise.resolve();

/** The status writer accepts every persisted field except the timestamp it stamps. */
type LongPollStatusUpdate = Omit<LongPollStatus, 'updatedAt'>;

/** Write the client status when the value changes or the report is stale. */
function reportLongPollStatus(update: LongPollStatusUpdate): void {
  const signature = JSON.stringify(
    Object.entries(update)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  const now = Date.now();
  if (signature === lastLongPollStatus && now - lastLongPollStatusAt < LONG_POLL_STATUS_REFRESH_MS) return;
  lastLongPollStatus = signature;
  lastLongPollStatusAt = now;
  const status: LongPollStatus = {
    state: update.state,
    ...(update.proxyUrl ? { proxyUrl: update.proxyUrl } : {}),
    ...(update.message ? { message: update.message } : {}),
    ...(update.lastError ? { lastError: update.lastError } : {}),
    ...(update.errorKind ? { errorKind: update.errorKind } : {}),
    ...(update.failureCount !== undefined ? { failureCount: update.failureCount } : {}),
    ...(update.lastAckError ? { lastAckError: update.lastAckError } : {}),
    ...(update.ackFailures !== undefined ? { ackFailures: update.ackFailures } : {}),
    ...(update.lastAckAt !== undefined ? { lastAckAt: update.lastAckAt } : {}),
    ...(update.pendingAcks ? { pendingAcks: update.pendingAcks } : {}),
    updatedAt: now,
  };

  // Serialize writes so a slow set cannot reorder an older status over a newer one.
  statusWriteQueue = statusWriteQueue
    .catch(() => undefined)
    .then(() => wxtBrowser.storage.local.set({ [LONG_POLL_STATUS_KEY]: status }))
    .catch((error) => {
      console.warn('[long-poll] status write failed:', error);
    });
}

/** Persist lease metadata only — never the request body or base64 file bytes. */
async function saveLongPollLease(job: PollJob, digest: string): Promise<void> {
  try {
    await wxtBrowser.storage.session.set({
      [LONG_POLL_LEASE_KEY]: {
        jobId: job.job_id,
        requestDigest: digest,
        receivedAt: Date.now(),
      },
    });
  } catch (error) {
    console.warn('[long-poll] lease write failed:', error);
  }
}

/** Clear the lease only when it still belongs to the finished job. */
async function clearLongPollLease(jobId: string): Promise<void> {
  try {
    const stored = await wxtBrowser.storage.session.get(LONG_POLL_LEASE_KEY);
    const lease = stored[LONG_POLL_LEASE_KEY];
    if (isLongPollLease(lease) && lease.jobId === jobId) {
      await wxtBrowser.storage.session.remove(LONG_POLL_LEASE_KEY);
    }
  } catch (error) {
    console.warn('[long-poll] lease cleanup failed:', error);
  }
}

/**
 * A lease at worker startup means the previous worker stopped mid-job.
 * The proxy still owns the job and will redeliver it after the lease TTL;
 * re-dispatching here could duplicate side effects.
 */
async function reconcileLongPollLease(): Promise<void> {
  try {
    const stored = await wxtBrowser.storage.session.get(LONG_POLL_LEASE_KEY);
    const lease = stored[LONG_POLL_LEASE_KEY];
    if (lease === undefined) return;
    if (isLongPollLease(lease)) {
      console.warn('[long-poll] recovered an interrupted lease; waiting for proxy redelivery', {
        jobId: lease.jobId,
        receivedAt: lease.receivedAt,
      });
    }
    await wxtBrowser.storage.session.remove(LONG_POLL_LEASE_KEY);
  } catch (error) {
    console.warn('[long-poll] lease reconciliation failed:', error);
  }
}

/**
 * Serialize the pending-ack map's read-modify-write cycles. Each writer reads
 * the map, mutates a local copy, and writes it back; without a queue a writer
 * holding a snapshot taken before a concurrent write can resurrect a record the
 * user cleared, or drop a freshly persisted answer so a redelivery re-runs the
 * automation. Same pattern as `statusWriteQueue`.
 */
let pendingAckWriteQueue: Promise<unknown> = Promise.resolve();

function enqueuePendingAckWrite<T>(task: () => Promise<T>): Promise<T> {
  const next = pendingAckWriteQueue.then(task, task);
  pendingAckWriteQueue = next.catch(() => undefined);
  return next;
}

async function readPendingAckMap(): Promise<LongPollPendingAckMap> {
  const stored = await wxtBrowser.storage.local.get(LONG_POLL_FAILED_RESULTS_KEY);
  const raw = stored[LONG_POLL_FAILED_RESULTS_KEY];
  return isLongPollPendingAckMap(raw) ? { ...raw } : {};
}

function prunePendingAckMap(
  map: LongPollPendingAckMap,
  now: number,
): { map: LongPollPendingAckMap; changed: boolean } {
  const entries = Object.entries(map);
  const fresh = entries.filter(([, record]) => now - record.lastAttemptAt <= LONG_POLL_ACK_RETRY_WINDOW_MS);
  const sorted = fresh.sort(([, a], [, b]) => b.lastAttemptAt - a.lastAttemptAt);
  const kept = sorted.slice(0, LONG_POLL_MAX_PENDING_ACKS);
  const next = Object.fromEntries(kept);
  const changed = kept.length !== entries.length;
  return { map: next, changed };
}

async function writePendingAckMap(map: LongPollPendingAckMap): Promise<void> {
  try {
    if (Object.keys(map).length === 0) {
      await wxtBrowser.storage.local.remove(LONG_POLL_FAILED_RESULTS_KEY);
    } else {
      await wxtBrowser.storage.local.set({ [LONG_POLL_FAILED_RESULTS_KEY]: map });
    }
  } catch (error) {
    console.warn('[long-poll] pending-ack write failed:', error);
  }
}

/** Load fresh pending results for this proxy; prune stale or excess records. */
async function loadPendingAckRecords(proxyUrl: string): Promise<LongPollPendingAck[]> {
  return enqueuePendingAckWrite(async () => {
    try {
      const map = await readPendingAckMap();
      const { map: pruned, changed } = prunePendingAckMap(map, Date.now());
      if (changed) await writePendingAckMap(pruned);
      return Object.values(pruned)
        .filter((record) => record.proxyUrl === proxyUrl)
        .sort((a, b) => b.lastAttemptAt - a.lastAttemptAt);
    } catch (error) {
      console.warn('[long-poll] pending-ack read failed:', error);
      return [];
    }
  });
}

/** Persist a result before the POST so a crash cannot lose the answer. */
async function persistPendingAckReady(
  proxyUrl: string,
  ready: LongPollResultReady,
): Promise<void> {
  return enqueuePendingAckWrite(async () => {
    try {
      const map = await readPendingAckMap();
      const key = pendingAckKey(proxyUrl, ready.jobId);
      const digest = requestDigest(ready.request);
      const previous = map[key];
      if (previous && previous.requestDigest === digest) {
        map[key] = { ...previous, response: ready.response };
      } else {
        map[key] = {
          proxyUrl,
          jobId: ready.jobId,
          requestDigest: digest,
          response: ready.response,
          error: 'Result not acknowledged yet',
          attempts: 0,
          lastAttemptAt: Date.now(),
        };
      }
      await writePendingAckMap(prunePendingAckMap(map, Date.now()).map);
    } catch (error) {
      console.warn('[long-poll] result-ready persistence failed:', error);
    }
  });
}

/** Record a retryable delivery failure so a redelivery can reuse the result. */
async function persistPendingAckFailure(
  proxyUrl: string,
  outcome: LongPollJobOutcome,
): Promise<void> {
  if (!outcome.requestDigest) {
    // A mapping-stage rejection has no request to reuse. It has no side
    // effects, so repeating it is harmless; do not create a misleading record.
    return;
  }
  const digest = outcome.requestDigest;
  return enqueuePendingAckWrite(async () => {
    try {
      const map = await readPendingAckMap();
      const key = pendingAckKey(proxyUrl, outcome.jobId);
      const previous = map[key];
      map[key] = {
        proxyUrl,
        jobId: outcome.jobId,
        requestDigest: digest,
        response: outcome.response,
        error: outcome.ackError ?? 'unknown result delivery error',
        attempts: (previous?.attempts ?? 0) + 1,
        lastAttemptAt: Date.now(),
      };
      await writePendingAckMap(prunePendingAckMap(map, Date.now()).map);
    } catch (error) {
      console.warn('[long-poll] pending-ack failure write failed:', error);
    }
  });
}

/** Remove a pending record only for this proxy's job. */
async function clearPendingAck(proxyUrl: string, jobId: string): Promise<void> {
  return enqueuePendingAckWrite(async () => {
    try {
      const map = await readPendingAckMap();
      const key = pendingAckKey(proxyUrl, jobId);
      if (!(key in map)) return;
      delete map[key];
      await writePendingAckMap(map);
    } catch (error) {
      console.warn('[long-poll] pending-ack cleanup failed:', error);
    }
  });
}

/** Clear every unanswered result owned by one proxy. */
async function clearPendingAcksForProxy(proxyUrl: string): Promise<number> {
  return enqueuePendingAckWrite(async () => {
    try {
      const map = await readPendingAckMap();
      let cleared = 0;
      for (const key of Object.keys(map)) {
        if (map[key].proxyUrl !== proxyUrl) continue;
        delete map[key];
        cleared += 1;
      }
      if (cleared > 0) await writePendingAckMap(map);
      return cleared;
    } catch (error) {
      console.warn('[long-poll] pending-ack bulk cleanup failed:', error);
      return 0;
    }
  });
}

/** Handle the options-page "clear unanswered results" action. */
async function handleClearLongPollPending(): Promise<LongPollClearPendingResponse> {
  let clientCleared = 0;
  try {
    if (longPollClient) clientCleared = await longPollClient.clearPendingAcks();
  } catch (error) {
    console.warn('[long-poll] client pending-ack clear failed:', error);
  }

  let storageCleared = 0;
  try {
    const config = await loadLongPollConfig();
    storageCleared = await clearPendingAcksForProxy(config.proxyUrl);
  } catch (error) {
    console.warn('[long-poll] pending-ack config read failed:', error);
  }

  // The client clears its own records through the expiry hook; the storage
  // fallback covers a disabled client or a failed hook. Both refer to the
  // same current-proxy records, so report the larger set, not their sum.
  return {
    kind: LONG_POLL_CLEAR_PENDING_RESPONSE,
    cleared: Math.max(clientCleared, storageCleared),
  };
}

/** Reuse a result only when both the job id and request digest match. */
async function loadPendingAckResult(
  proxyUrl: string,
  jobId: string,
  digest: string,
): Promise<AutomationRunResponse | undefined> {
  const records = await loadPendingAckRecords(proxyUrl);
  const record = records.find((item) => item.jobId === jobId);
  if (!record) return undefined;
  if (record.requestDigest !== digest) {
    console.warn('[long-poll] redelivered job digest mismatch; not reusing stored result', { jobId });
    return undefined;
  }
  console.warn('[long-poll] reusing stored result for redelivered job', { jobId });
  return record.response;
}

/** Write a history row for a request that failed validation before dispatch. */
async function persistProxyRejection(rejection: LongPollJobRejection): Promise<void> {
  const entry: HistoryEntry = {
    id: generateHistoryId(),
    timestamp: Date.now(),
    providerId: 'gemini',
    prompt: '(invalid proxy job)',
    status: 'error',
    responseText: '',
    errorCode: rejection.code,
    errorMessage: rejection.message,
    source: 'proxy',
    remoteJobId: rejection.jobId,
  };
  await saveHistoryEntry(entry).catch(() => {
    /* history write failure must not break job acknowledgement */
  });
}

/** Create the wake-up alarm only while the client is enabled. */
async function ensureLongPollAlarm(): Promise<void> {
  try {
    await wxtBrowser.alarms.create(LONG_POLL_ALARM, { periodInMinutes: LONG_POLL_ALARM_PERIOD_MINUTES });
  } catch (error) {
    console.warn('[long-poll] alarm create failed:', error);
  }
}

/** Clear the wake-up alarm when the client is disabled. */
async function clearLongPollAlarm(): Promise<void> {
  try {
    await wxtBrowser.alarms.clear(LONG_POLL_ALARM);
  } catch (error) {
    console.warn('[long-poll] alarm clear failed:', error);
  }
}

/**
 * Stop the running client and start again from the saved config.
 * A non-forced call is the alarm path: it only starts a client when the
 * current worker has none.
 */
async function applyLongPollConfig(force: boolean): Promise<void> {
  if (!force && longPollClient) return;

  let config: LongPollConfig;
  try {
    config = await loadLongPollConfig();
  } catch (error) {
    console.error('[long-poll] config read failed:', error);
    reportLongPollStatus({
      state: 'error',
      errorKind: 'config',
      message: 'Could not read long-poll settings. The previous client, if any, is still running.',
    });
    return;
  }

  const previous = longPollClient;
  if (previous) await previous.stop();
  longPollClient = undefined;
  lastLongPollStatus = '';
  lastLongPollStatusAt = 0;

  if (!config.enabled || !config.proxyUrl) {
    await clearLongPollAlarm();
    reportLongPollStatus({ state: 'disabled' });
    return;
  }

  // Only reconcile an interrupted job once the client is enabled; a disabled
  // client must not write a status or touch the lease every alarm tick.
  await reconcileLongPollLease();
  const pendingAcks = await loadPendingAckRecords(config.proxyUrl);
  await ensureLongPollAlarm();

  let started: LongPollClientHandle | undefined;
  started = startLongPollClient(
    config,
    async (request, jobId) => {
      const stored = await loadPendingAckResult(
        config.proxyUrl,
        jobId,
        requestDigest(request),
      );
      if (stored) return stored;
      return enqueueDispatch(wxtBrowser, request, { source: 'proxy', remoteJobId: jobId });
    },
    {
      onStatus: (status) => reportLongPollStatus({ ...status, proxyUrl: config.proxyUrl }),
      onJobReceived: (job, digest) => saveLongPollLease(job, digest),
      onResultReady: (ready) => persistPendingAckReady(config.proxyUrl, ready),
      onResultDelivered: (jobId) => clearPendingAck(config.proxyUrl, jobId),
      onJobRejected: (rejection) => persistProxyRejection(rejection),
      onJobFinished: (outcome) => clearLongPollLease(outcome.jobId),
      onAckFailure: async (outcome) => {
        if (outcome.ackRetryable === false) {
          await clearPendingAck(config.proxyUrl, outcome.jobId);
        } else {
          await persistPendingAckFailure(config.proxyUrl, outcome);
        }
      },
      onPendingAckExpired: (jobId) => clearPendingAck(config.proxyUrl, jobId),
      onExit: () => {
        if (longPollClient === started) longPollClient = undefined;
      },
    },
    pendingAcks,
  );
  longPollClient = started;
}

/** Queue a restart so two quick saves cannot start two clients. */
function restartLongPollClient(force = true): void {
  restartQueue = restartQueue
    .then(() => applyLongPollConfig(force))
    .catch((error) => {
      console.error('[long-poll] init failed:', error);
    });
}

export default defineBackground(() => {
  // Set the toolbar tooltip to include the build version and time.
  wxtBrowser.action.setTitle({
    title: `LLM Automation Bridge ${__BUILD_VERSION__} ${__BUILD_TIME__}`,
  });

  wxtBrowser.runtime.onMessage.addListener(
    (
      message: unknown,
      _sender: Runtime.MessageSender,
    ): Promise<AutomationRunResponse | TabListResponse | LongPollClearPendingResponse> | undefined => {
      if (isTabListRequest(message)) return handleTabList(wxtBrowser);
      if (isLongPollClearPendingRequest(message)) return handleClearLongPollPending();
      if (!isAutomationRunRequest(message)) return undefined;
      return enqueueDispatch(wxtBrowser, message);
    },
  );

  // Wake the service worker so a suspended long-poll loop can resume.
  wxtBrowser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === LONG_POLL_ALARM) restartLongPollClient(false);
  });

  // Start long-polling client if configured. Restart it when the settings change.
  watchLongPollConfig(() => restartLongPollClient());
  restartLongPollClient();
});

/** Return lightweight descriptors of all open LLM provider tabs and recent conversations. */
async function handleTabList(browserApi: BrowserLike): Promise<TabListResponse> {
  const tabs = await listAllProviderTabs(browserApi, ALL_PROVIDERS);
  const openTabs = tabs
    .filter((t): t is typeof t & { id: number } => typeof t.id === 'number')
    .map((t) => ({ tabId: t.id, title: t.title ?? t.url ?? '', url: t.url ?? '' }));

  // Build the merged conversations list: open tabs first, then history.
  const openUrls = new Set(openTabs.map((t) => t.url));
  const conversations: ConversationInfo[] = openTabs.map((t) => {
    const provider = ALL_PROVIDERS.find((p) => p.isProviderUrl(t.url));
    return {
      tabId: t.tabId,
      title: t.title,
      url: t.url,
      providerId: (provider?.id ?? 'gemini') as ConversationInfo['providerId'],
      isOpen: true,
    };
  });

  try {
    const historyConvos = await listHistoryConversations(20);
    for (const hc of historyConvos) {
      if (openUrls.has(hc.url)) continue;
      conversations.push({
        title: hc.prompt,
        url: hc.url,
        providerId: hc.providerId,
        isOpen: false,
      });
    }
  } catch {
    /* History read failure must not break the tab list response. */
  }

  return { kind: TAB_LIST_RESPONSE, tabs: openTabs, conversations };
}

/** Build a HistoryEntry from the request + response and persist it. */
async function persistHistory(
  request: AutomationRunRequest,
  providerId: LlmProviderId,
  response: AutomationRunResponse,
  conversationUrl?: string,
  options: DispatchOptions = {},
): Promise<void> {
  const entry: HistoryEntry = {
    id: generateHistoryId(),
    timestamp: Date.now(),
    providerId,
    prompt: request.prompt,
    status: response.status,
    responseText: response.status === 'ok' ? response.text : '',
    source: options.source ?? 'popup',
    ...(options.remoteJobId ? { remoteJobId: options.remoteJobId } : {}),
    ...(response.status === 'ok' && response.markdown ? { responseMarkdown: response.markdown } : {}),
    ...(response.status === 'error'
      ? { errorCode: response.error.code, errorMessage: response.error.message }
      : {}),
    ...(request.file
      ? {
          attachment: {
            name: request.file.name,
            mimeType: request.file.mimeType,
            byteLength: request.file.byteLength,
          },
        }
      : {}),
    ...(conversationUrl ? { conversationUrl } : {}),
  };
  await saveHistoryEntry(entry).catch(() => {
    /* storage write failure must not break the automation response */
  });
}

/** Retrieve the current URL of a tab, return undefined on failure. */
async function getTabUrl(browserApi: BrowserLike, tabId: number): Promise<string | undefined> {
  try {
    const tab = await browserApi.tabs.get(tabId);
    return tab.url;
  } catch {
    return undefined;
  }
}
