# Gemini Automation Bridge — Agent Instructions

Project-level rules. These supplement (and never override) the global rules in `~/.agents/AGENTS.md`.

## Testing Policy

**This project enforces the global testing rules strictly. Read this section before writing or running any test.**

### Hard Rules

1. **No frontend tests.** Do not write Vitest, Jest, or any DOM-environment tests for popup, content script, or any code that interacts with the page. This includes DOM utility helpers (`dom-wait`, `prompt`, `response-extractor`, `file-attachment`, `temporary-chat`).
2. **No backend unit tests with mocks.** Do not write tests that mock browser APIs (`fakeBrowser`, `vi.fn()`, `vi.mock()`). The background script and tab manager must not be tested with mock objects.
3. **Browser e2e only with permission.** To validate extension functionality, ask the user first. Then use e2e tests in a real browser (Chrome DevTools MCP or Playwright with an extension-loaded profile).

### What May Be Tested

Only **pure business logic** with no browser or DOM dependency qualifies:

- **Messaging contract validation** — type guards (`isAutomationRunRequest`, `isAutomationRunResponse`), file payload validation, constructor functions (`ok`, `err`).
- **Data transformations** — history storage shape guards, base64 encoding.

The single surviving test file is `tests/contract.test.ts`, which covers exactly this scope.

### What Must Not Be Tested

- Popup controller or any UI rendering logic
- Content script DOM manipulation (prompt filling, response extraction, file attachment, temporary chat)
- Background dispatch or tab management (these require mocking browser APIs)
- Any utility that queries or mutates the DOM

### When a Hard Rule Blocks the Task

Stop and ask the user. Do not look for a workaround (e.g., extracting pure logic just to make it testable, or creating "integration" tests that are really unit tests in disguise).

## Project Structure

| Directory | Purpose |
|-----------|---------|
| `entrypoints/` | WXT entrypoints: `background.ts`, `content.ts`, `popup/`, `history/` |
| `utils/` | Shared logic: tab management, DOM interaction, response extraction |
| `types/` | Messaging contract and shared types |
| `tests/` | Only `contract.test.ts` (pure validation tests) |

## Build & Dev

> **Package manager: `bun`** — use `bun add`, `bun remove`, `bun install`, `bun run` for all dependency management and scripts. Do NOT use `npm`, `pnpm`, or `yarn`.

```bash
bun run dev        # watch mode — rebuilds on change
bun run build      # production build to .output/chrome-mv3
bun run check      # TypeScript type check
bun run test       # run contract tests only
```

## Commit Conventions

- Follow Conventional Commits (`feat:`, `fix:`, `refactor:`, etc.)
- See `~/.agents/rules/git.md` for full git workflow rules
