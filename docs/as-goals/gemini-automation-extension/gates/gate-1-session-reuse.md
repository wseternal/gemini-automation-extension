# Gate: Session Reuse Without Re-Authentication

## Condition
The background orchestrator detects an existing open `https://gemini.google.com/app` tab and reuses it; it creates a new tab only when none exists. All automation messages are dispatched to that tab. No cookies, tokens, or auth endpoints are touched — the user's existing session is the only authentication context.

## Evidence Required
- [ ] Tab orchestration module → `utils/tab-manager.ts`
- [ ] Background wiring dispatching to the managed tab → `entrypoints/background.ts`
- [ ] Unit tests proving reuse-when-present vs create-when-absent and message dispatch to the resolved tab → `tests/tab-manager.test.ts` (green run)

## Verification Method
Vitest run of `tests/tab-manager.test.ts` using a fake browser; static inspection that no `cookies`/`identity` APIs appear in the orchestration path.

## Owner
Senior Software Engineer
