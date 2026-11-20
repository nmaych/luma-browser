import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';

/**
 * Smoke test for the packaged build.
 *
 * It cannot use `electron.launch`: since 1.17 the release turns off the
 * `enableNodeCliInspectArguments` fuse, so Playwright's main-process inspector
 * is (by design) no longer able to attach. Instead the app is started with
 * `--remote-debugging-port`, which exposes the renderer targets over CDP, and
 * the UI is driven exactly like a user would.
 */

const root = path.resolve(import.meta.dirname, '..');
const releaseRoot = path.join(root, 'release');
// 1.14 renamed the entry point from `Luma Browser.exe` to `LumaBrowser.exe`;
// older builds stay launchable so the script can verify a previous release too.
const EXECUTABLE_NAMES = ['LumaBrowser.exe', 'Luma Browser.exe'];
const executablesIn = (directory) => EXECUTABLE_NAMES.map((name) => path.join(directory, name));
const versionedApps = existsSync(releaseRoot)
  ? readdirSync(releaseRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+\.\d+\.\d+$/.test(entry.name))
      .sort((left, right) => right.name.localeCompare(left.name, undefined, { numeric: true }))
      .flatMap((entry) => executablesIn(path.join(releaseRoot, entry.name, 'win-unpacked')))
  : [];
const candidates = [
  process.env.LUMA_APP_PATH,
  ...versionedApps,
  ...executablesIn(path.join(root, 'release', 'win-unpacked')),
].filter(Boolean);
const executablePath = candidates.find((candidate) => existsSync(candidate));
if (!executablePath) throw new Error('No packaged Luma Browser executable found. Run npm run dist first.');

const profile = mkdtempSync(path.join(os.tmpdir(), 'luma-packaged-'));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(executablePath, [`--user-data-dir=${profile}`, '--remote-debugging-port=0'], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

const wsUrl = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('The app did not expose a debugging port within 30s')), 30_000);
  const inspect = (chunk) => {
    const match = /DevTools listening on (ws:\/\/\S+)/.exec(String(chunk));
    if (match) {
      clearTimeout(timer);
      resolve(match[1]);
    }
  };
  child.stdout?.on('data', inspect);
  child.stderr?.on('data', inspect);
  child.once('exit', (code) => {
    clearTimeout(timer);
    reject(new Error(`The app exited before it was ready (code ${code})`));
  });
});

let browser;
try {
  browser = await chromium.connectOverCDP(wsUrl, { timeout: 30_000 });
  const context = browser.contexts()[0] ?? await browser.waitForEvent('context');
  const page = context.pages()[0] ?? await context.waitForEvent('page');
  await page.getByRole('heading', { name: '新标签页' }).waitFor({ timeout: 20_000 });
  const address = page.getByRole('textbox', { name: '地址和搜索栏' });
  await address.fill('example.com');
  await address.press('Enter');
  await page.getByRole('tab', { name: 'Example Domain' }).waitFor({ timeout: 30_000 });
  const pageUrl = await page.evaluate(async () => {
    const tabId = document.querySelector('.browser-tab.is-active')?.getAttribute('data-tab-id');
    if (!tabId) return '';
    const info = await window.lumaDesktop?.pageView.info(tabId);
    return info?.url ?? '';
  });
  if (!pageUrl.includes('example.com')) throw new Error(`Unexpected page URL: ${pageUrl}`);
  console.log(`Packaged app verified over CDP. Native page loaded: ${pageUrl}`);
} finally {
  await browser?.close().catch(() => undefined);
  child.kill();
  rmSync(profile, { recursive: true, force: true });
}
