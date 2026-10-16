# Gate: Security Posture — Minimal Permissions, No Credential Access, Payload Guardrails

## Condition
(Proposed by Security Engineer.) The built manifest requests exactly `tabs`, `activeTab`, `storage` and no other permissions; host access is scoped to `https://gemini.google.com/*`. Source contains no `cookies`, `identity`, `webRequest`, or remote-network calls. File payloads are guarded by a size cap and a MIME allow-list; prompt injection into the DOM uses text-safe APIs (no innerHTML with untrusted content).

## Evidence Required
- [ ] Built manifest permissions/host diff → `.output/chrome-mv3/manifest.json`
- [ ] Static audit log (grep for forbidden APIs / remote URLs) → recorded in evidence manifest
- [ ] Payload guardrail tests → `tests/file-attachment.test.ts` (negative paths)

## Verification Method
Manifest diff + `grep -R` audit over `entrypoints/`, `utils/`, `types/`; vitest negative-path runs.

## Owner
Security Engineer (audit), Senior Software Engineer (evidence production)
