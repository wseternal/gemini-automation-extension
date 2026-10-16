import { defineContentScript } from 'wxt/sandbox';

// Stub — implemented in plan task T10.
export default defineContentScript({
  matches: ['https://gemini.google.com/*'],
  main() {
    // no-op
  },
});
