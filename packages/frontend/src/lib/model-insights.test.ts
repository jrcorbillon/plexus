import { describe, it, expect } from 'vitest';
import { TIMELINE_OPTIONS, DEFAULT_RANGE_KEY, modelInsightsPath } from './model-insights';

describe('model-insights helpers', () => {
  describe('TIMELINE_OPTIONS', () => {
    it('contains exactly the five approved timeline ranges', () => {
      const keys = TIMELINE_OPTIONS.map((o) => o.key);
      expect(keys).toEqual(['1h', '5h', '24h', '7d', '30d']);
    });

    it('maps 1hr label to 1h API key', () => {
      const opt = TIMELINE_OPTIONS.find((o) => o.label === '1hr');
      expect(opt).toBeDefined();
      expect(opt!.key).toBe('1h');
    });

    it('all other labels match their keys', () => {
      for (const opt of TIMELINE_OPTIONS) {
        if (opt.label === '1hr') continue; // Special case
        expect(opt.label).toBe(opt.key);
      }
    });
  });

  describe('DEFAULT_RANGE_KEY', () => {
    it('is a supported range key', () => {
      const allKeys = TIMELINE_OPTIONS.map((o) => o.key);
      expect(allKeys).toContain(DEFAULT_RANGE_KEY);
    });
  });

  describe('modelInsightsPath', () => {
    it('builds a basic model path', () => {
      expect(modelInsightsPath('gpt-4')).toBe('/models/gpt-4/insights');
    });

    it('encodes special characters in model ids', () => {
      expect(modelInsightsPath('special/alias: v1 + spaces')).toBe(
        '/models/special%2Falias%3A%20v1%20%2B%20spaces/insights',
      );
    });

    it('encodes slashes to prevent route splitting', () => {
      expect(modelInsightsPath('org/model-name')).toBe(
        '/models/org%2Fmodel-name/insights',
      );
    });

    it('encodes colons', () => {
      expect(modelInsightsPath('model:v2')).toBe('/models/model%3Av2/insights');
    });

    it('encodes plus signs as %2B (not spaces)', () => {
      expect(modelInsightsPath('a+b')).toBe('/models/a%2Bb/insights');
    });

    it('encodes spaces as %20', () => {
      expect(modelInsightsPath('my model')).toBe('/models/my%20model/insights');
    });

    it('encodes percent signs', () => {
      expect(modelInsightsPath('100%')).toBe('/models/100%25/insights');
    });

    it('leaves simple alphanumeric ids unchanged', () => {
      expect(modelInsightsPath('gpt-4-turbo')).toBe('/models/gpt-4-turbo/insights');
    });
  });
});
