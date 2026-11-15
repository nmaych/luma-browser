import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { _electron as electron } from '@playwright/test';

const profile = mkdtempSync(path.join(os.tmpdir(), 'luma-pageview-'));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${profile}`],
    cwd: path.resolve(import.meta.dirname, '..'),
    env,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  const created = await page.evaluate(async () => window.lumaDesktop.pageView.ensure('poc-view', 'https://example.com/'));
  console.log('ensure', JSON.stringify(created));

  const attached = await page.evaluate(async () => window.lumaDesktop.pageView.attach(
    'poc-view',
    { x: 0, y: 120, width: 900, height: 600 },
  ));
  console.log('attach', attached);

  await page.waitForTimeout(2500);
  const before = await page.evaluate(() => window.lumaDesktop.pageView.info('poc-view'));
  console.log('before', JSON.stringify(before));

  await page.evaluate(() => window.lumaDesktop.pageView.command('poc-view', 'executeJavaScript', [
    'window.__marker = "kept"; document.title;',
  ]));

  const targetId = await app.evaluate(({ BrowserWindow }) => {
    const win = new BrowserWindow({
      x: 980,
      y: 120,
      width: 720,
      height: 520,
      show: true,
      frame: false,
      backgroundColor: '#ffffff',
    });
    return win.id;
  });

  const moved = await page.evaluate(async (windowId) => window.lumaDesktop.pageView.move(
    'poc-view',
    windowId,
    { x: 0, y: 0, width: 720, height: 520 },
  ), targetId);
  console.log('move', moved);

  await page.waitForTimeout(800);
  const marker = await page.evaluate(() => window.lumaDesktop.pageView.command('poc-view', 'executeJavaScript', [
    'window.__marker',
  ]));
  const after = await page.evaluate(() => window.lumaDesktop.pageView.info('poc-view'));
  console.log('after', JSON.stringify({ marker, info: after }));

  await page.evaluate(() => window.lumaDesktop.pageView.destroy('poc-view'));
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.close(), targetId);
} finally {
  await app?.close();
  rmSync(profile, { recursive: true, force: true });
}
