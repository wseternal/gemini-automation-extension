/**
 * entrypoints/content.ts — DOM interaction layer on gemini.google.com.
 *
 * Listens for typed automation requests from the background script and runs
 * the pipeline against the live page. Never touches credentials, cookies, or
 * any origin other than the page it is injected into.
 */
import { browser } from 'wxt/browser';
import type { Runtime } from 'wxt/browser';
import { defineContentScript } from 'wxt/sandbox';
import { isAutomationRunRequest, type AutomationRunResponse } from '../types/automation';
import { runAutomation } from '../utils/automation-runner';

export default defineContentScript({
  matches: ['https://gemini.google.com/*'],
  main() {
    browser.runtime.onMessage.addListener(
      (message: unknown, _sender: Runtime.MessageSender): Promise<AutomationRunResponse> | undefined => {
        if (!isAutomationRunRequest(message)) return undefined; // not ours — let other listeners see it
        // tabId is stamped by the background orchestrator (it owns tab state);
        // the content script runs in-page and reports -1 as a placeholder.
        return runAutomation(document, message, { tabId: -1 });
      },
    );
  },
});
