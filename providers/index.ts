/**
 * providers/index.ts — provider registry.
 *
 * Central lookup for all registered LLM providers. The orchestration code
 * resolves a provider by ID or by URL, never by importing a specific
 * provider module directly.
 */
import type { LlmProvider, LlmProviderId } from '../types/provider';
import { geminiProvider } from './gemini';
import { deepseekProvider } from './deepseek';

const REGISTRY: ReadonlyMap<LlmProviderId, LlmProvider> = new Map([
  ['gemini', geminiProvider],
  ['deepseek', deepseekProvider],
]);

/** All registered providers. */
export const ALL_PROVIDERS: readonly LlmProvider[] = Array.from(REGISTRY.values());

/** Get a provider by its ID. Returns undefined if not registered. */
export function getProvider(id: LlmProviderId | string): LlmProvider | undefined {
  return REGISTRY.get(id as LlmProviderId);
}

/** Get the provider that matches a URL. Returns undefined if no match. */
export function getProviderByUrl(url: string | undefined): LlmProvider | undefined {
  return ALL_PROVIDERS.find((p) => p.isProviderUrl(url));
}

/** List all registered provider IDs. */
export function listProviderIds(): LlmProviderId[] {
  return Array.from(REGISTRY.keys());
}

/** Default provider when none is specified. */
export const DEFAULT_PROVIDER_ID: LlmProviderId = 'gemini';

/** Get the default provider. */
export function getDefaultProvider(): LlmProvider {
  return REGISTRY.get(DEFAULT_PROVIDER_ID)!;
}

export { geminiProvider, deepseekProvider };
