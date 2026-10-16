# Gate: Temporary Chat Activation & Verification

## Condition
The content script locates the "Temporary chat" control in the top-right bar, triggers it, and positively verifies the temporary state before any attachment or prompt step runs. Failure to reach the temporary state produces a typed error instead of proceeding.

## Evidence Required
- [ ] Activation module → `utils/temporary-chat.ts`
- [ ] Selector registry entries with fallbacks for the control and the active-state marker → `utils/selectors.ts`
- [ ] Unit tests: activation happy path, verification of active state, typed error on verification failure → `tests/temporary-chat.test.ts` (green run)

## Verification Method
Vitest run against a Gemini DOM fixture; assert the control receives a click, the active-state probe gates the pipeline, and the failure path surfaces `TEMP_CHAT_FAILED`.

## Owner
Senior Software Engineer
