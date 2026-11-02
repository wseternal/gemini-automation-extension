/**
 * providers/deepseek.ts — DeepSeek (chat.deepseek.com) provider implementation.
 */
import type { LlmProvider, ProviderSelectors } from '../types/provider';

const SELECTORS: ProviderSelectors = {
  promptEditor: [
    'textarea[placeholder="Message DeepSeek"]',
    'textarea[name="search"]',
    'textarea.ds-scroll-area',
  ],
  sendButton: [
    '.ds-button--primary.ds-button--filled.ds-button--circle',
    'div[role="button"].ds-button--primary',
  ],
  /**
   * DeepSeek uses the SAME button for send and stop — the SVG icon changes.
   * Send: path starts with "M8.3125" (arrow icon)
   * Stop: path starts with "M2 4.88" (square icon)
   * The streaming detection uses SVG path analysis in response-extractor.
   */
  stopButton: [
    // DeepSeek uses SVG path analysis for streaming detection
    // (see response-extractor.ts#isStreaming). This selector
    // targets the button element so the extractor can read its SVG child.
    '.ds-button--primary.ds-button--filled.ds-button--circle',
  ],
  fileInput: [
    'input[type="file"]',
  ],
  attachmentChip: [
    '[class*="file-preview"]',
    '[class*="attachment"]',
    '[class*="upload-chip"]',
    '[class*="file-chip"]',
    '[aria-label*="attachment"]',
    '[aria-label*="Remove"]',
  ],
  responseContainer: [
    '.ds-assistant-message-main-content',
    '.ds-markdown.ds-assistant-message-main-content',
    '.ds-message:has(.ds-assistant-message-main-content)',
  ],
  dropZone: [
    'textarea[placeholder="Message DeepSeek"]',
    '.ds-scroll-area',
    'main',
  ],
};

export const deepseekProvider: LlmProvider = {
  id: 'deepseek',
  name: 'DeepSeek',
  urlPatterns: ['https://chat.deepseek.com/*'],
  selectors: SELECTORS,
  hasDeepThink: true,
  deepThinkToggle: [
    '.ds-toggle-button',
  ],
  fileAttachmentStrategy: 'file-input',
  streamingDetection: 'svg-path',

  isProviderUrl(url: string | undefined): boolean {
    if (!url) return false;
    try {
      const parsed = new URL(url);
      return (
        parsed.protocol === 'https:' &&
        (parsed.hostname === 'chat.deepseek.com' || parsed.hostname === 'www.deepseek.com') &&
        (parsed.pathname === '/' || parsed.pathname.startsWith('/chat'))
      );
    } catch {
      return false;
    }
  },
};
