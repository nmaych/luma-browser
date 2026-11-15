import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREFERENCES } from '../src/data/defaults';
import { SettingsPage } from '../src/pages/SettingsPage';

const available = {
  status: 'available',
  currentVersion: '1.12.4',
  version: '1.12.5',
  percent: 0,
  transferred: 0,
  total: 118_800_000,
  error: null,
  releaseUrl: 'https://github.com/nmaych/luma-browser/releases/tag/v1.12.5',
  line: null,
  lines: [
    { id: 'github', label: 'GitHub 直连' },
    { id: 'mirror', label: '镜像加速' },
  ],
};

const renderSettings = () => render(
  <SettingsPage
    preferences={DEFAULT_PREFERENCES}
    history={[]}
    historyCount={0}
    bookmarkCount={0}
    folderCount={0}
    tabCount={1}
    onUpdate={() => undefined}
    onReset={() => undefined}
    onAddSearchEngine={() => true}
    onRemoveSearchEngine={() => undefined}
    onClearSiteData={async () => true}
    onGetSiteData={async () => null}
    onClearSiteDataForDomain={async () => true}
    onClearCache={async () => true}
    onSleepBackgroundTabs={() => undefined}
  />,
);

afterEach(() => {
  delete (window as { lumaDesktop?: unknown }).lumaDesktop;
});

describe('software update card', () => {
  it('offers the download button and lines after a check instead of downloading', async () => {
    const downloadUpdate = vi.fn(async (line?: string) => ({ ...available, status: 'downloading', line: line ?? 'github' }));
    (window as { lumaDesktop?: unknown }).lumaDesktop = {
      getDownloadDirectory: async () => null,
      getAppVersions: async () => null,
      getUpdateState: async () => null,
      checkForUpdates: async () => available,
      downloadUpdate,
      onUpdateState: () => () => undefined,
    };

    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: '数据与关于' }));

    fireEvent.click(await screen.findByRole('button', { name: '检查更新' }));
    expect(await screen.findByText(/发现新版本 1\.12\.5/)).toBeInTheDocument();
    expect(downloadUpdate).not.toHaveBeenCalled();

    const line = screen.getByLabelText('下载线路');
    expect(screen.getByRole('option', { name: 'GitHub 直连' })).toBeInTheDocument();
    fireEvent.change(line, { target: { value: 'mirror' } });
    expect(screen.getByText(/SHA256 校验/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '下载更新' }));
    await vi.waitFor(() => expect(downloadUpdate).toHaveBeenCalledWith('mirror'));
  });
});
