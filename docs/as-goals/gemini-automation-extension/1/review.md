# Review — Iteration 1

**Reviewer:** System Test Engineer · **Joined by:** Security Engineer
**Commits reviewed:** 0bdb79c, bd8a256, 8b4bbb5, d9dcdc9, 5442526, 3542ff7, a37672a, 50e7e52, 7509d49

## Summary

The implementation delivers every planned module behind a single typed contract, with the selector-registry seam for Gemini DOM drift as planned. Full suite: **79/79 green**, strict `tsc --noEmit`: **0 errors**, `wxt build`: **clean** (57.89 kB bundle), MV3 manifest verified programmatically.

## Verification Boundary (explicit)

Gates are verified against a faithful Gemini DOM fixture (`tests/fixtures/gemini-dom.ts`) and the `wxt/testing` fake browser — the sandbox has no authenticated Google session, so live-DOM execution is out of verification reach. The architecture compensates: every DOM dependency is centralized in `utils/selectors.ts` with ordered fallbacks, which is itself tested. This boundary is accepted for gate evidence; live smoke-testing is listed under Follow-ups.

## Findings

### Critical
None.

### Warning
- **W1 — Reload-retry resets page state.** `entrypoints/background.ts` reloads the Gemini tab once when the content script is disconnected (tab predates extension install). A reload abandons any in-progress Gemini conversation on that tab. Accepted: it fires only when dispatch is otherwise impossible, and no narrower recovery exists within the frozen permission set.
- **W2 — Content script reports `tabId: -1`.** The real tab id is stamped by the background (`withTabId`). Works and tested, but a reader could miss the hand-off; documented in both files.
- **W3 — Popup has no step-level progress.** The running state is indeterminate; the contract carries no progress channel. Out of scope for the goal; noted as a possible enhancement.

### Suggestion
- **S1 —** Consider surfacing `timeoutMs` in the popup for very large files / slow connections.
- **S2 —** `tempChatActiveMarker` fallbacks lean on class heuristics; prefer ARIA/state probes first when Gemini's DOM stabilizes.

## Security Review (Security Engineer)

- Manifest permissions exactly `tabs`, `activeTab`, `storage`; host access `https://gemini.google.com/*` only — matches gate 8. Evidence: `logs/security-audit.log` §5.
- No `cookies` / `identity` / `webRequest` usage; zero network egress calls (`fetch`/XHR/WebSocket/EventSource) anywhere in `entrypoints/`, `utils/`, `types/`. Evidence: `logs/security-audit.log` §1–2.
- `innerHTML` appears exactly once, bound to a fully static popup template; user-controlled text is always assigned via `textContent` (verified in `tests/prompt.test.ts` hostile-markup case). Evidence: `logs/security-audit.log` §3.
- File payload guardrails (20 MiB cap, MIME allow-list, base64 + byteLength cross-validation) enforced client-side in the popup AND content-side in `decodeFilePayload`; negative paths tested. Evidence: `tests/contract.test.ts`, `tests/file-attachment.test.ts`, `tests/popup.test.ts`.
- Result hand-off uses `storage.session` (in-memory, non-synced) — appropriate for transient results.

## Commits Reviewed
- `0bdb79c` chore: scaffold wxt mv3 project config
- `bd8a256` chore: wxt entrypoint stubs + generated tsconfig
- `8b4bbb5` feat: typed automation messaging contract with guards and payload guardrails
- `d9dcdc9` feat: selector registry with ordered fallbacks + dom-wait polling primitives
- `5442526` feat: tab manager with code-side URL matching + temporary chat activation
- `3542ff7` feat: file attachment via synthesized DataTransfer drop with input fallback and guardrails
- `a37672a` feat: prompt fill/submit + streaming-aware response extractor
- `50e7e52` feat: content-side automation orchestrator with ordered steps and typed error mapping
- `7509d49` feat: entrypoints (background/content/popup) with typed dispatch, reload-retry, and stateful popup UI
