# Gemini Automation Bridge

A Manifest V3 Chrome extension (built with [WXT](https://wxt.dev) + strict TypeScript) that runs an **unattended Gemini Temporary Chat round** inside your existing authenticated browser session:

1. Finds your already-open `https://gemini.google.com/app` tab (opens one only if none exists) — **no login flow is ever triggered**.
2. Switches the chat to **Temporary Chat** mode and verifies the state.
3. Attaches an optional file (PDF, image, text, …) via a synthesized native drag-and-drop `DataTransfer` event (hidden file-input fallback) — and **waits until Gemini registers the attachment** before continuing.
4. Types your prompt into the rich-text editor and submits it.
5. Detects streaming (stop-generation indicator), and returns the **complete response text only after streaming has finished**.

## Build & Load

```bash
npm install
npm run build        # or: node node_modules/wxt/bin/wxt.mjs build
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `.output/chrome-mv3/`.

## Use

1. Make sure you're signed in to Gemini in some tab (the extension never authenticates you itself).
2. Click the extension action (puzzle-piece menu → *Gemini Automation Bridge*).
3. Enter a prompt, optionally pick a file, press **Run in Gemini**.
4. The popup shows progress, then the full response text (with a Copy button), or a typed error (e.g. `TEMP_CHAT_FAILED`, `STREAM_TIMEOUT`) with a Retry button.

Programmatic trigger (e.g. from another extension or the console of the extension's background page):

```ts
const response = await chrome.runtime.sendMessage({
  kind: 'gemini-automation/run',
  prompt: 'Summarize the attached document',
  file: { name: 'notes.txt', mimeType: 'text/plain', dataBase64: 'aGVsbG8=', byteLength: 5 }, // optional
  // timeoutMs: 120_000, // optional streaming budget
});
// response: { kind: 'gemini-automation/result', status: 'ok' | 'error', ... }
```

The full message protocol lives in **`types/automation.ts`** — request shape, response shape, and every error code.

## Architecture

| Path | Role |
|------|------|
| `wxt.config.ts` | MV3 manifest: `tabs`, `activeTab`, `storage` + `https://gemini.google.com/*` host only |
| `types/automation.ts` | Strongly-typed messaging contract, payload guardrails (20 MiB cap, MIME allow-list) |
| `entrypoints/background.ts` | Tab orchestration (reuse-first), dispatch, one-shot reload-retry, `storage.session` hand-off |
| `entrypoints/content.ts` | On-page listener; delegates to the automation pipeline |
| `entrypoints/popup/` | Trigger UI: idle → running → success/error state machine |
| `utils/tab-manager.ts` | Find-or-create the Gemini tab; code-side URL matching |
| `utils/temporary-chat.ts` | Temporary-chat activation + positive state verification |
| `utils/file-attachment.ts` | `DataTransfer` drop synthesis, hidden-input fallback, registration waiter |
| `utils/prompt.ts` | contenteditable fill (XSS-safe) + submit (send button / Enter fallback) |
| `utils/response-extractor.ts` | Streaming detection + stability-gated full-text capture |
| `utils/selectors.ts` | **All** Gemini DOM selectors, with ordered fallbacks — the single place to update when Gemini's DOM drifts |

## Development

```bash
npm run test         # vitest: 79 unit/integration tests (happy-dom + fake browser)
npm run check        # strict tsc --noEmit
```

Gemini's markup is obfuscated and changes over time. If a step starts failing against the live page, update the fallback lists in `utils/selectors.ts` — everything else is decoupled from the DOM.
