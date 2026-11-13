import { execSync } from 'node:child_process';
import { defineConfig } from 'wxt';

// Build-time constants injected via Vite `define`.
// Available as globals in all entrypoints: __BUILD_VERSION__, __BUILD_TIME__.
const BUILD_VERSION = execSync('git describe --always --dirty --tags', { encoding: 'utf-8' }).trim();
const BUILD_TIME = new Date().toISOString().replace('T', ' ').replace(/:\d{2}\.\d{3}Z$/, 'Z');

// Manifest V3 configuration for the LLM automation bridge.
// Permissions are deliberately minimal (see security gate):
//   - tabs:      locate / create the LLM provider tab
//   - activeTab: interact with the active LLM tab when the user invokes the action
//   - storage:   hand off the latest automation result via storage.session
//   - host:      LLM provider URLs only — the automation surface
export default defineConfig({
  vite: () => ({
    define: {
      __BUILD_VERSION__: JSON.stringify(BUILD_VERSION),
      __BUILD_TIME__: JSON.stringify(BUILD_TIME),
    },
  }),
  runner: {
    chromiumArgs: [
      // Use your real Chrome profile so Web Store extensions are available.
      // Close Chrome first to avoid profile-lock conflicts.
      // '--user-data-dir=/Users/jiangzhaohua/Library/Application Support/Google/Chrome',
    ],
  },
  manifest: {
    name: 'LLM Automation Bridge',
    short_name: 'LLMBridge',
    description:
      'Runs unattended LLM automation (file + prompt) inside your existing authenticated session and returns the response. Supports Gemini and DeepSeek.',
    permissions: ['tabs', 'activeTab', 'storage'],
    host_permissions: ['https://gemini.google.com/*', 'https://chat.deepseek.com/*'],
  },
});
