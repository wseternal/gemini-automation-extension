/**
 * providers/gemini.ts — Gemini (gemini.google.com) provider implementation.
 */
import type { LlmProvider, ProviderSelectors } from '../types/provider';

const SELECTORS: ProviderSelectors = {
  promptEditor: [
    'div.ql-editor[contenteditable="true"]',
    'rich-textarea div[contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"][aria-label]',
    '.initial-input-area-container textarea',
    '.text-input-field textarea',
    '[data-node-type="input-area"] textarea',
  ],
  sendButton: [
    'button[aria-label="Send message"]',
    'button[aria-label*="Send message"]',
    '[data-test-id="send-button-container"] button',
    'button[aria-label*="Send"]',
    'gem-icon-button.send-button.submit button',
  ],
  stopButton: [
    'button[aria-label="Stop response"]',
    'button[aria-label*="Stop response"]',
    'gem-icon-button.send-button.stop button',
    'button[aria-label*="Stop generating"]',
    'button[aria-label*="Stop"]',
  ],
  fileInput: [
    'images-files-uploader input[type="file"]',
    'input[type="file"].hidden-file-input',
    'input[type="file"][hidden]',
    'input[type="file"][aria-hidden]',
    'input[type="file"]',
  ],
  attachmentChip: [
    'gem-attachment',
    'uploader-file-preview',
    '.file-preview-chip',
    '.file-preview-container',
    '.attachment-preview-wrapper',
    '[data-test-id*="attachment"]',
    '[aria-label*="Remove file"]',
    '[aria-label*="attachment"]',
  ],
  responseContainer: [
    '.markdown-main-panel',
    'message-content[id^="message-content-id-"]',
    'message-content',
    '.model-response-text',
    'model-response .response-container',
    '.user-query-turn .model-response',
  ],
  dropZone: [
    '[xapfileselectordropzone]',
    '.text-input-field.simplified-input-area',
    '[file-drop-zone]',
    '.initial-input-area-container',
    '.input-area-container',
    'main',
  ],
};

export const geminiProvider: LlmProvider = {
  id: 'gemini',
  name: 'Google Gemini',
  urlPatterns: ['https://gemini.google.com/*'],
  selectors: SELECTORS,
  hasDeepThink: false,
  fileAttachmentStrategy: 'paste-bridge',
  streamingDetection: 'dom',

  isProviderUrl(url: string | undefined): boolean {
    if (!url) return false;
    try {
      const parsed = new URL(url);
      return (
        parsed.protocol === 'https:' &&
        parsed.hostname === 'gemini.google.com' &&
        (parsed.pathname === '/app' || parsed.pathname.startsWith('/app/'))
      );
    } catch {
      return false;
    }
  },
};
