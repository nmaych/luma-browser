import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { _electron as electron } from '@playwright/test';

const target = process.env.LUMA_READER_URL
  || 'http://www.95dushu.info/209/209891/68604246.html';
const profile = mkdtempSync(path.join(os.tmpdir(), 'luma-reader-live-'));
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
  const address = page.getByRole('textbox', { name: '地址和搜索栏' });
  await address.fill(target);
  await address.press('Enter');
  await page.waitForFunction(
    (url) => {
      const view = document.querySelector('webview.is-active');
      if (!view || typeof view.isLoading !== 'function') return false;
      return !view.isLoading() && view.getURL().startsWith(url.split('?')[0]);
    },
    target,
    { timeout: 40_000 },
  ).catch(() => undefined);
  const readerButton = page.getByRole('button', { name: /^阅读模式/ });
  await readerButton.waitFor({ timeout: 30_000 });
  await readerButton.click();
  const reader = page.getByRole('document', { name: '阅读模式' });
  await reader.getByRole('heading', { level: 1 }).waitFor({ timeout: 20_000 });
  const title = await reader.getByRole('heading', { level: 1 }).textContent();
  const chapterNav = reader.getByRole('navigation', { name: '章节导航' });
  const hasChapterNav = await chapterNav.isVisible().catch(() => false);
  const nextEnabled = hasChapterNav
    ? await chapterNav.getByRole('button', { name: '下一章' }).isEnabled().catch(() => false)
    : false;
  console.log(JSON.stringify({ target, title: title?.trim(), hasChapterNav, nextEnabled }, null, 2));
  await page.screenshot({ path: 'test-results/live-reader.png', fullPage: false });
  if (hasChapterNav && nextEnabled) {
    await chapterNav.getByRole('button', { name: '下一章' }).click();
    await reader.getByRole('heading', { level: 1 }).waitFor({ timeout: 20_000 });
    const nextTitle = await reader.getByRole('heading', { level: 1 }).textContent();
    console.log(`NEXT_CHAPTER=${nextTitle?.trim()}`);
  }
} finally {
  await app?.close();
  rmSync(profile, { recursive: true, force: true });
}
