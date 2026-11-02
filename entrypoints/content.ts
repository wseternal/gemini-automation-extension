/**
 * entrypoints/content.ts — DOM interaction layer for LLM providers.
 *
 * Listens for typed automation requests from the background script and runs
 * the pipeline against the live page. Never touches credentials, cookies, or
 * any origin other than the page it is injected into.
 */
import { browser } from 'wxt/browser';
import type { Runtime } from 'wxt/browser';
import { defineContentScript } from 'wxt/sandbox';
import { isAutomationRunRequest, type AutomationRunResponse } from '../types/automation';
import { getProviderByUrl } from '../providers';
import { runAutomation } from '../utils/automation-runner';

// Maintenance: when adding a new provider, update this `matches` array
// AND the provider's `isProviderUrl()` AND the upload-main.content.ts
// `matches` array to keep content-script injection aligned.
export default defineContentScript({
  matches: ['https://gemini.google.com/*', 'https://chat.deepseek.com/*'],
  main() {
    browser.runtime.onMessage.addListener(
      (message: unknown, _sender: Runtime.MessageSender): Promise<AutomationRunResponse> | undefined => {
        if (!isAutomationRunRequest(message)) return undefined; // not ours — let other listeners see it

        // Detect provider from current page URL.
        const provider = getProviderByUrl(window.location.href);
        if (!provider) {
          console.warn('[LLM-Bridge] No provider matched current URL:', window.location.href);
          return undefined;
        }

        // tabId is stamped by the background orchestrator (it owns tab state);
        // the content script runs in-page and reports -1 as a placeholder.
        return runAutomation(document, message, { tabId: -1, provider });
      },
    );
  },
});
