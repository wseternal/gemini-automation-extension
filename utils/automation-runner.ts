/**
 * utils/automation-runner.ts — content-side pipeline orchestrator.
 *
 * Enforces the step order and maps every failure to the typed
 * contract. The attachment step resolves only after the provider confirms
 * the upload, so the prompt can never outrun the file.
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
import type { LlmProvider } from '../types/provider';
import type { AttachOptions } from './file-attachment';
import { attachFile } from './file-attachment';
import type { PromptOptions } from './prompt';
import { fillPrompt, submitPrompt } from './prompt';
import type { ExtractionOptions } from './response-extractor';
import { extractResponse } from './response-extractor';
import { ensureDeepThink } from './deepthink';
import type { WaitOptions } from './dom-wait';

const LOG_PREFIX = '[LLMBridge:runner]';

function log(...args: unknown[]): void {
  console.log(LOG_PREFIX, ...args);
}

function logWarn(...args: unknown[]): void {
  console.warn(LOG_PREFIX, ...args);
}

export interface RunnerOptions {
  readonly waits?: WaitOptions;
  readonly attach?: AttachOptions;
  readonly prompt?: PromptOptions;
  readonly extraction?: ExtractionOptions;
}

export interface RunnerContext {
  /** Tab the automation runs in — stamped into response metadata. */
  readonly tabId: number;
  /** The LLM provider to use for this automation run. */
  readonly provider: LlmProvider;
}

export async function runAutomation(
  root: ParentNode,
  request: AutomationRunRequest,
  context: RunnerContext,
  options: RunnerOptions = {},
): Promise<AutomationRunResponse> {
  const startedAt = Date.now();
  const steps: AutomationStep[] = [];
  const provider = context.provider;
  const selectors = provider.selectors;

  const fail = (e: unknown): AutomationRunResponse => {
    const error =
      e instanceof AutomationErrorException
        ? e.toAutomationError()
        : { code: 'INTERNAL' as const, message: e instanceof Error ? e.message : String(e) };
    return {
      kind: AUTOMATION_RUN_RESPONSE,
      status: 'error',
      error,
      meta: {
        tabId: context.tabId,
        providerId: provider.id,
        durationMs: Date.now() - startedAt,
        streamingDetected: false,
        steps,
      },
    };
  };

  try {
    log(`[${provider.id}] starting automation`, { tabId: context.tabId });

    // DeepThink activation for providers that require it.
    if (provider.hasDeepThink && provider.deepThinkToggle) {
      log(`[${provider.id}] step: deep-think`);
      await ensureDeepThink(root, provider.deepThinkToggle, options.waits);
      steps.push('deep-think');
      log(`[${provider.id}] step: deep-think done`);
    }
    if (request.file) {
      log(`[${provider.id}] step: attach-file "${request.file.name}"`);
      await attachFile(root, provider, request.file, options.attach);
      steps.push('attach-file');
      log(`[${provider.id}] step: attach-file done`);
    }
    log(`[${provider.id}] step: fill-prompt`);
    await fillPrompt(root, selectors, request.prompt, options.prompt);
    steps.push('fill-prompt');
    log(`[${provider.id}] step: submit`);
    await submitPrompt(root, selectors, options.prompt);
    steps.push('submit');
    log(`[${provider.id}] step: extract (timeout=${request.timeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS}ms)`);
    const result = await extractResponse(root, selectors, {
      timeoutMs: request.timeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS,
      svgStopDetection: provider.streamingDetection === 'svg-path',
      ...options.extraction,
    });
    steps.push('extract');
    log(`[${provider.id}] completed in ${Date.now() - startedAt}ms`, { steps, streamingDetected: result.streamingDetected });

    return ok(result.text, {
      tabId: context.tabId,
      providerId: provider.id,
      durationMs: Date.now() - startedAt,
      streamingDetected: result.streamingDetected,
      steps,
    }, result.markdown);
  } catch (e) {
    return fail(e);
  }
}

export { isAutomationRunRequest };
