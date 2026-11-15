import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { _electron as electron } from '@playwright/test';

const profile = mkdtempSync(path.join(os.tmpdir(), 'luma-ui-check-'));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: path.resolve(import.meta.dirname, '..'), env });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(390, 800));
  const address = page.getByRole('textbox', { name: '地址和搜索栏' });
  await address.fill('luma://settings');
  await address.press('Enter');
  await page.getByRole('button', { name: '搜索引擎', exact: true }).click();
  await page.waitForTimeout(300);
  const data = await page.evaluate(() => {
    const rectOf = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, scrollWidth: node.scrollWidth };
    };
    const button = document.querySelector('.settings-card__header button');
    const header = button?.parentElement;
    return {
      text: button?.textContent?.trim(),
      display: button ? getComputedStyle(button).display : null,
      buttonRect: rectOf('.settings-card__header button'),
      headerRect: header ? (() => {
        const r = header.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      })() : null,
      workspace: rectOf('.settings-workspace'),
      aside: rectOf('.settings-sidebar'),
      panel: rectOf('.settings-panel'),
      card: rectOf('.settings-card'),
      columns: document.querySelector('.settings-workspace') ? getComputedStyle(document.querySelector('.settings-workspace')).gridTemplateColumns : null,
      overflow: document.querySelector('.settings-panel') ? getComputedStyle(document.querySelector('.settings-panel')).overflow : null,
      viewport: { width: innerWidth, scrollWidth: document.documentElement.scrollWidth },
      headerText: header?.textContent?.trim(),
    };
  });
  console.log(JSON.stringify(data, null, 2));
  await page.screenshot({ path: 'test-results/settings-mobile-inspect.png' });
} finally {
  await app?.close();
  rmSync(profile, { recursive: true, force: true });
}
