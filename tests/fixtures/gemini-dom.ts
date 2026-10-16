/**
 * tests/fixtures/gemini-dom.ts — a faithful-enough Gemini /app DOM fixture.
 *
 * Mirrors the structural hooks the selector registry targets: top-right
 * temporary-chat control, rich-text contenteditable prompt, send/stop
 * buttons, hidden file input, attachment chips, and response containers.
 * Streaming is scripted (chunked text growth + stop-button lifecycle).
 */
import { sleep } from '../../utils/dom-wait';

export interface GeminiFixture {
  root: HTMLElement;
  tempChatButton: HTMLButtonElement;
  editor: HTMLElement;
  sendButton: HTMLButtonElement;
  fileInput: HTMLInputElement;
  main: HTMLElement;
  /** Number of times the temp-chat button was clicked. */
  tempChatClicks: () => number;
  /** Simulate the app entering temporary-chat state (banner appears). */
  activateTempChat: () => void;
  /** Simulate Gemini registering an attachment (chip appears in the input area). */
  registerAttachment: (name?: string) => void;
  /** Drive a fake streaming response; resolves when streaming ends. */
  streamResponse: (chunks: readonly string[], opts?: { intervalMs?: number; withStopButton?: boolean }) => Promise<void>;
  stopButton: () => HTMLElement | null;
}

export interface GeminiFixtureOptions {
  /** Start with temporary chat already active. */
  tempChatActive?: boolean;
  /** Wire the temp-chat button so clicking it activates the state (default true). */
  buttonActivates?: boolean;
  /** Include a hidden file input (default true). */
  withFileInput?: boolean;
}

export function mountGeminiFixture(options: GeminiFixtureOptions = {}): GeminiFixture {
  const { tempChatActive = false, buttonActivates = true, withFileInput = true } = options;

  document.body.innerHTML = `
    <div class="top-bar">
      <button class="avatar" aria-label="Account"></button>
      <button class="temp-chat" aria-label="Temporary chat"></button>
    </div>
    <div class="input-area">
      <div class="ql-editor" contenteditable="true" role="textbox" aria-label="Enter a prompt here"></div>
      <button class="send-button" aria-label="Send message"></button>
      ${withFileInput ? '<input type="file" hidden />' : ''}
    </div>
    <main></main>
  `;

  const root = document.body;
  const tempChatButton = root.querySelector<HTMLButtonElement>('button.temp-chat')!;
  const editor = root.querySelector<HTMLElement>('.ql-editor')!;
  const sendButton = root.querySelector<HTMLButtonElement>('.send-button')!;
  const fileInput = root.querySelector<HTMLInputElement>('input[type="file"]')!;
  const main = root.querySelector<HTMLElement>('main')!;

  let clicks = 0;

  const activateTempChat = () => {
    tempChatButton.setAttribute('aria-pressed', 'true');
    const banner = document.createElement('div');
    banner.className = 'temp-chat-banner';
    banner.setAttribute('data-test-id', 'temp-chat-active');
    banner.textContent = 'Temporary Chat';
    root.prepend(banner);
  };

  tempChatButton.addEventListener('click', () => {
    clicks += 1;
    if (buttonActivates) activateTempChat();
  });

  if (tempChatActive) activateTempChat();

  const registerAttachment = (name = 'a.pdf') => {
    const chip = document.createElement('div');
    chip.className = 'uploader-chip';
    chip.textContent = name;
    root.querySelector('.input-area')!.prepend(chip);
  };

  const stopButton = () => root.querySelector<HTMLElement>('button[aria-label*="Stop"]');

  const streamResponse = async (
    chunks: readonly string[],
    opts: { intervalMs?: number; withStopButton?: boolean } = {},
  ): Promise<void> => {
    const { intervalMs = 15, withStopButton = true } = opts;
    let stop: HTMLButtonElement | null = null;
    if (withStopButton) {
      stop = document.createElement('button');
      stop.setAttribute('aria-label', 'Stop response');
      root.querySelector('.input-area')!.appendChild(stop);
    }
    const container = document.createElement('div');
    container.className = 'model-response-text';
    main.appendChild(container);
    let text = '';
    for (const chunk of chunks) {
      text += chunk;
      container.textContent = text;
      await sleep(intervalMs);
    }
    stop?.remove();
  };

  return {
    root,
    tempChatButton,
    editor,
    sendButton,
    fileInput,
    main,
    tempChatClicks: () => clicks,
    activateTempChat,
    registerAttachment,
    streamResponse,
    stopButton,
  };
}
