/**
 * Claude Code fingerprint constants — v2-native.
 *
 * Ported from vendor/eliza/plugins/plugin-anthropic-proxy/src/proxy/
 * constants.ts (which itself is a byte-for-byte port of Shadow's
 * `openclaw-routing-layer/proxy.js` v2.2.3) and de-vendored so v2 no longer
 * depends on the eliza plugin. Only the OAuth-masking pipeline actually
 * needed anything from that plugin — v1 (transformers/oauth/oauth-
 * claude.ts) proves the eliza dependency was never load-bearing for Claude
 * Code fingerprinting in general, and roughly half of what the vendored
 * pipeline did was already a no-op for non-eliza clients (see this file's
 * git history / apply-masking.ts for the audit).
 *
 * These are upstream-detection-bypass surface: the values below encode
 * what a genuine Claude Code CLI session's requests look like, and MUST
 * match reality or Anthropic's abuse detection flags the traffic as
 * non-CC (see debug traces 1e0a037d-54a2-4358-ac53-75ade3a1f875,
 * 7754cf0d-f083-44d2-8e57-fe41ce1f7592, 17404760-e986-49b3-8a20-
 * f1a4a469a0ac for the failure modes each of these fixes). Each constant
 * below documents where to look if it ever needs updating.
 */

/**
 * Claude Code CLI version string to emulate in the billing header's
 * cc_version and the `user-agent`/`claude-cli` headers.
 *
 * Anthropic gates new models on this version: requests advertising an
 * older Claude Code are rejected with `claude_code_version_too_old`
 * (e.g. claude-fable-5-1 requires >= 2.1.251; see mcowger/plexus#842), so
 * letting this constant go stale blocks newly released models even when
 * everything else about the fingerprint is correct.
 *
 * This is only the startup/offline fallback. The live value comes from
 * `ClaudeCodeVersionService` (services/oauth), which refreshes from the
 * npm registry's `latest` dist-tag on startup and every 60 minutes —
 * `cc-headers.ts` and `cc-billing.ts` read it per request.
 *
 * SOURCE: latest real `@anthropic-ai/claude-code` release.
 * TO UPDATE (fallback only): check the npm registry (`npm view
 * @anthropic-ai/claude-code version`) or install the real `claude` CLI
 * and run `claude --version`.
 */
export const CC_VERSION = '2.1.280';

/**
 * Billing fingerprint salt + character-index selection, used to compute the
 * `cc_version` build-hash suffix (e.g. the ".a7c" in "2.1.97.a7c").
 *
 * SOURCE: vendor/eliza's BILLING_HASH_SALT / BILLING_HASH_INDICES, whose
 * comment claims these match real Claude Code's `utils/fingerprint.ts`
 * computeFingerprint() algorithm (SHA256 over specific character indices of
 * the first user message, salted, truncated to 3 hex chars). Never
 * independently verified byte-for-byte against real CC — if Anthropic
 * starts rejecting this suffix specifically, the salt/indices are the first
 * thing to re-derive from a genuine Claude Code CLI network capture.
 * TO UPDATE: capture a real Claude Code request, extract the cc_version
 * suffix, and work backward from the known algorithm shape (see
 * cc-billing.ts's `computeFingerprint`).
 */
export const BILLING_HASH_SALT = '59cf53e54c78';
export const BILLING_HASH_INDICES: readonly number[] = [4, 7, 20];

/**
 * `anthropic-beta` feature flags real Claude Code sends on every OAuth
 * request. pi-ai's own OAuth client (`@earendil-works/pi-ai`, `dist/api/
 * anthropic-messages.js`, `createClient()`) only sets 2 of these
 * (`claude-code-20250219`, `oauth-2025-04-20`) plus whatever interleaved-
 * thinking/fine-grained-streaming flags apply to the model — see
 * pi-ai-executor.ts, which overrides pi-ai's header via `options.headers`
 * (the last-merged / overriding source in pi-ai's `mergeHeaders()`).
 *
 * SOURCE: vendor/eliza's REQUIRED_BETAS, refreshed against a genuine
 * `claude-cli/2.1.278 (external, cli)` capture (staging traces 7387fe89 /
 * c22b69c4), which added `thinking-token-count-2026-05-13`,
 * `mid-conversation-system-2026-04-07`, and `advisor-tool-2026-03-01`.
 * `advanced-tool-use-2025-11-20` / `fast-mode-2026-02-01` are kept: the
 * capture doesn't send them, but one capture can't prove retirement and
 * dropping advertised flags risks currently-working masked traffic.
 * TO UPDATE: inspect a genuine Claude Code CLI request's `anthropic-beta`
 * header (comma-separated feature flags); Anthropic also documents current
 * beta flags at https://docs.claude.com/en/api/beta-headers as they're
 * introduced/retired.
 */
export const REQUIRED_BETAS: readonly string[] = [
  'oauth-2025-04-20',
  'claude-code-20250219',
  'interleaved-thinking-2025-05-14',
  'thinking-token-count-2026-05-13',
  'advanced-tool-use-2025-11-20',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'mid-conversation-system-2026-04-07',
  'advisor-tool-2026-03-01',
  'effort-2025-11-24',
  'fast-mode-2026-02-01',
];

/**
 * Synthetic Claude Code tool stubs optionally injected into the outgoing
 * `tools[]` so the tool set fingerprints like a real Claude Code session.
 *
 * Kept empty on purpose: padding tools the caller does not implement caused
 * the model to emit `tool_use` calls the originating client cannot execute
 * (the same failure mode that removed `Glob`/`Grep`/`TodoRead` stubs, and
 * previously `Agent`/`NotebookEdit`). Callers that already expose a real
 * CC-shaped `Agent`/`NotebookEdit` keep their own definitions; fingerprint
 * parity for everyone else comes from system/billing/MCP renaming instead.
 *
 * SOURCE: vendor/eliza's CC_SYNTHETIC_TOOLS (itself ported from
 * proxy.js v2.2.3's inline tool-array insertion).
 * TO UPDATE: only re-add an entry here if (a) a genuine CC capture still
 * requires it for fingerprinting AND (b) calls can be translated or the
 * stub is gated to callers that already register a handler for that name.
 */
export const CC_SYNTHETIC_TOOLS: readonly {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}[] = [];
