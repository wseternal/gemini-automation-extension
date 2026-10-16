import { describe, expect, it } from 'vitest';
import { ensureTemporaryChat, isTemporaryChatActive } from '../utils/temporary-chat';
import { mountGeminiFixture } from './fixtures/gemini-dom';

describe('temporary chat activation', () => {
  it('clicks the top-right control and verifies the active state', async () => {
    const fx = mountGeminiFixture();
    await ensureTemporaryChat(document, { timeoutMs: 1_000, intervalMs: 5 });
    expect(fx.tempChatClicks()).toBe(1);
    expect(isTemporaryChatActive(document)).toBe(true);
  });

  it('is idempotent when temporary chat is already active', async () => {
    const fx = mountGeminiFixture({ tempChatActive: true });
    await ensureTemporaryChat(document, { timeoutMs: 1_000, intervalMs: 5 });
    expect(fx.tempChatClicks()).toBe(0);
  });

  it('detects the active state from banner text alone', () => {
    document.body.innerHTML = '<main><div><span>Temporary Chat</span></div></main>';
    expect(isTemporaryChatActive(document)).toBe(true);
  });

  it('does not false-positive on unrelated text', () => {
    document.body.innerHTML = '<main><div><span>Chat with Gemini about anything at all</span></div></main>';
    expect(isTemporaryChatActive(document)).toBe(false);
  });

  it('fails with TEMP_CHAT_FAILED when the state never activates', async () => {
    mountGeminiFixture({ buttonActivates: false });
    await expect(ensureTemporaryChat(document, { timeoutMs: 60, intervalMs: 5 })).rejects.toMatchObject({
      code: 'TEMP_CHAT_FAILED',
      step: 'temporary-chat',
    });
  });

  it('fails with TEMP_CHAT_FAILED when the control is missing entirely', async () => {
    document.body.innerHTML = '<main></main>';
    await expect(ensureTemporaryChat(document, { timeoutMs: 60, intervalMs: 5 })).rejects.toMatchObject({
      code: 'TEMP_CHAT_FAILED',
    });
  });
});
