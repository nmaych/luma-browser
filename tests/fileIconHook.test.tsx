import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { clearFileIconCache, useFileIcon } from '../src/hooks/useFileIcon';

const icon = { dataUrl: 'data:image/png;base64,iVBORw0KGgo=', kind: 'shell' as const };

function stubDesktop(getDownloadIcon: (id: string) => Promise<unknown>) {
  Object.defineProperty(window, 'lumaDesktop', {
    configurable: true,
    writable: true,
    value: { getDownloadIcon },
  });
}

describe('useFileIcon', () => {
  beforeEach(() => clearFileIconCache());
  afterEach(() => {
    clearFileIconCache();
    Reflect.deleteProperty(window, 'lumaDesktop');
  });

  it('loads the file icon and reuses it across mounts', async () => {
    const getDownloadIcon = vi.fn().mockResolvedValue(icon);
    stubDesktop(getDownloadIcon);

    const first = renderHook(() => useFileIcon('download-1', true));
    await waitFor(() => expect(first.result.current).toEqual(icon));

    const second = renderHook(() => useFileIcon('download-1', true));
    expect(second.result.current).toEqual(icon);
    expect(getDownloadIcon).toHaveBeenCalledTimes(1);
    expect(getDownloadIcon).toHaveBeenCalledWith('download-1');
  });

  it('stays quiet while the download has no icon to offer', async () => {
    const getDownloadIcon = vi.fn().mockResolvedValue(null);
    stubDesktop(getDownloadIcon);

    const disabled = renderHook(() => useFileIcon('download-2', false));
    expect(disabled.result.current).toBeNull();
    expect(getDownloadIcon).not.toHaveBeenCalled();

    const enabled = renderHook(() => useFileIcon('download-2', true));
    await waitFor(() => expect(getDownloadIcon).toHaveBeenCalledTimes(1));
    expect(enabled.result.current).toBeNull();
  });

  it('falls back to null when the bridge is missing or fails', async () => {
    const failing = renderHook(() => useFileIcon('download-3', true));
    await waitFor(() => expect(failing.result.current).toBeNull());

    stubDesktop(() => Promise.reject(new Error('ipc gone')));
    const rejected = renderHook(() => useFileIcon('download-4', true));
    await waitFor(() => expect(rejected.result.current).toBeNull());
  });
});
