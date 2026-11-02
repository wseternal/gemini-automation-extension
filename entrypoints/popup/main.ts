/**
 * entrypoints/popup/main.ts — popup entrypoint: wire the controller to the
 * real extension messaging transport.
 */
import { browser } from 'wxt/browser';
import type {
  AutomationRunRequest,
  AutomationRunResponse,
  TabInfo,
  TabListResponse,
} from '../../types/automation';
import { isAutomationRunResponse, TAB_LIST_REQUEST } from '../../types/automation';
import type { LlmProviderId } from '../../types/provider';
import { PopupController, type PopupTransport } from './controller';

const PROVIDER_STORAGE_KEY = 'llm-automation/selected-provider';
const LAST_RESULT_KEY = 'llm-automation/last-result' as const;

const transport: PopupTransport = {
  run: (request: AutomationRunRequest) =>
    browser.runtime.sendMessage(request) as Promise<AutomationRunResponse>,
  openHistory: () => {
    browser.tabs.create({ url: browser.runtime.getURL('/history.html') });
  },
  listTabs: async (): Promise<TabInfo[]> => {
    const response = (await browser.runtime.sendMessage({
      kind: TAB_LIST_REQUEST,
    })) as TabListResponse;
    return [...response.tabs];
  },
  getSelectedProvider: async (): Promise<LlmProviderId> => {
    const result = await browser.storage.local.get(PROVIDER_STORAGE_KEY);
    const value = result[PROVIDER_STORAGE_KEY];
    if (value === 'gemini' || value === 'deepseek') return value;
    return 'gemini'; // Default
  },
  setSelectedProvider: async (id: LlmProviderId): Promise<void> => {
    await browser.storage.local.set({ [PROVIDER_STORAGE_KEY]: id });
  },
  getLastResult: async (): Promise<AutomationRunResponse | undefined> => {
    const result = await browser.storage.session.get(LAST_RESULT_KEY);
    const stored = result[LAST_RESULT_KEY];
    if (isAutomationRunResponse(stored)) {
      // Clear after recovery to prevent stale display on next reopen.
      await browser.storage.session.remove(LAST_RESULT_KEY);
      return stored;
    }
    return undefined;
  },
};

document.addEventListener('DOMContentLoaded', () => {
  const root = document.getElementById('app');
  if (!root) return;
  const controller = new PopupController(root, transport);
  // Recover in-flight result if popup was closed during a run.
  void controller.recoverLastResult();
});
