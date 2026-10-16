# Gate: Popup Trigger Flow With Real Stateful UX

## Condition
The action popup lets the user enter a prompt, optionally pick a file, and start the automation; it renders running progress and terminal success (response text + copy) / error (typed error + retry) states driven by the real messaging round-trip with the background script — no mock states.

## Evidence Required
- [ ] Popup entrypoint → `entrypoints/popup/index.html`, `entrypoints/popup/main.ts`, `entrypoints/popup/style.css`
- [ ] State-machine tests for idle → running → success/error driven by a fake messaging transport → `tests/popup.test.ts` (green run)

## Verification Method
Vitest run of popup state tests; static check that popup imports the shared contract and uses `runtime.sendMessage`.

## Owner
Frontend Engineer
