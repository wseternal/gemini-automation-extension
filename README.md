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
4. If the proxy requires a shared secret, enter **Proxy token**; the client sends it as `X-Bridge-Token`.
5. Click **Save**.

### Wire contract

The client calls the proxy directly from the extension service worker. All paths are relative to the configured base URL.

**Poll**

```http
GET <proxyUrl>/poll?timeout=30
X-Bridge-Token: <token>        # only when configured
```

The proxy should hold the request for up to 30 seconds. The first poll after start uses a 2-second probe hold. This confirms reachability fast before the steady 30-second poll begins. `204 No Content` means “no job”; the client waits 500 ms before polling again to avoid a hot loop.

`200 OK` returns one job:

```json
{
  "job_id": "job_123",
  "request": {
    "prompt": "Summarize the attached document",
    "provider_id": "gemini",
    "timeout_ms": 120000,
    "target_url": "https://gemini.google.com/app/...",
    "file": {
      "name": "notes.txt",
      "mime_type": "text/plain",
      "data_base64": "aGVsbG8=",
      "byte_length": 5
    }
  }
}
```

- `job_id` is required. `request` is validated before dispatch; `provider_id` must be `gemini` or `deepseek`.
- `timeout_ms` is clamped to `1..300000`.
- `target_url` must be a provider URL. The client never navigates to an arbitrary origin.
- `file` is optional and uses the same MIME/size guardrails as the popup (20 MiB cap).
- A job with a valid `job_id` but an invalid `request` is still acknowledged with an `INVALID_PAYLOAD` or `INVALID_PROVIDER` result.

**Result**

```http
POST <proxyUrl>/result
Content-Type: application/json
X-Bridge-Token: <token>        # only when configured

{
  "job_id": "job_123",
  "result": {
    "kind": "llm-automation/result",
    "status": "ok",
    "text": "...",
    "meta": { "tabId": 7, "providerId": "gemini", "durationMs": 42000, "streamingDetected": true, "steps": [] }
  }
}
```

An error result uses the same envelope: `{ "kind": "llm-automation/result", "status": "error", "error": { "code": "...", "message": "...", "step": "..." } }`.

The client requires a 2xx response. It tries up to three times (8 s per attempt, 500 ms and 1500 ms backoff) on transport errors, `408`, `429`, and `5xx`; other `4xx` responses are treated as terminal and are not retried. Before the POST, the finished result is written under `llm-automation/long-poll-failed-results` in `storage.local` — a bounded map (at most five records, scoped by `{proxyUrl, jobId}`) containing the result, a request digest, attempts, and the last attempt time. A successful POST clears the record. A retryable failure leaves it for reuse; the status dot turns amber (`degraded`) and both UIs list the pending job id and error. If the proxy later redelivers the same `job_id` with the same request digest, the client reuses the stored result instead of running the automation again. Retryable records expire after ten minutes so an old record cannot suppress a legitimate fresh run. If a restart cancels an in-flight delivery, the record stays and the client reports `client stopped before delivery`. If storage refuses to delete a record the proxy already accepted, the client keeps it visible and reports that the local cleanup failed rather than pretending it succeeded. While records are pending, the settings page offers **Clear unanswered results**, which removes only this extension's local records for the current proxy; it does not cancel or acknowledge the proxy's job.

**Trust and CORS**

- For the proxy, the manifest grants only `http://localhost:*` and `http://127.0.0.1:*`; the options page rejects other hosts, HTTPS, credentials in the URL, query strings, and fragments.
- Any local process can reach the proxy. The optional `X-Bridge-Token` is a shared secret, not authentication against remote users; keep the proxy bound to loopback.
- If the token is set, the proxy must allow the `X-Bridge-Token` request header in its CORS response (`Access-Control-Allow-Headers`) and allow `GET`/`POST` from the extension origin.
- The client rejects HTTP redirects, so a proxy cannot forward the token to another origin.
- Do not expose the proxy on a network interface without your own authentication layer.

