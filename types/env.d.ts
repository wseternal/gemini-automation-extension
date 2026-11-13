/**
 * types/env.d.ts — compile-time constants injected by wxt.config.ts.
 *
 * These globals are replaced at build time via Vite `define` and are
 * available in every entrypoint without import.
 */

/** Git version from `git describe --always --dirty --tags`. */
declare const __BUILD_VERSION__: string;

/** ISO-8601 build timestamp (UTC). */
declare const __BUILD_TIME__: string;
