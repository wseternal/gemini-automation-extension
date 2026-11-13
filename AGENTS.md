# LLM Automation Bridge — Agent Instructions

Project-level rules. These supplement (and never override) the global rules in `~/.agents/AGENTS.md`.

## Testing Policy

**This project enforces the global testing rules in `~/.agents/rules/testing.md` strictly. Read both that file and this section before writing or running any test.**

### Hard Rules

1. **Default to zero tests.** Do not create or update test files unless the user explicitly asked for tests, or you are writing a pure, non-I/O algorithmic function (e.g. parsers, data transformations) where edge cases must be proven. Test code is technical debt; never add it simply to demonstrate that code works.
2. **Never change production code for tests.** Do not add hooks, wrappers, interfaces, dependency injection, or override points solely to support tests. A test request never permits a production-code change.
3. **No frontend tests.** Do not write Vitest, Jest, or any DOM-environment tests for popup, content script, or any code that interacts with the page. This includes DOM utility helpers (`dom-wait`, `prompt`, `response-extractor`, `file-attachment`, `temporary-chat`).
4. **No backend unit tests with mocks.** Do not write tests that mock browser APIs (`fakeBrowser`, `vi.fn()`, `vi.mock()`), databases, ORMs, or network layers. The background script and tab manager must not be tested with mock objects.
5. **No snapshot or tautology tests.** Do not write snapshot tests (`toMatchSnapshot`) or tests that merely assert framework behavior, type interfaces, or basic getters/setters.
6. **Browser e2e only with permission.** To validate extension functionality, ask the user first. Then use e2e tests in a real browser (Chrome DevTools MCP or Playwright with an extension-loaded profile).

### What May Be Tested

Only **pure business logic** with no browser or DOM dependency qualifies:

- **Messaging contract validation** — type guards (`isAutomationRunRequest`, `isAutomationRunResponse`), file payload validation, constructor functions (`ok`, `err`).
- **Data transformations** — history storage shape guards, base64 encoding.
- **Pure string utilities** — `escapeMarkdown`, `cleanOutput` (markdown/whitespace transformations with no I/O).

Test files live in `tests/`. Currently `tests/contract.test.ts` covers the messaging contract, `escapeMarkdown`, and `cleanOutput`.

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
| `entrypoints/` | WXT entrypoints: `background.ts`, `content.ts`, `upload-main.content.ts`, `popup/`, `history/` |
| `providers/` | LLM provider implementations (Gemini, DeepSeek) and registry |
| `utils/` | Shared logic: tab management, DOM interaction, response extraction, history storage |
| `types/` | Messaging contract (`automation.ts`) and provider interface (`provider.ts`) |
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
