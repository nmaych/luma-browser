// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { planResume } = require('../electron/main/downloadResume.cjs');

describe('download resume offsets', () => {
  it('continues from the received offset when the file holds it', () => {
    expect(planResume({ recordedBytes: 400, fileSize: 400, totalBytes: 1000 })).toEqual({
      start: 400,
      complete: false,
    });
  });

  it('trims the sparse tail Chromium preallocated', () => {
    // The destination is created at full size long before the bytes arrive.
    expect(planResume({ recordedBytes: 400, fileSize: 1000, totalBytes: 1000 })).toEqual({
      start: 400,
      complete: false,
    });
  });

  it('starts over when the partial file is gone', () => {
    // A cancelled Chromium download deletes its .crdownload; resuming from the
    // recorded offset would produce a file without its first bytes.
    expect(planResume({ recordedBytes: 400, fileSize: 0, totalBytes: 1000 })).toEqual({
      start: 0,
      complete: false,
    });
  });

  it('never claims more bytes than the file actually has', () => {
    expect(planResume({ recordedBytes: 900, fileSize: 400, totalBytes: 1000 })).toEqual({
      start: 400,
      complete: false,
    });
  });

  it('treats a file that already holds every byte as complete', () => {
    expect(planResume({ recordedBytes: 1000, fileSize: 1000, totalBytes: 1000 })).toEqual({
      start: 1000,
      complete: true,
    });
  });

  it('handles a missing total and missing numbers', () => {
    expect(planResume({ recordedBytes: 0, fileSize: 0, totalBytes: 0 })).toEqual({ start: 0, complete: false });
    expect(planResume({})).toEqual({ start: 0, complete: false });
  });
});
