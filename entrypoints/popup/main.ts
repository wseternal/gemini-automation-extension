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
import { TAB_LIST_REQUEST } from '../../types/automation';
import { PopupController, type PopupTransport } from './controller';

const transport: PopupTransport = {
  run: (request: AutomationRunRequest) =>
    browser.runtime.sendMessage(request) as Promise<AutomationRunResponse>,
  openHistory: () => {
    browser.tabs.create({ url: browser.runtime.getURL('/history.html') });
  },
  listGeminiTabs: async (): Promise<TabInfo[]> => {
    const response = (await browser.runtime.sendMessage({
      kind: TAB_LIST_REQUEST,
    })) as TabListResponse;
    return [...response.tabs];
  },
};

document.addEventListener('DOMContentLoaded', () => {
  const root = document.getElementById('app');
  if (root) new PopupController(root, transport);
});
