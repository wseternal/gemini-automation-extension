import { defineConfig } from 'wxt';

// Manifest V3 configuration for the Gemini automation bridge.
// Permissions are deliberately minimal (see security gate):
//   - tabs:      locate / create the Gemini tab
//   - activeTab: interact with the active Gemini tab when the user invokes the action
//   - storage:   hand off the latest automation result via storage.session
//   - host:      https://gemini.google.com/* only — the automation surface
export default defineConfig({
  runner: {
    chromiumArgs: [
      // Use your real Chrome profile so Web Store extensions are available.
      // Close Chrome first to avoid profile-lock conflicts.
      // '--user-data-dir=/Users/jiangzhaohua/Library/Application Support/Google/Chrome',
    ],
  },
  manifest: {
    name: 'Gemini Automation Bridge',
    short_name: 'GeminiBridge',
    description:
      'Runs an unattended Gemini Temporary Chat round (file + prompt) inside your existing authenticated session and returns the response.',
    permissions: ['tabs', 'activeTab', 'storage'],
    host_permissions: ['https://gemini.google.com/*'],
  },
});
