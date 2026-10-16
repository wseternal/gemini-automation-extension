import { describe, expect, it } from 'vitest';
import { extractResponse } from '../utils/response-extractor';
import { sleep } from '../utils/dom-wait';
import { mountGeminiFixture } from './fixtures/gemini-dom';

const FAST = { timeoutMs: 400, intervalMs: 10, kickoffTimeoutMs: 150, stabilityPolls: 2 };

describe('extractResponse', () => {
  it('resolves only after the stop indicator disappears AND the text is stable', async () => {
    const fx = mountGeminiFixture();
    let resolved = false;

    const pending = extractResponse(document, FAST).then((r) => {
      resolved = true;
      return r;
    });
    const streaming = fx.streamResponse(['The answer ', 'is **42**', ' — computed.'], { intervalMs: 20 });

    await sleep(45); // mid-stream: stop button present, text still growing
    expect(resolved).toBe(false);

    await streaming;
    const result = await pending;

    expect(resolved).toBe(true);
    expect(result.streamingDetected).toBe(true);
    expect(result.text).toBe('The answer is **42** — computed.');
  });

  it('captures the complete rendered text of the latest response', async () => {
    const fx = mountGeminiFixture();
    const chunks = ['# Title\n', 'line one\n', 'line two with `code`'];
    const pending = extractResponse(document, FAST);
    await fx.streamResponse(chunks, { intervalMs: 10 });
    const result = await pending;
    expect(result.text).toBe(chunks.join(''));
  });

  it('still resolves when no stop button ever appears (stability-gated)', async () => {
    const fx = mountGeminiFixture();
    const pending = extractResponse(document, FAST);
    await fx.streamResponse(['instant answer'], { withStopButton: false });
    const result = await pending;
    expect(result.streamingDetected).toBe(false);
    expect(result.text).toBe('instant answer');
  });

  it('times out with STREAM_TIMEOUT when streaming never finishes', async () => {
    const fx = mountGeminiFixture();
    const stop = document.createElement('button');
    stop.setAttribute('aria-label', 'Stop response');
    fx.root.querySelector('.input-area')!.appendChild(stop);
    const container = document.createElement('div');
    container.className = 'model-response-text';
    container.textContent = 'stuck';
    fx.main.appendChild(container);
    // Keep mutating so the text never stabilizes either.
    const churn = setInterval(() => {
      container.textContent += '.';
    }, 15);

    await expect(extractResponse(document, { ...FAST, timeoutMs: 120 })).rejects.toMatchObject({
      code: 'STREAM_TIMEOUT',
      step: 'extract',
    });
    clearInterval(churn);
  });

  it('fails with EXTRACTION_FAILED when no response container appears', async () => {
    mountGeminiFixture();
    await expect(extractResponse(document, { ...FAST, kickoffTimeoutMs: 60 })).rejects.toMatchObject({
      code: 'EXTRACTION_FAILED',
      step: 'extract',
    });
  });
});
