/**
 * Real-Claude-Code name-collision shape.
 *
 * Renames a caller tool ONLY when both hold:
 *   1. Its name exactly matches a real Claude Code tool name (see
 *      `cc-reference-tools.ts`).
 *   2. Its required top-level parameters differ from that CC tool's.
 *
 * Condition 2 is what makes this "collision" detection rather than blanket
 * client-name canonicalization: if a caller's `Write` tool already takes
 * `file_path`/`content` (real CC's shape), it already IS the CC tool in
 * every way that matters — leaving it alone is correct, and Anthropic sees
 * a normal, unremarkable single `Write` tool. Only a lookalike — same name,
 * incompatible shape (e.g. opencode's pre-pi-ai-rename `Write` using
 * `filePath`/`content` instead) — gets moved out of the way, because
 * otherwise either the model is misled about how to call "Write", or the
 * synthetic-injection/dedupe steps end up dropping one of two same-named
 * tools with different behavior.
 *
 * This intentionally has no per-client name list: it runs uniformly
 * whether the caller is opencode, an MCP-only client, or anything else —
 * "when the client is not Claude Code" is exactly the condition under
 * which a name collision like this can even arise.
 *
 * The renamed-to name is prefixed `mcp__` (this pipeline's existing
 * convention for "not a native CC tool name" — see `mcp-shape.ts`) rather
 * than invented ad hoc. When that default target is already present in the
 * incoming tool list, a numeric suffix is chosen so the rename pair stays
 * unique. A description preference note ("ALWAYS USE THIS TOOL INSTEAD OF
 * …") is attached only when the real CC tool of the original name will also
 * appear in the final `tools[]` (see `cc-tools.ts`); otherwise the note
 * would point at a tool that is not advertised.
 */

import { CC_TOOL_REFERENCE, matchesReferenceShape } from './cc-reference-tools';
import type { RenamePair, ToolDescriptor, ToolShape } from './types';

function requiredParamsOf(tool: ToolDescriptor): string[] | undefined {
  const required = tool.parameters?.required;
  return Array.isArray(required)
    ? required.filter((r): r is string => typeof r === 'string')
    : undefined;
}

/**
 * Pick `mcp__<name>` or `mcp__<name>_<n>` absent from `occupied` (incoming
 * tool names plus rename targets already claimed in this pass).
 */
function uniqueCollisionTarget(name: string, occupied: Set<string>): string {
  const base = `mcp__${name}`;
  if (!occupied.has(base)) return base;
  let n = 2;
  for (;;) {
    const candidate = `${base}_${n}`;
    if (!occupied.has(candidate)) return candidate;
    n += 1;
  }
}

export const ccCollisionShape: ToolShape = {
  id: 'cc-collision',
  detect(tools: readonly ToolDescriptor[]): RenamePair[] {
    const occupied = new Set(tools.map((t) => t.name));
    const pairs: RenamePair[] = [];
    for (const tool of tools) {
      // Own keys only — `in` would accept inherited Object props like
      // `toString` / `constructor` / `__proto__` and crash shape matching.
      if (!Object.hasOwn(CC_TOOL_REFERENCE, tool.name)) continue;
      if (matchesReferenceShape(tool.name, requiredParamsOf(tool))) continue;

      const renamed = uniqueCollisionTarget(tool.name, occupied);
      occupied.add(renamed);
      pairs.push([tool.name, renamed, `ALWAYS USE THIS TOOL INSTEAD OF ${tool.name}.`]);
    }
    return pairs;
  },
};
