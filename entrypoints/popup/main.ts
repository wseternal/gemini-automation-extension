/**
 * entrypoints/popup/main.ts — popup entrypoint: wire the controller to the
 * real extension messaging transport.
 */
import { browser } from 'wxt/browser';
import type { AutomationRunRequest, AutomationRunResponse } from '../../types/automation';
import { PopupController, type PopupTransport } from './controller';

const transport: PopupTransport = {
  run: (request: AutomationRunRequest) =>
    browser.runtime.sendMessage(request) as Promise<AutomationRunResponse>,
};

document.addEventListener('DOMContentLoaded', () => {
  const root = document.getElementById('app');
  if (root) new PopupController(root, transport);
});
