import { describe, expect, test, beforeEach, vi } from 'vitest';
import { DebugManager } from '../debug-manager';
import * as sanitizeHeadersModule from '../../utils/sanitize-headers';

describe('DebugManager HTTP metadata', () => {
  let debugManager: DebugManager;

  beforeEach(() => {
    debugManager = DebugManager.getInstance();
    debugManager.setEnabled(true);
    debugManager.resetForTesting?.();
  });

  test('startLog stores sanitized requestHeaders in dedicated field', () => {
    const requestId = 'test-req-headers';
    const headers = {
      'content-type': 'application/json',
      authorization: 'Bearer supersecrettoken',
    };

    debugManager.startLog(requestId, { model: 'gpt-4' }, headers);

    const log = debugManager.getPendingLog?.(requestId);
    expect(log).toBeDefined();
    expect(log?.requestHeaders).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer supe...oken',
    });
    expect(log?.rawRequest).toEqual({ model: 'gpt-4' });
  });

  test('startLog skips header sanitization when capture is disabled', () => {
    debugManager.setEnabled(false);
    const sanitizeSpy = vi.spyOn(sanitizeHeadersModule, 'sanitizeHeaders');

    debugManager.startLog('disabled-req', { model: 'gpt-4' }, { authorization: 'secret' });

    expect(sanitizeSpy).not.toHaveBeenCalled();
    expect(debugManager.getPendingLog?.('disabled-req')).toBeUndefined();
    sanitizeSpy.mockRestore();
  });

  test('startLog works without requestHeaders', () => {
    const requestId = 'test-no-headers';
    debugManager.startLog(requestId, { model: 'gpt-4' });

    const log = debugManager.getPendingLog?.(requestId);
    expect(log).toBeDefined();
    expect(log?.requestHeaders).toBeUndefined();
    expect(log?.rawRequest).toEqual({ model: 'gpt-4' });
  });

  test('addResponseMeta stores status and headers', () => {
    const requestId = 'test-resp-meta';
    const respHeaders = { 'content-type': 'application/json', 'x-request-id': 'abc' };

    debugManager.startLog(requestId, { test: 'data' });
    debugManager.addResponseMeta(requestId, 200, respHeaders);

    const log = debugManager.getPendingLog?.(requestId);
    expect(log?.responseStatus).toBe(200);
    expect(log?.responseHeaders).toEqual(respHeaders);
  });

  test('addResponseMeta does not overwrite rawResponseSnapshot', () => {
    const requestId = 'test-no-wrap';
    const body = { id: '123', choices: [] };

    debugManager.startLog(requestId, { test: 'data' });
    debugManager.addResponseMeta(requestId, 200, { 'content-type': 'application/json' });
    debugManager.addReconstructedRawResponse(requestId, body);

    const log = debugManager.getPendingLog?.(requestId);
    expect(log?.rawResponseSnapshot).toEqual(body);
    expect(log?.responseStatus).toBe(200);
    expect(log?.responseHeaders).toEqual({ 'content-type': 'application/json' });
  });
});