### Status and lifecycle

The settings page and popup show:

- **Green** — polling (`polling`).
- **Amber** — connecting (`connecting`) or one or more results are unacknowledged (`degraded`).
- **Red** — transport, protocol, or settings error (`error`); the status text distinguishes the kind.
- **Grey** — disabled.
- **Grey or hollow** — no status yet, or the last report is older than 90 seconds (the worker may be suspended).

The client runs in the MV3 service worker. A 1-minute `chrome.alarms` wake-up restarts the loop after suspension; the alarm exists only while the client is enabled and is cleared when it is disabled. The waiting loop refreshes `updatedAt` every 20 seconds, including while a long response is streaming, so a healthy run stays below the 90-second stale threshold. Before dispatch, the extension persists `{ jobId, requestDigest, receivedAt }` — metadata only, never the prompt or base64 file bytes — under `llm-automation/long-poll-lease` in `storage.session`. If the worker dies mid-job, the next worker clears that lease and logs it; **the proxy must redeliver unacknowledged jobs after its own lease TTL** (for example, 90 seconds). The extension does not blindly re-dispatch a persisted job, because that could duplicate side effects. A result persisted before an unacknowledged POST is reused only when both the redelivered `job_id` and the request digest match.

`stop()` cancels the in-flight poll and the in-flight result POST, but still waits for an automation dispatch already running to finish; that job's hooks then settle before a replacement client starts. Popup and proxy runs are serialized globally in the background, and each content-script tab rejects a second concurrent run with `BUSY`.

## Architecture

| Path | Role |
|------|------|
| `wxt.config.ts` | MV3 manifest: `tabs`, `activeTab`, `storage`, `alarms` + provider/loopback host permissions |
| `types/automation.ts` | Strongly-typed messaging contract, payload guardrails (20 MiB cap, MIME allow-list) |
| `types/provider.ts` | LLM provider abstraction (selectors, URL patterns, strategies) |
| `providers/` | Provider implementations (Gemini, DeepSeek) and registry |
| `entrypoints/background.ts` | Tab orchestration (reuse-first), global run FIFO, long-poll lifecycle, lease metadata, pending-ack map, alarm |
| `entrypoints/content.ts` | On-page listener; per-tab in-flight guard; delegates to the automation pipeline |
| `entrypoints/upload-main.content.ts` | Main-world file upload bridge (bypasses CSP for paste events) |
| `entrypoints/popup/` | Trigger UI: idle → running → success/error state machine, long-poll status dot |
| `entrypoints/options/` | Bridge settings: proxy URL, optional token, enable switch, client status |
| `entrypoints/history/` | Full-page conversation history view with popup/proxy provenance |
| `utils/long-poll-protocol.ts` | Pure long-poll types, URL normalization, config/status guards, poll parser, request mapper, digest |
| `utils/long-poll-client.ts` | Background poll loop: validate, dispatch, persist-before-ack, retry/backoff, heartbeat, status |
| `utils/long-poll-config.ts` | Browser-storage access for long-poll config and status, config watcher |
| `utils/tab-manager.ts` | Find-or-create the provider tab; provider-validated target URLs |
| `utils/file-attachment.ts` | Strategy-based attachment: paste bridge, file input, drop zone |
| `utils/prompt.ts` | contenteditable fill (XSS-safe) + two-stage send-button/Enter submit |
| `utils/response-extractor.ts` | Streaming detection + stability-gated full-text capture |
| `utils/dom-to-markdown.ts` | Convert provider response DOM to structured Markdown |
| `utils/history-storage.ts` | CRUD for automation run history (capped at 200 entries) |

## Development

```bash
bun run test         # vitest: contract tests only (pure logic, no DOM/mocks)
bun run check        # strict tsc --noEmit
```

Provider markup changes over time. If a step starts failing against the live page, update the fallback selectors in `providers/<name>.ts` — everything else is decoupled from the DOM.
