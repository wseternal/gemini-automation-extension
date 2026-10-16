# Gate: Prompt Population & Submission

## Condition
The query string is placed into the rich-text `contenteditable` prompt container with proper input events, and the submission event is dispatched (send-button activation, Enter-event fallback) so generation begins.

## Evidence Required
- [ ] Prompt module → `utils/prompt.ts`
- [ ] Unit tests: editor populated, `input` events dispatched, send control clicked (or Enter fallback when send unavailable) → `tests/prompt.test.ts` (green run)

## Verification Method
Vitest run against the Gemini DOM fixture asserting DOM mutations and dispatched events.

## Owner
Senior Software Engineer
