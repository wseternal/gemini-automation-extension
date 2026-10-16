# Gemini Automation Extension

## Goal
A user with an authenticated Gemini browser session can, from a browser-extension trigger, run an unattended Gemini Temporary Chat round — optional file attachment plus a text prompt — and receive the complete generated response back, without any login challenge or manual interaction with the Gemini page.

## Context
- Target platform: Manifest V3 Chrome extension built with the WXT framework in strict TypeScript.
- Gemini is a live, authenticated Google surface (`https://gemini.google.com/app`). Its DOM is obfuscated and changes over time, so DOM coupling must be isolated behind a selector registry with fallbacks.
- Nothing exists yet: no project scaffold, no extension code, no messaging contract.
- The extension must operate entirely inside the user's existing browser context; it must never attempt to authenticate, harvest cookies, or call Google APIs directly.

## Success Criteria
1. An open `gemini.google.com/app` tab is detected and reused; a new tab is opened only when none exists, and all automation runs inside that tab's existing authenticated session.
2. "Temporary chat" mode is activated from the top-right control bar and its active state is verified before anything else proceeds.
3. A file payload (PDF, image, text, …) handed to the extension is attached to the prompt bar — via a synthesized drag-and-drop `DataTransfer` event or the underlying hidden file input — and the attachment is confirmed registered by Gemini before submission.
4. A given query string is placed into the rich-text / `contenteditable` prompt container and the submission event is dispatched so generation begins.
5. The streaming state is detected (stop-generation indicator appears then disappears) and the complete rendered response text is returned only after token streaming has finished.
6. All cross-context coordination (background ↔ content ↔ popup) uses a strongly-typed message protocol; the whole codebase passes strict TypeScript compilation and the WXT production build succeeds.

## Constraints
- Manifest V3, WXT framework, strict TypeScript, WXT-idiomatic entrypoints (`wxt.config.ts`, `entrypoints/background.ts`, `entrypoints/content.ts`, `types/automation.ts`).
- Permissions limited to `tabs`, `activeTab`, `storage` and host permission for `https://gemini.google.com/*` only.
- No credentials, cookies, or tokens may be read, stored, or transmitted; no data leaves the browser except the response text returned to the extension caller.
- Automation must not trigger Google login challenges: reuse the existing tab/session, never navigate to auth endpoints.

## Out of Scope
- Automating any Google property other than the Gemini web app.
- Persistent chat history, multi-turn conversations, or model selection UI.
- Publishing to the Chrome Web Store or any store-signing pipeline.
- A backend server or any data persistence beyond transient extension storage for handoff of the latest result.

## Created
2026-10-16T19:46:00Z
