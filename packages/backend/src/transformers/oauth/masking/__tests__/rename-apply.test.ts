import { describe, expect, it } from 'vitest';
import { applyToolRenames } from '../rename-apply';

describe('applyToolRenames', () => {
  const pairs: [string, string][] = [['Write', 'mcp__Write']];

  it('renames tools[], tool_choice, and tool_use blocks', () => {
    const body = {
      tools: [{ name: 'Write' }, { name: 'Bash' }],
      tool_choice: { type: 'tool', name: 'Write' },
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: '1', name: 'Write', input: {} }],
        },
      ],
    };

    const result = applyToolRenames(body, pairs);
    expect(result.tools.map((t: any) => t.name)).toEqual(['mcp__Write', 'Bash']);
    expect(result.tool_choice.name).toBe('mcp__Write');
    expect(result.messages[0].content[0].name).toBe('mcp__Write');
  });

  it('renames tool_reference.tool_name including nested tool_result content', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_reference', tool_name: 'Write' },
            {
              type: 'tool_result',
              tool_use_id: '1',
              content: [{ type: 'tool_reference', tool_name: 'Write' }],
            },
          ],
        },
      ],
    };

    const result = applyToolRenames(body, pairs);
    expect(result.messages[0].content[0].tool_name).toBe('mcp__Write');
    expect(result.messages[0].content[1].content[0].tool_name).toBe('mcp__Write');
  });
});
