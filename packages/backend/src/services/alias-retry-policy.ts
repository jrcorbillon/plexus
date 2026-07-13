import type { PlexusConfig } from '../config';

export interface AliasRetryPolicy {
  maxAttempts: number;
  retryDelaySeconds: number;
}

export function getAliasRetryPolicy(
  config: PlexusConfig,
  canonicalModel?: string | null
): AliasRetryPolicy {
  const alias = canonicalModel ? config.models?.[canonicalModel] : undefined;
  return {
    maxAttempts: alias?.max_attempts ?? 1,
    retryDelaySeconds: alias?.retry_delay_seconds ?? 0,
  };
}

/**
 * Keys (`provider/model`) this request may re-attempt despite shared cooldowns.
 * Only applies on retry rounds (round > 0); leaves global cooldown state intact.
 */
export function cooldownBypassKeysForRound(
  round: number,
  attemptedProviders: readonly string[]
): ReadonlySet<string> | undefined {
  if (round <= 0 || attemptedProviders.length === 0) return undefined;
  return new Set(attemptedProviders);
}

/**
 * Sleep before starting a retry round. No delay before round 1 (round index 0).
 * Aborts cleanly when the client disconnects.
 */
export async function waitForRetryRound(
  round: number,
  retryDelaySeconds: number,
  signal?: AbortSignal,
  buildCancelledError?: () => Error
): Promise<void> {
  if (round === 0 || retryDelaySeconds <= 0) return;

  if (signal?.aborted) {
    throw buildCancelledError?.() ?? new DOMException('The operation was aborted.', 'AbortError');
  }

  await new Promise<void>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      cleanup();
      resolve();
    }, retryDelaySeconds * 1000);

    const onAbort = () => {
      cleanup();
      reject(
        buildCancelledError?.() ?? new DOMException('The operation was aborted.', 'AbortError')
      );
    };

    const cleanup = () => {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', onAbort);
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    timeoutId.unref?.();
  });
}
