/**
 * utils/selectors.ts — the Gemini DOM selector registry.
 *
 * Gemini ships obfuscated, frequently-changing class names. Every DOM
 * dependency of the automation pipeline is declared here ONCE, as an ordered
 * list of fallback selectors (most semantically stable first: ARIA labels and
 * roles, then structural hooks, then class heuristics). When Gemini drifts,
 * this file is the only place that should need updating.
 */
export const SELECTORS = {
  /** "Temporary chat" toggle in the top-right control bar. */
  tempChatButton: [
    'button[aria-label*="Temporary chat"]',
    'button[mattooltip*="Temporary chat"]',
    'button[data-test-id*="temp-chat"]',
    '[role="button"][aria-label*="Temporary chat"]',
  ],

  /** Markers that only exist while a Temporary Chat is active. */
  tempChatActiveMarker: [
    '[data-test-id*="temp-chat-active"]',
    '[class*="temp-chat-banner"]',
    '[class*="temporary-chat"]',
    'button[aria-label*="Temporary chat"][aria-pressed="true"]',
  ],

  /** Rich-text / contenteditable prompt container. */
  promptEditor: [
    'div.ql-editor[contenteditable="true"]',
    'rich-textarea div[contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"][aria-label]',
    '.initial-input-area-container textarea',
    '.text-input-field textarea',
    '[data-node-type="input-area"] textarea',
  ],

  /** Send control. */
  sendButton: [
    'button.send-button',
    'button[aria-label*="Send message"]',
    'button[data-mat-icon-name="send"]',
    'button[aria-label*="Send"]',
    '.send-icon',
  ],

  /** Stop-generation indicator — present only while the model streams. */
  stopButton: [
    'button[aria-label*="Stop response"]',
    'button[aria-label*="Stop generating"]',
    'button[data-mat-icon-name="stop"]',
    'button[aria-label*="Stop"]',
  ],

  /** Hidden file input behind the uploader. */
  fileInput: ['input[type="file"][hidden]', 'input[type="file"][aria-hidden]', 'input[type="file"]'],

  /** Attachment chip / preview shown once Gemini has registered an upload. */
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

  /** Rendered model response containers (latest one wins). */
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

  /** Drop target for synthesized drag-and-drop file ingestion. */
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
} as const;

export type SelectorKey = keyof typeof SELECTORS;
