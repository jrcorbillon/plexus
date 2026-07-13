import { describe, expect, test, vi, afterEach } from 'vitest';
import {
  cooldownBypassKeysForRound,
  getAliasRetryPolicy,
  waitForRetryRound,
} from '../alias-retry-policy';
import type { PlexusConfig } from '../../config';

describe('alias-retry-policy', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('getAliasRetryPolicy returns defaults when alias missing', () => {
    expect(getAliasRetryPolicy({ providers: {}, models: {} } as PlexusConfig, null)).toEqual({
      maxAttempts: 1,
      retryDelaySeconds: 0,
    });
  });

  test('getAliasRetryPolicy reads alias settings', () => {
    const config = {
      providers: {},
      models: {
        'my-alias': {
          max_attempts: 3,
          retry_delay_seconds: 5,
          target_groups: [
            { name: 'default', selector: 'random', targets: [{ provider: 'p1', model: 'm1' }] },
          ],
        },
      },
      keys: {},
    } as unknown as PlexusConfig;

    expect(getAliasRetryPolicy(config, 'my-alias')).toEqual({
      maxAttempts: 3,
      retryDelaySeconds: 5,
    });
  });

  test('cooldownBypassKeysForRound is empty on first round', () => {
    expect(cooldownBypassKeysForRound(0, ['p1/m1'])).toBeUndefined();
  });

  test('cooldownBypassKeysForRound returns attempted keys on retry rounds', () => {
    expect(cooldownBypassKeysForRound(1, ['p1/m1', 'p2/m2'])).toEqual(new Set(['p1/m1', 'p2/m2']));
  });

  test('waitForRetryRound skips delay for round 0', async () => {
    vi.useFakeTimers();
    const sleepSpy = vi.spyOn(global, 'setTimeout');

    await waitForRetryRound(0, 10);

    expect(sleepSpy).not.toHaveBeenCalled();
  });

  test('waitForRetryRound waits configured seconds', async () => {
    vi.useFakeTimers();
    let resolved = false;
    const promise = waitForRetryRound(1, 2).then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(1999);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(resolved).toBe(true);
  });

  test('waitForRetryRound rejects when signal aborts during delay', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const promise = waitForRetryRound(1, 5, controller.signal);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });
});
