# Gate: File Attachment Ingestion Registered Before Submit

## Condition
A file payload supplied to the extension is materialized as a `File`, delivered to Gemini's prompt area via a synthesized drag-and-drop `DataTransfer` sequence (primary) or the hidden file input (fallback), and the pipeline blocks submission until the attachment is confirmed registered (attachment chip/preview present in the DOM).

## Evidence Required
- [ ] Attachment module with DataTransfer synthesis + input fallback + registration waiter → `utils/file-attachment.ts`
- [ ] Unit tests: drop event carries the File; fallback path sets input.files; submit is blocked until registration confirmed; oversize/disallowed payloads rejected → `tests/file-attachment.test.ts` (green run)
- [ ] Ordering proof (registration precedes submission) inside the orchestrator test → `tests/orchestrator.test.ts`

## Verification Method
Vitest runs; event-capture assertions on the drop target; negative-path assertions for guardrails.

## Owner
Senior Software Engineer
