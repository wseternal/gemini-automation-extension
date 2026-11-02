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
    'button.send-button',
    'button[aria-label*="Send message"]',
    'button[data-mat-icon-name="send"]',
    'button[aria-label*="Send"]',
    '.send-icon',
  ],
  stopButton: [
    'button[aria-label*="Stop response"]',
    'button[aria-label*="Stop generating"]',
    'button[data-mat-icon-name="stop"]',
    'button[aria-label*="Stop"]',
  ],
  fileInput: [
    'input[type="file"][hidden]',
    'input[type="file"][aria-hidden]',
    'input[type="file"]',
  ],
  attachmentChip: [
    'uploader-file-preview',
    '.file-preview-chip',
    '.file-preview-container',
    'gem-attachment',
    '.attachment-preview-wrapper',
    '[class*="uploader-chip"]',
    '[class*="uploaded-file"]',
    '[class*="file-preview"]',
    '[class*="attachment"]',
    '[data-test-id*="attachment"]',
    '[class*="file-chip"]',
    '[class*="upload-chip"]',
    '[aria-label*="attachment"]',
    '[aria-label*="Remove file"]',
  ],
  responseContainer: [
    'message-content',
    '[data-test-id="model-response"]',
    '.model-response-text',
    '[class*="response-container"]',
    '[class*="model-response"]',
    '[class*="response-text"]',
    'div[class*="markdown"]',
    '.user-query-turn .model-response',
    'chat-message[author="model"]',
    'turn-content[data-author="model"]',
  ],
  dropZone: [
    '[xapfileselectordropzone]',
    '[file-drop-zone]',
    '.xap-uploader-dropzone',
    '.text-input-field',
    '[data-node-type="input-area"]',
    '.initial-input-area-container',
    '.input-area-container',
    '[class*="input-area"]',
    '[class*="prompt-area"]',
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
