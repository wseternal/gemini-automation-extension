/**
 * types/provider.ts — LLM provider abstraction layer.
 *
 * Each supported LLM cloud service (Gemini, DeepSeek) implements this
 * interface, contributing its own DOM selectors, URL patterns, and
 * automation strategies. The shared orchestration code operates on
 * providers, never on hardcoded service-specific logic.
 */

// ---------------------------------------------------------------------------
// Provider identity
// ---------------------------------------------------------------------------

export type LlmProviderId = 'gemini' | 'deepseek';

// ---------------------------------------------------------------------------
// Selector registry
// ---------------------------------------------------------------------------

/** Ordered list of fallback selectors (most stable first). */
export type SelectorList = readonly string[];

/** DOM selector categories used by the automation pipeline. */
export interface ProviderSelectors {
  /** Rich-text / contenteditable prompt container. */
  readonly promptEditor: SelectorList;
  /** Send control. */
  readonly sendButton: SelectorList;
  /** Stop-generation indicator — present only while the model streams. */
  readonly stopButton: SelectorList;
  /** Hidden file input behind the uploader. */
  readonly fileInput: SelectorList;
  /** Attachment chip / preview shown once the service has registered an upload. */
  readonly attachmentChip: SelectorList;
  /** Rendered model response containers (latest one wins). */
  readonly responseContainer: SelectorList;
  /** Drop target for synthesized drag-and-drop file ingestion. */
  readonly dropZone: SelectorList;
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface LlmProvider {
  /** Unique identifier for this provider. */
  readonly id: LlmProviderId;
  /** Human-readable name. */
  readonly name: string;
  /** URL patterns this provider matches (for content script registration). */
  readonly urlPatterns: readonly string[];
  /** DOM selectors for this provider's interface elements. */
  readonly selectors: ProviderSelectors;
  /** Whether this provider requires DeepThink/DeepReasoning mode activation. */
  readonly hasDeepThink: boolean;
  /** Selector for the DeepThink toggle button (only when hasDeepThink is true). */
  readonly deepThinkToggle?: SelectorList;

  /**
   * Test whether a URL belongs to this provider.
   * Pure function — no DOM or network access.
   */
  isProviderUrl(url: string | undefined): boolean;

  /**
   * Preferred file attachment strategy for this provider.
   * - 'paste-bridge': use main-world paste event (Gemini)
   * - 'file-input': use hidden input[type="file"] (DeepSeek)
   * - 'drop-zone': use drag-and-drop on drop zone
   */
  readonly fileAttachmentStrategy: 'paste-bridge' | 'file-input' | 'drop-zone';
}
