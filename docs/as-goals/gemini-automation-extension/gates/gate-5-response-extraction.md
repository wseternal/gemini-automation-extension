# Gate: Streaming-Aware Response Extraction

## Condition
The extractor detects the streaming state (stop-generation indicator appears, then disappears) and resolves only after streaming has finished and the rendered text is stable, returning the complete response text. A bounded timeout produces a typed `STREAM_TIMEOUT` error rather than an early or hanging resolution.

## Evidence Required
- [ ] Extraction module → `utils/response-extractor.ts`
- [ ] Unit tests: resolves only after stop-indicator disappears AND text stable across polls; captures full rendered text; timeout path typed → `tests/response-extractor.test.ts` (green run)

## Verification Method
Vitest run with a scripted fake streaming DOM (text grows across polls; stop indicator lifecycle); assertions on resolution timing and returned text.

## Owner
Senior Software Engineer
