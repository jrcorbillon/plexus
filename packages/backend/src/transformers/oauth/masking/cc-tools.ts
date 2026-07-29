/**
 * Tool description stripping + synthetic Claude Code tool injection —
 * v2-native, ported from vendor/eliza/plugins/plugin-anthropic-proxy/src/
 * proxy/cc-tool-injection.ts (see cc-constants.ts's module doc for the
 * de-vendoring rationale).
 *
 * The vendored version operated on the raw JSON string with hand-rolled
 * bracket-matching (its own comment: "skips [ and ] inside JSON string
 * values so description text can't corrupt depth") to avoid a parse/
 * re-stringify round-trip. That constraint doesn't apply here — this
 * pipeline already parses the body once for tool-rename computation (see
 * `registry.ts`'s caller in `apply-masking.ts`) and passes the parsed
 * object through every subsequent stage, so operating on the object
 * directly is both simpler and safer than re-deriving bracket-matching
 * logic.
 */

import { CC_SYNTHETIC_TOOLS } from './cc-constants';
import type { RenamePair } from './types';

/**
 * Strips every tool's `description` field to an empty string (real Claude
 * Code sessions send minimal/no tool descriptions vs. a typical client's
 * verbose ones — a third-party client's detailed descriptions are
 * themselves a fingerprint signal), and prepends any synthetic Claude
 * Code tool stubs from `CC_SYNTHETIC_TOOLS`.
 *
 * A rename pair carrying a third element (see `cc-collision-shape.ts`) is a
 * name-collision disambiguation note. It is only applied when the original
 * CC tool name is still present in the final `tools[]` (caller-retained or
 * synthetically injected) — otherwise the note would tell the model to
 * prefer a renamed tool "INSTEAD OF" a name that is not advertised.
 *
 * Must run BEFORE `dedupeSyntheticToolCollisions()` (a computed rename
 * from `registry.ts` may target one of the reserved synthetic names,
 * producing a duplicate that the dedupe pass then resolves).
 *
 * @param body - Parsed JSON request body with a `tools[]` array
 * @param renamePairs - The same pairs passed to `applyToolRenames()`, used
 *   only to look up which renamed tool names need a collision note
 * @returns New body object with tool descriptions stripped (or replaced
 *   with a collision note) and synthetic tools prepended (same reference if
 *   there's no `tools[]` to process)
 */
export function stripDescriptionsAndInjectSyntheticTools(
  body: any,
  renamePairs: readonly RenamePair[] = []
): any {
  if (!Array.isArray(body?.tools)) {
    return body;
  }

  const synthetics = CC_SYNTHETIC_TOOLS.map((t) => ({ ...t }));
  // After `applyToolRenames`, collision sources are already gone from
  // `body.tools`. A preference note is only honest when the original CC
  // name will still appear in the outbound `tools[]` (today: only via
  // synthetic injection, if any).
  const retainedOriginalNames = new Set(synthetics.map((t) => t.name));

  const noteByRenamedName = new Map<string, string>();
  for (const [originalName, renamedName, note] of renamePairs) {
    if (note && retainedOriginalNames.has(originalName)) {
      noteByRenamedName.set(renamedName, note);
    }
  }

  const strippedTools = body.tools.map((t: any) => {
    const note = noteByRenamedName.get(t?.name);
    return { ...t, description: note ?? '' };
  });

  return {
    ...body,
    tools: [...synthetics, ...strippedTools],
  };
}
