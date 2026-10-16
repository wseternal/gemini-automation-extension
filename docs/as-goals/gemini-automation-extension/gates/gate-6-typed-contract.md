# Gate: Strongly-Typed Messaging Contract & Strict TypeScript

## Condition
`types/automation.ts` defines the full request/response protocol (file payload, prompt, status, typed error codes) and is the single source imported by background, content script, and popup. The entire codebase compiles under strict TypeScript with zero errors.

## Evidence Required
- [ ] Contract module → `types/automation.ts`
- [ ] Imports of the contract in `entrypoints/background.ts`, `entrypoints/content.ts`, `entrypoints/popup/main.ts`
- [ ] `tsc --noEmit` (strict) output with 0 errors → build log artifact

## Verification Method
Run `tsc --noEmit` on the WXT-generated tsconfig; grep entrypoints for contract imports.

## Owner
Senior Software Engineer
