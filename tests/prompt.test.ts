import { describe, expect, it, vi } from 'vitest';
import { fillPrompt, submitPrompt } from '../utils/prompt';
import { mountGeminiFixture } from './fixtures/gemini-dom';

const FAST = { timeoutMs: 200, intervalMs: 5, kickoffTimeoutMs: 100 };

describe('fillPrompt', () => {
  it('populates the contenteditable editor and fires input events', async () => {
    const fx = mountGeminiFixture();
    const inputSpy = vi.fn();
    fx.editor.addEventListener('input', inputSpy);

    await fillPrompt(document, 'Summarize the attached document', FAST);

    expect(fx.editor.textContent).toBe('Summarize the attached document');
    expect(inputSpy).toHaveBeenCalled();
  });

  it('injects text safely — markup in the prompt stays literal text', async () => {
    const fx = mountGeminiFixture();
    const hostile = '<img src=x onerror=alert(1)> hello';
    await fillPrompt(document, hostile, FAST);
    expect(fx.editor.textContent).toBe(hostile);
    expect(fx.editor.querySelector('img')).toBeNull();
  });

  it('throws PROMPT_NOT_FOUND when no editor exists', async () => {
    document.body.innerHTML = '<main></main>';
    await expect(fillPrompt(document, 'hi', FAST)).rejects.toMatchObject({
      code: 'PROMPT_NOT_FOUND',
      step: 'fill-prompt',
    });
  });
});

describe('submitPrompt', () => {
  it('clicks the send control when available', async () => {
    const fx = mountGeminiFixture();
    const clickSpy = vi.fn(() => {
      // simulate generation kickoff
      const stop = document.createElement('button');
      stop.setAttribute('aria-label', 'Stop response');
      fx.root.querySelector('.input-area')!.appendChild(stop);
    });
    fx.sendButton.addEventListener('click', clickSpy);

    await submitPrompt(document, FAST);
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to an Enter key event when no send control exists', async () => {
    const fx = mountGeminiFixture();
    fx.sendButton.remove();
    const keys: string[] = [];
    fx.editor.addEventListener('keydown', (e) => {
      keys.push((e as KeyboardEvent).key);
      const stop = document.createElement('button');
      stop.setAttribute('aria-label', 'Stop response');
      fx.root.querySelector('.input-area')!.appendChild(stop);
    });

    await submitPrompt(document, FAST);
    expect(keys).toContain('Enter');
  });

  it('throws SUBMIT_FAILED when generation never kicks off', async () => {
    mountGeminiFixture(); // send button exists but does nothing
    await expect(submitPrompt(document, FAST)).rejects.toMatchObject({
      code: 'SUBMIT_FAILED',
      step: 'submit',
    });
  });
});
