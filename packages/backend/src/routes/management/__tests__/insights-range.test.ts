import { describe, expect, it } from 'vitest';
import {
  deriveBucketSizeMs,
  parseInsightsQuery,
  resolveCustomRange,
} from '../insights-shared';

describe('insights custom range', () => {
  it('resolveCustomRange returns meta with auto bucket size', () => {
    const startMs = 1_700_000_000_000;
    const endMs = startMs + 3 * 24 * 60 * 60 * 1000;
    const result = resolveCustomRange(startMs, endMs);
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.key).toBe('custom');
    // 3 days = 259,200,000 ms; 2h is the smallest step yielding <= 48 buckets (36).
    expect(result.bucketSizeMs).toBe(2 * 60 * 60 * 1000);
  });

  it('deriveBucketSizeMs uses 5m steps for one hour', () => {
    expect(deriveBucketSizeMs(60 * 60 * 1000)).toBe(5 * 60 * 1000);
  });

  it('parseInsightsQuery accepts startTime and endTime', () => {
    const parsed = parseInsightsQuery(
      {
        provider: 'openai',
        startTime: '1000',
        endTime: '5000',
      },
      'provider'
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.rangeResult.key).toBe('custom');
    expect(parsed.rangeResult.startTimeMs).toBe(1000);
    expect(parsed.rangeResult.endTimeMs).toBe(5000);
  });

  it('parseInsightsQuery rejects partial custom range', () => {
    const parsed = parseInsightsQuery(
      { provider: 'openai', startTime: '1000' },
      'provider'
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.message).toContain('startTime and endTime');
  });

  it('parseInsightsQuery rejects invalid custom range', () => {
    const parsed = parseInsightsQuery(
      { provider: 'openai', startTime: '5000', endTime: '1000' },
      'provider'
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.message).toContain('less than');
  });
});
