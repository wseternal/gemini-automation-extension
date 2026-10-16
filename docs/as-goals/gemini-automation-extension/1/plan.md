# Iteration 1 Plan — Gemini Automation Extension

**Architect:** System Architect · **Input:** goal + 9 frozen gates · **Date:** 2026-10-16

## Architecture

WXT (MV3) extension, strict TypeScript, three runtime contexts coordinated by one typed contract:

```
popup (trigger UI)  ──runtime.sendMessage──▶  background (tab orchestration)
                                                │ tabs.sendMessage to managed Gemini tab
                                                ▼
                                          content script (DOM automation pipeline)
                                          ensureTempChat → attachFile? → fillPrompt → submit → extract
                                                │
                                                ▼
                                     AutomationRunResponse ◀── back up the chain
```

- **`types/automation.ts`** — single source of truth: payload, request, response, error codes, type guards, limits.
- **`utils/selectors.ts`** — selector registry: every Gemini DOM dependency declared once with ordered fallbacks (`queryFirst` walks fallbacks). This is the deliberate seam for Gemini DOM drift.
- **`utils/dom-wait.ts`** — polling primitives (`waitForElement`, `waitForCondition`, `sleep`), timeout-aware.
- **One module per pipeline step** (`temporary-chat`, `file-attachment`, `prompt`, `response-extractor`), each taking `root: ParentNode` so it is fully testable against a Gemini DOM fixture.
- **`utils/automation-runner.ts`** — content-side orchestrator enforcing step order (attachment registration BEFORE submit) and mapping failures to typed error codes.
- **`utils/tab-manager.ts`** — background-side find-or-create of the Gemini tab; injectable `Browser` for tests (`wxt/testing` fakeBrowser).
- **Popup** — thin state machine (idle/running/success/error) over `runtime.sendMessage`; no mock states.
- **Test stack:** Vitest + happy-dom + `wxt/testing` (WxtVitest plugin, fakeBrowser). Gemini DOM fixture in `tests/fixtures/gemini-dom.ts`; tiny `DataTransfer`/`DragEvent` shims only if the DOM env lacks them.

## Tasks (ordered, WIP=1)

| # | Task | Files | Acceptance Criteria | Gates |
|---|------|-------|--------------------|-------|
| T1 | Scaffold WXT project, git init, install deps (wxt, typescript, vitest, happy-dom), `wxt prepare` | `package.json`, `wxt.config.ts`, `tsconfig.json`, `vitest.config.ts`, `.gitignore` | `wxt prepare` exits 0; git repo initialized | 7 (partial) |
| T2 | Messaging contract | `types/automation.ts` | Exports request/response/error-code types + guards + payload limits; strict-compiles | 6 |
| T3 | DOM wait primitives + selector registry | `utils/dom-wait.ts`, `utils/selectors.ts` | Unit tests green for polling, timeout, fallback query | 2–5 (support) |
| T4 | Tab manager (find-or-create, wait-for-load, injectable Browser) | `utils/tab-manager.ts`, `tests/tab-manager.test.ts` | Reuse-vs-create + dispatch-target tests green on fakeBrowser | 1 |
| T5 | Temporary chat activation + verification | `utils/temporary-chat.ts`, `tests/temporary-chat.test.ts` | Happy path + typed failure (`TEMP_CHAT_FAILED`) green | 2 |
| T6 | File attachment (DataTransfer drop primary, hidden-input fallback, registration waiter, size/MIME guardrails) | `utils/file-attachment.ts`, `tests/file-attachment.test.ts` | Drop carries File; fallback sets input.files; guardrail negatives green | 3, 8 |
| T7 | Prompt fill + submit (send button, Enter fallback) | `utils/prompt.ts`, `tests/prompt.test.ts` | Editor populated, input events observed, submit dispatched | 4 |
| T8 | Streaming-aware response extractor | `utils/response-extractor.ts`, `tests/response-extractor.test.ts` | Resolves only after stop-indicator gone + text stable; full text; typed timeout | 5 |
| T9 | Content orchestrator (step order, error mapping) | `utils/automation-runner.ts`, `tests/orchestrator.test.ts` | Registration-before-submit ordering proven; every failure maps to typed code | 3, 6 |
| T10 | Content entrypoint wiring | `entrypoints/content.ts` | onMessage listener guards + delegates to runner; strict-compiles | 6 |
| T11 | Background entrypoint (message router, tab dispatch, storage.session handoff) | `entrypoints/background.ts`, `tests/background.test.ts` | Router tests green; result persisted to storage.session | 1, 6 |
| T12 | Popup UI + state tests (Frontend Engineer) | `entrypoints/popup/index.html`, `entrypoints/popup/main.ts`, `entrypoints/popup/style.css`, `tests/popup.test.ts` | idle→running→success/error transitions green via fake transport | 9 |
| T13 | Strict typecheck + production build + manifest inspection | build logs, `.output/chrome-mv3/manifest.json` | `tsc --noEmit` 0 errors; `wxt build` exits 0; manifest permissions match gate 7 | 6, 7 |
| T14 | Security audit (Security Engineer): manifest diff, forbidden-API grep, payload guardrail review | audit log in evidence manifest | No forbidden APIs; permissions exactly tabs/activeTab/storage + gemini host | 8 |

## Out of Scope This Iteration
- Real-Chromium E2E against a mock Gemini origin (candidate for a later iteration if gates demand stronger evidence).
- Store packaging/signing (explicitly out of scope in the goal).

## Risks
- **Gemini DOM drift:** mitigated by the selector registry; fixtures encode the currently known DOM shapes with fallbacks.
- **Sandbox DOM gaps** (DataTransfer/DragEvent in happy-dom): shims isolated in `tests/setup.ts`, production code feature-detects.
