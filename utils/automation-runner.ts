/**
 * utils/automation-runner.ts — content-side pipeline orchestrator.
 *
 * Enforces the one true step order and maps every failure to the typed
 * contract. The attachment step resolves only after Gemini confirms the
 * upload, so the prompt can never outrun the file (gate 3).
 */
import {
  AUTOMATION_RUN_RESPONSE,
  AutomationErrorException,
  DEFAULT_STREAM_TIMEOUT_MS,
  isAutomationRunRequest,
  ok,
  type AutomationRunRequest,
  type AutomationRunResponse,
  type AutomationStep,
} from '../types/automation';
import type { AttachOptions } from './file-attachment';
import { attachFile } from './file-attachment';
import type { PromptOptions } from './prompt';
import { fillPrompt, submitPrompt } from './prompt';
import type { ExtractionOptions } from './response-extractor';
import { extractResponse } from './response-extractor';
import { ensureTemporaryChat } from './temporary-chat';
import type { WaitOptions } from './dom-wait';

export interface RunnerOptions {
  readonly waits?: WaitOptions;
  readonly attach?: AttachOptions;
  readonly prompt?: PromptOptions;
  readonly extraction?: ExtractionOptions;
}

export interface RunnerContext {
  /** Tab the automation runs in — stamped into response metadata. */
  readonly tabId: number;
}

export async function runAutomation(
  root: ParentNode,
  request: AutomationRunRequest,
  context: RunnerContext,
  options: RunnerOptions = {},
): Promise<AutomationRunResponse> {
  const startedAt = Date.now();
  const steps: AutomationStep[] = [];

  const fail = (e: unknown): AutomationRunResponse => {
    const error =
      e instanceof AutomationErrorException
        ? e.toAutomationError()
        : { code: 'INTERNAL' as const, message: e instanceof Error ? e.message : String(e) };
    return {
      kind: AUTOMATION_RUN_RESPONSE,
      status: 'error',
      error,
      meta: { tabId: context.tabId, durationMs: Date.now() - startedAt, streamingDetected: false, steps },
    };
  };

  try {
    // Temporary chat only when explicitly requested AND no specific tab targeted.
    if (request.temporaryChat && request.targetTabId === undefined) {
      await ensureTemporaryChat(root, options.waits);
      steps.push('temporary-chat');
    }
    if (request.file) {
      await attachFile(root, request.file, options.attach);
      steps.push('attach-file');
    }
    await fillPrompt(root, request.prompt, options.prompt);
    steps.push('fill-prompt');
    await submitPrompt(root, options.prompt);
    steps.push('submit');
    const result = await extractResponse(root, {
      timeoutMs: request.timeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS,
      ...options.extraction,
    });
    steps.push('extract');

    return ok(result.text, {
      tabId: context.tabId,
      durationMs: Date.now() - startedAt,
      streamingDetected: result.streamingDetected,
      steps,
    }, result.markdown);
  } catch (e) {
    return fail(e);
  }
}

export { isAutomationRunRequest };
