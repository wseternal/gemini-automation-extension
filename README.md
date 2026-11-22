# LLM Automation Bridge

A Manifest V3 Chrome extension (built with [WXT](https://wxt.dev) + strict TypeScript) that runs **unattended LLM automation rounds** (Gemini, DeepSeek) inside your existing authenticated browser session:

1. Finds your already-open provider tab (or opens one in the background) — **no login flow is ever triggered**.
2. Activates DeepThink mode for providers that require it (e.g., DeepSeek).
3. Attaches an optional file (PDF, image, text, …) via a provider-appropriate strategy (main-world paste bridge, file input, or drop zone) — and **waits until the provider registers the attachment** before continuing.
4. Types your prompt into the rich-text editor and submits it.
5. Detects streaming (stop-generation indicator or SVG path analysis), and returns the **complete response text only after streaming has finished**.
6. Persists the run to conversation history for later review.

## Build & Load

```bash
bun install
bun run build        # or: node node_modules/wxt/bin/wxt.mjs build
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `.output/chrome-mv3/`.

## Use

1. Make sure you're signed in to your LLM provider (Gemini or DeepSeek) in some tab (the extension never authenticates you itself).
2. Click the extension action (puzzle-piece menu → *LLM Automation Bridge*).
3. Select your provider, choose an open conversation or start new, enter a prompt, optionally pick a file, press **Run**.
4. The popup shows progress, then the full response text (with a Copy button), or a typed error (e.g. `STREAM_TIMEOUT`, `ATTACH_FAILED`) with a Retry button.

Programmatic trigger (e.g. from another extension or the console of the extension's background page):

```ts
const response = await chrome.runtime.sendMessage({
  kind: 'llm-automation/run',
  prompt: 'Summarize the attached document',
  providerId: 'gemini', // or 'deepseek'
  file: { name: 'notes.txt', mimeType: 'text/plain', dataBase64: 'aGVsbG8=', byteLength: 5 }, // optional
  // timeoutMs: 120_000, // optional streaming budget
});
// response: { kind: 'llm-automation/result', status: 'ok' | 'error', ... }
```

The full message protocol lives in **`types/automation.ts`** — request shape, response shape, and every error code.

## Long-polling Proxy

The extension can accept automation jobs from a local proxy server.

1. Click the extension action. Click **Bridge settings**.
2. Select **Enable long-polling client**.
3. Set **Proxy URL** to the proxy base URL, for example `http://localhost:9090`.
4. Click **Save**.

The client polls `<proxyUrl>/poll` and posts each result to `<proxyUrl>/result`. The settings page shows the client state: active, disabled, or a connection error.

The popup title shows a status dot. A green dot means active. A red dot means an error. A grey dot means the client is off. A hollow dot means no status yet. Hover the dot to show the state in a tooltip.

The manifest grants `http://localhost:*` and `http://127.0.0.1:*` only. The options page accepts no other host.

The browser can suspend the background service worker. The client starts again when the service worker starts.

## Architecture

| Path | Role |
|------|------|
| `wxt.config.ts` | MV3 manifest: `tabs`, `activeTab`, `storage` + provider host permissions |
| `types/automation.ts` | Strongly-typed messaging contract, payload guardrails (20 MiB cap, MIME allow-list) |
| `types/provider.ts` | LLM provider abstraction (selectors, URL patterns, strategies) |
| `providers/` | Provider implementations (Gemini, DeepSeek) and registry |
| `entrypoints/background.ts` | Tab orchestration (reuse-first), dispatch, one-shot reload-retry, `storage.session` hand-off |
| `entrypoints/content.ts` | On-page listener; delegates to the automation pipeline |
| `entrypoints/upload-main.content.ts` | Main-world file upload bridge (bypasses CSP for paste events) |
| `entrypoints/popup/` | Trigger UI: idle → running → success/error state machine |
| `entrypoints/options/` | Bridge settings: proxy URL, enable switch, client status |
| `entrypoints/history/` | Full-page conversation history view |
| `utils/long-poll-client.ts` | Background poll loop: fetch jobs, dispatch, post results, backoff |
| `utils/long-poll-config.ts` | Long-poll settings, URL validation, and runtime status |
| `utils/tab-manager.ts` | Find-or-create the provider tab; code-side URL matching |
| `utils/file-attachment.ts` | Strategy-based attachment: paste bridge, file input, drop zone |
| `utils/prompt.ts` | contenteditable fill (XSS-safe) + submit (send button / Enter fallback) |
| `utils/response-extractor.ts` | Streaming detection + stability-gated full-text capture |
| `utils/dom-to-markdown.ts` | Convert provider response DOM to structured Markdown |
| `utils/history-storage.ts` | CRUD for automation run history (capped at 200 entries) |

## Development

```bash
bun run test         # vitest: contract tests only (pure logic, no DOM/mocks)
bun run check        # strict tsc --noEmit
```

Provider markup changes over time. If a step starts failing against the live page, update the fallback selectors in `providers/<name>.ts` — everything else is decoupled from the DOM.
