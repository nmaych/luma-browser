import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { configureSession, normalizeUserAgent } = require('../electron/main/sessionPolicy.cjs');

describe('normalizeUserAgent', () => {
  it('removes the Electron and Luma product tokens', () => {
    const raw = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Luma Browser/1.14.0 Chrome/156.0.0.0 Electron/45.2.3 Safari/537.36';
    const ua = normalizeUserAgent(raw);
    expect(ua).not.toMatch(/Electron/i);
    expect(ua).not.toMatch(/Luma Browser/i);
    expect(ua).toContain('Chrome/156');
  });

  it('handles an empty value', () => {
    expect(normalizeUserAgent(undefined)).toBe('');
  });
});

const createSession = (calls: string[], userAgent: string) => ({
  getUserAgent: () => userAgent,
  setUserAgent: (value: string) => calls.push(`ua:${value}`),
  setPermissionRequestHandler: () => calls.push('permission-request'),
  setPermissionCheckHandler: () => calls.push('permission-check'),
});

describe('configureSession', () => {
  it('applies hooks in pipeline order: identity, permissions, requests, downloads', () => {
    const calls: string[] = [];
    configureSession(createSession(calls, 'Chrome/156.0.0.0 Electron/45.2.3'), {
      onPermissionRequest: () => undefined,
      onPermissionCheck: () => undefined,
      onRequest: () => calls.push('request'),
      onDownload: () => calls.push('download'),
    });
    expect(calls).toEqual([
      'ua:Chrome/156.0.0.0',
      'permission-request',
      'permission-check',
      'request',
      'download',
    ]);
  });

  it('only installs the handlers it is given, so the incognito profile stays isolated', () => {
    const calls: string[] = [];
    const session = createSession(calls, 'Chrome/156 Electron/45.0.0');
    configureSession(session as never, {});
    expect(calls).toEqual(['ua:Chrome/156']);
  });

  it('returns the session it configured', () => {
    const session = createSession([], 'Chrome/156');
    expect(configureSession(session as never)).toBe(session);
  });
});
