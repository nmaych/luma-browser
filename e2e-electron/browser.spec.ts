import path from 'node:path';
import os from 'node:os';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

let app: ElectronApplication;
let page: Page;
const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'luma-electron-test-'));
const downloadsDir = path.join(userDataDir, 'Downloads');

test.beforeAll(async () => {
  mkdirSync(downloadsDir, { recursive: true });
  const env = { ...process.env };
  // Playwright must start Electron as a desktop app, not as Node.
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...env, NODE_ENV: 'test', LUMA_DOWNLOAD_DIR: downloadsDir },
  });
  await app.evaluate(({ app: electronApp }, directory) => {
    electronApp.setPath('downloads', directory);
  }, downloadsDir);
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close();
  rmSync(userDataDir, { recursive: true, force: true });
});




/**
 * The tear-off window follows the OS cursor, which a synthetic drag cannot
 * move. Patching the main-process cursor keeps those tests deterministic while
 * still exercising the real code path.
 */
async function setTestCursor(point: { x: number; y: number } | null) {
  await app.evaluate(({ screen }, next) => {
    const holder = globalThis as unknown as {
      __origCursor?: () => { x: number; y: number };
      __testCursor?: { x: number; y: number } | null;
    };
    if (!holder.__origCursor) {
      holder.__origCursor = screen.getCursorScreenPoint.bind(screen);
      screen.getCursorScreenPoint = () => holder.__testCursor ?? holder.__origCursor!();
    }
    holder.__testCursor = next;
  }, point);
}

/** Puts the simulated cursor inside the tab bar, where a reorder drag happens. */
async function setCursorInTabBar(offsetX = 80, offsetY = 18) {
  const windowId = await mainWindowId();
  const bounds = await app.evaluate(({ BrowserWindow }, id) => {
    const win = BrowserWindow.fromId(id);
    return win ? win.getContentBounds() : null;
  }, windowId);
  if (!bounds) return;
  await setTestCursor({ x: bounds.x + offsetX, y: bounds.y + offsetY });
}

/** Id of the window that hosts this test page (never a helper window). */
async function mainWindowId(): Promise<number> {
  return page.evaluate(() => window.lumaDesktop?.getWindowId() ?? 0);
}

/** The tab whose page is currently on screen. */
async function activeTabId(): Promise<string> {
  const id = await page.locator('.browser-tab.is-active').getAttribute('data-tab-id');
  if (!id) throw new Error('Missing active tab id');
  return id;
}

async function pageInfo(tabId?: string) {
  const id = tabId ?? await activeTabId();
  const info = await page.evaluate((tab) => window.lumaDesktop?.pageView.info(tab) ?? null, id);
  if (!info) throw new Error(`Missing native page for ${id}`);
  return info;
}

async function tabIdByUrl(fragment: string): Promise<string> {
  const ids = await page.locator('.browser-tab').evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute('data-tab-id') || ''));
  for (const id of ids) {
    const info = await page.evaluate((tab) => window.lumaDesktop?.pageView.info(tab) ?? null, id);
    if (info?.url.includes(fragment)) return id;
  }
  throw new Error(`No tab showing ${fragment}`);
}

async function runInPage<T = unknown>(script: string, tabId?: string): Promise<T> {
  const id = tabId ?? await activeTabId();
  return page.evaluate(
    ({ tab, code }) => window.lumaDesktop?.pageView.command(tab, 'executeJavaScript', [code]) as Promise<unknown>,
    { tab: id, code: script },
  ) as Promise<T>;
}

async function pageHostBox() {
  const box = await page.locator('.page-host-layer').boundingBox();
  if (!box) throw new Error('Missing page host area');
  return box;
}

function livePageCount() {
  return app.evaluate(({ webContents }) =>
    webContents.getAllWebContents().filter((contents) => /^https?:/.test(contents.getURL())).length,
  );
}

test('runs as a native Electron application', async () => {
  await expect(page.getByRole('heading', { name: '新标签页' })).toBeVisible();
  await expect(page.getByRole('button', { name: '打开主页' })).toBeVisible();
  const isDesktop = await page.evaluate(() => Boolean(window.lumaDesktop?.isDesktop));
  expect(isDesktop).toBe(true);
  await expect(page.getByRole('button', { name: '最小化窗口' })).toBeVisible();
});

test('loads a real external web page in a native page view', async () => {
  const address = page.getByRole('textbox', { name: '地址和搜索栏' });
  await address.fill('example.com');
  await address.press('Enter');

  await expect(address).toHaveValue('example.com');
  await expect(page.getByRole('tab', { name: 'Example Domain' })).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await pageInfo()).url, { timeout: 10_000 }).toContain('example.com');

  const info = await pageInfo();
  expect(info.webContentsId).toBeGreaterThan(0);
  expect(info.visible).toBe(true);
  const fromMain = await app.evaluate(({ webContents }, id) => {
    const contents = webContents.fromId(id);
    return { url: contents?.getURL() };
  }, info.webContentsId);
  expect(fromMain.url).toContain('example.com');
});

test('shows the site favicon and captures a real tab preview', async () => {
  // Self-contained: this test also runs on its own via --grep.
  await page.getByRole('textbox', { name: '地址和搜索栏' }).fill('example.com/?favicon=1');
  await page.getByRole('textbox', { name: '地址和搜索栏' }).press('Enter');
  await expect(page.getByRole('tab', { name: 'Example Domain' }).first()).toBeVisible({ timeout: 20_000 });
  await expect.poll(async () => (await pageInfo()).url, { timeout: 20_000 }).toContain('example.com');

  const guestId = (await pageInfo()).webContentsId;
  await app.evaluate(async ({ webContents }, id) => {
    await webContents.fromId(id)?.executeJavaScript(`(() => {
      const icon = document.createElement('link');
      icon.rel = 'icon';
      icon.href = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="4" fill="#315be4"/><circle cx="8" cy="8" r="4" fill="#fff"/></svg>');
      document.head.appendChild(icon);
    })()`);
  }, guestId);

  await expect(page.locator('.browser-tab.is-active .browser-tab__favicon img')).toBeVisible({ timeout: 10_000 });

  // The hover card is its own window above the page, so the page never moves.
  const previewWindows = () => app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().filter((win) => win.webContents.getURL().startsWith('data:')).length);
  await page.getByRole('tab', { name: 'Example Domain' }).hover();
  await expect.poll(previewWindows, { timeout: 10_000 }).toBeGreaterThan(0);
  // The page itself never leaves the window for a hover card.
  expect((await pageInfo()).visible).toBe(true);
  await page.mouse.move(0, 0);
  await expect.poll(
    () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .filter((win) => win.webContents.getURL().startsWith('data:') && win.isVisible()).length),
    { timeout: 5_000 },
  ).toBe(0);

  await page.getByRole('button', { name: '管理所有标签页' }).click();
  await expect(page.locator('.tab-card__preview-image').first()).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: 'test-results/ui-tab-overview.png' });
  await page.keyboard.press('Escape');
});

test('returns to the Luma home page after visiting web content', async () => {
  await page.getByRole('button', { name: '主页' }).click();
  await expect(page.getByRole('heading', { name: '今天，想去哪里？' })).toBeVisible();
  // The native page steps aside while an internal page is shown.
  await expect.poll(async () => (await pageInfo()).visible, { timeout: 10_000 }).toBe(false);
});

test('keeps a second tab alive and opens a fresh new tab page', async () => {
  await page.getByRole('button', { name: '新建标签页 (Ctrl+T)' }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(page.getByRole('heading', { name: '新标签页' })).toBeVisible();
  expect(await livePageCount()).toBe(1);
});

test('opens the bookmark manager inside the native window', async () => {
  const address = page.getByRole('textbox', { name: '地址和搜索栏' });
  await address.fill('luma://bookmarks');
  await address.press('Enter');
  await expect(page.getByRole('heading', { name: '书签', level: 1 })).toBeVisible();
});

test('turns a native network failure into a recoverable error page', async () => {
  const address = page.getByRole('textbox', { name: '地址和搜索栏' });
  await address.fill('https://this-host-does-not-exist.luma.invalid');
  await address.press('Enter');
  await expect(page.getByRole('heading', { name: /无法打开这个网页|无法连接到网络/ })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole('button', { name: '主页', exact: true }).click();
  await expect(page.getByRole('heading', { name: '今天，想去哪里？' })).toBeVisible();
});

test('keeps native controls and mobile navigation in a narrow window', async () => {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(390, 800);
  });
  await expect(page.getByRole('navigation', { name: '移动端浏览器导航' })).toBeVisible();
  await expect(page.getByRole('button', { name: '最小化窗口' })).toBeVisible();
  await expect(page.getByRole('button', { name: '关闭窗口' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
});

test('switches search engines, reorders tabs and exposes tab context actions', async () => {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(1440, 900);
  });

  const engine = page.getByLabel('选择默认搜索引擎');
  await expect(engine).toBeVisible();
  await engine.selectOption('google');
  await expect(engine).toHaveValue('google');
  await expect(page.getByRole('textbox', { name: '搜索网络或输入网址' })).toHaveAttribute(
    'placeholder',
    /Google/,
  );
  await engine.selectOption('baidu');

  const address = page.getByRole('textbox', { name: '地址和搜索栏' });
  await address.fill('luma://bookmarks');
  await address.press('Enter');
  await page.getByRole('tab').first().click();
  await address.fill('luma://settings');
  await address.press('Enter');
  await page.getByRole('button', { name: '新建标签页 (Ctrl+T)' }).click();
  await expect(page.getByRole('tab')).toHaveCount(3);

  // Keep the simulated pointer inside the tab bar so this stays a reorder.
  await setCursorInTabBar();
  await page.getByRole('tab', { name: '新标签页' }).dragTo(page.getByRole('tab', { name: '设置' }), { targetPosition: { x: 8, y: 16 } });
  await setTestCursor(null);
  const order = await page.getByRole('tab').evaluateAll((tabs) => tabs.map((tab) => tab.textContent?.trim()));
  expect(order[0]).toContain('新标签页');
  expect(order[1]).toContain('设置');

  await page.getByRole('tab', { name: '新标签页' }).click({ button: 'right' });
  const menu = page.getByRole('menu', { name: '标签页选项' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /关闭右侧标签页/ })).toBeEnabled();
  await expect(menu.getByRole('menuitem', { name: /复制标签页/ })).toBeVisible();
  await page.screenshot({ path: 'test-results/ui-tab-context.png' });
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  const regions = await page.evaluate(() => {
    const tabbar = document.querySelector('.browser-tabbar');
    const tab = document.querySelector('.browser-tab');
    return {
      tabbar: tabbar ? getComputedStyle(tabbar).getPropertyValue('-webkit-app-region') : '',
      tab: tab ? getComputedStyle(tab).getPropertyValue('-webkit-app-region') : '',
    };
  });
  expect(regions.tabbar).toBe('drag');
  expect(regions.tab).toBe('no-drag');
});

test('shows a custom context menu on real web content', async () => {
  const address = page.getByRole('textbox', { name: '地址和搜索栏' });
  await address.fill('example.com');
  await address.press('Enter');
  await expect(page.getByRole('tab', { name: 'Example Domain' }).first()).toBeVisible({ timeout: 20_000 });
  const webContentsId = (await pageInfo()).webContentsId;
  await app.evaluate(({ webContents }, id) => {
    const guest = webContents.fromId(id);
    guest?.focus();
    guest?.sendInputEvent({ type: 'mouseMove', x: 80, y: 80 });
    guest?.sendInputEvent({ type: 'mouseDown', x: 80, y: 80, button: 'right', clickCount: 1 });
    guest?.sendInputEvent({ type: 'mouseUp', x: 80, y: 80, button: 'right', clickCount: 1 });
    // A native page view only reports the menu through this event.
    guest?.sendInputEvent({ type: 'contextMenu', x: 80, y: 80 });
  }, webContentsId);

  const menu = page.getByRole('menu', { name: '网页选项' });
  await expect(menu).toBeVisible();
  await page.waitForTimeout(200);
  const expectedPosition = await app.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.fromWebContents(BrowserWindow.getAllWindows()[0].webContents);
    const content = win?.getContentBounds();
    const cursor = screen.getCursorScreenPoint();
    return content ? { x: cursor.x - content.x, y: cursor.y - content.y } : null;
  });
  const menuBox = await menu.boundingBox();
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  if (!expectedPosition || !menuBox) throw new Error('Missing context menu geometry');
  expect(Math.abs(menuBox.x - Math.max(8, Math.min(expectedPosition.x, viewport.width - menuBox.width - 8)))).toBeLessThanOrEqual(8);
  expect(Math.abs(menuBox.y - Math.max(8, Math.min(expectedPosition.y, viewport.height - menuBox.height - 8)))).toBeLessThanOrEqual(8);
  await expect(menu.getByRole('menuitem', { name: '后退' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '重新加载' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '全选' })).toBeEnabled();
  await expect(menu.getByRole('menuitem', { name: /为此页添加书签|移除此页书签/ })).toBeVisible();
  await page.screenshot({ path: 'test-results/ui-page-context.png' });
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
});

test('shows the same context menu on internal pages', async () => {
  await page.getByRole('textbox', { name: '地址和搜索栏' }).fill('luma://bookmarks');
  await page.getByRole('textbox', { name: '地址和搜索栏' }).press('Enter');
  const main = page.getByRole('main', { name: '网页内容区域' });
  await expect(main.getByRole('heading', { name: '书签', level: 1 })).toBeVisible();

  const box = await main.boundingBox();
  if (!box) throw new Error('Missing page surface');
  await page.mouse.click(box.x + box.width - 60, box.y + 40, { button: 'right' });
  const menu = page.getByRole('menu', { name: '网页选项' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '后退' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '重新加载' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '全选' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '复制页面地址' })).toBeVisible();
  // Page-only actions stay out of the internal menu.
  await expect(menu.getByRole('menuitem', { name: /网页截图/ })).toHaveCount(0);
  await expect(menu.getByRole('menuitem', { name: /另存为 PDF/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
});

test('offers input context menus for the address bar and home search', async () => {
  await page.getByRole('button', { name: '主页', exact: true }).click();
  const homeSearch = page.getByRole('textbox', { name: '搜索网络或输入网址' });
  await homeSearch.fill('Luma Browser');
  await homeSearch.click({ button: 'right' });
  const searchMenu = page.getByRole('menu', { name: '搜索栏选项' });
  await expect(searchMenu).toBeVisible();
  await expect(searchMenu.getByRole('menuitem', { name: /^粘贴/ })).toHaveCount(2);
  await expect(searchMenu.getByRole('menuitem', { name: '全选' })).toBeVisible();
  await page.keyboard.press('Escape');

  const address = page.getByRole('textbox', { name: '地址和搜索栏' });
  await address.fill('example.com');
  await address.click({ button: 'right' });
  const addressMenu = page.getByRole('menu', { name: '地址栏选项' });
  await expect(addressMenu).toBeVisible();
  await expect(addressMenu.getByRole('menuitem', { name: '粘贴并前往' })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('opens exactly one reusable history tab', async () => {
  const historyButton = page.getByRole('button', { name: '历史记录', exact: true });
  await historyButton.click();
  await expect(page.getByRole('heading', { name: '历史记录', level: 1 })).toBeVisible();
  const tabCount = await page.getByRole('tab').count();
  await historyButton.click();
  await expect(page.getByRole('heading', { name: '历史记录', level: 1 })).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(tabCount);
});

test('navigates settings sections and supports custom search engines', async () => {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '设置', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: '快捷键' }).click();
  await expect(page.getByRole('heading', { name: '键盘快捷键' })).toBeVisible();
  await expect(page.getByText('恢复关闭的标签页')).toBeVisible();

  await page.getByRole('button', { name: '权限管理' }).click();
  await expect(page.getByRole('heading', { name: '权限管理', level: 2 })).toBeVisible();
  await expect(page.getByLabel('摄像头默认权限')).toBeVisible();
  await page.getByLabel('通知默认权限').selectOption('deny');
  await expect(page.getByLabel('通知默认权限')).toHaveValue('deny');
  await page.getByLabel('通知默认权限').selectOption('ask');
  await expect(page.getByText('还没有网站例外')).toBeVisible();
  await page.screenshot({ path: 'test-results/ui-settings-permissions.png' });

  await page.getByRole('button', { name: '搜索引擎' }).click();
  await page.getByRole('button', { name: '添加自定义' }).click();
  await page.getByLabel('搜索引擎名称').fill('站内搜索');
  await page.getByLabel(/搜索地址/).fill('https://search.example.com/?q=%s');
  await page.getByRole('button', { name: '添加并设为默认' }).click();
  await expect(page.getByRole('heading', { name: '搜索引擎', level: 2 })).toBeVisible();
  await expect(page.getByRole('radio', { name: /站内搜索/ })).toHaveAttribute('aria-checked', 'true');
  await page.screenshot({ path: 'test-results/ui-settings-search.png' });

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(390, 800);
  });
  await expect(page.getByRole('navigation', { name: '设置分类' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await page.screenshot({ path: 'test-results/ui-settings-mobile.png' });
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(1440, 900);
  });

  await page.getByRole('button', { name: '主页', exact: true }).click();
  const homeSearch = page.getByRole('textbox', { name: '搜索网络或输入网址' });
  await homeSearch.fill('Luma 自定义搜索');
  await homeSearch.press('Enter');
  await expect(page.getByRole('textbox', { name: '地址和搜索栏' })).toHaveValue(/search\.example\.com/);
});

test('creates a bookmark folder and files a bookmark inside it', async () => {
  const address = page.getByRole('textbox', { name: '地址和搜索栏' });
  await address.fill('luma://bookmarks');
  await address.press('Enter');
  const main = page.getByRole('main', { name: '网页内容区域' });
  await expect(main.getByRole('heading', { name: '书签', level: 1 })).toBeVisible();

  await main.getByRole('button', { name: '新建文件夹' }).click();
  await page.getByLabel('文件夹名称').fill('工作资料');
  await page.getByLabel('文件夹名称').press('Enter');
  await expect(main.getByRole('button', { name: /^工作资料/ })).toBeVisible();

  await main.locator('.library-hero').getByRole('button', { name: '添加书签', exact: true }).click();
  await page.locator('#add-bookmark-form input').nth(0).fill('团队知识库');
  await page.locator('#add-bookmark-form input').nth(1).fill('https://example.com/team');
  await expect(page.getByRole('dialog', { name: '添加书签' }).getByLabel('书签文件夹')).toHaveValue(/.+/);
  await page.getByRole('button', { name: '保存书签' }).click();
  const tree = main.getByRole('tree', { name: '书签树' });
  await expect(tree.getByRole('treeitem', { name: /工作资料/ })).toBeVisible();
  await expect(tree.getByRole('treeitem', { name: /团队知识库/ })).toBeVisible();

  await page.locator('.bookmarks-bar').getByRole('button', { name: /工作资料/ }).click();
  const folderMenu = page.getByRole('menu', { name: '文件夹 工作资料' });
  await expect(folderMenu).toBeVisible();
  await expect(folderMenu.getByRole('menuitem', { name: /团队知识库/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(folderMenu).toHaveCount(0);
  await page.screenshot({ path: 'test-results/ui-bookmark-folders.png' });

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(390, 800);
  });
  await expect(main.getByRole('complementary', { name: '书签文件夹' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await page.screenshot({ path: 'test-results/ui-bookmark-folders-mobile.png' });
});

test('opens clicked links and target=_blank popups from web content', async () => {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(1440, 900);
  });
  const address = page.getByRole('textbox', { name: '地址和搜索栏' });
  await page.getByRole('button', { name: '新建标签页 (Ctrl+T)' }).click();
  await address.fill('example.com');
  await address.press('Enter');

  const currentUrl = async () => (await pageInfo()).url;
  await expect.poll(currentUrl, { timeout: 30_000 }).toContain('example.com');

  const guestId = (await pageInfo()).webContentsId;
  const appendLink = (href: string, target: string, top: number) =>
    app.evaluate(
      async ({ webContents }, args) => {
        const contents = webContents.fromId(args.id);
        return contents?.executeJavaScript(`(() => {
          const link = document.createElement('a');
          link.href = ${JSON.stringify(args.href)};
          link.target = ${JSON.stringify(args.target)};
          link.textContent = 'Luma test link';
          link.style.cssText = 'position:fixed;left:40px;top:${args.top}px;z-index:2147483647;font-size:24px;background:#fff;color:#000;padding:12px';
          document.body.appendChild(link);
          const rect = link.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        })()`);
      },
      { id: guestId, href, target, top },
    );

  // Native page views receive input from the main process, not from page.mouse.
  const clickLink = async (rect: { x: number; y: number; width: number; height: number } | null) => {
    if (!rect) throw new Error('Missing link geometry');
    const x = Math.round(rect.x + rect.width / 2);
    const y = Math.round(rect.y + rect.height / 2);
    await app.evaluate(({ webContents }, args) => {
      const contents = webContents.fromId(args.id);
      contents?.focus();
      contents?.sendInputEvent({ type: 'mouseMove', x: args.x, y: args.y });
      contents?.sendInputEvent({ type: 'mouseDown', x: args.x, y: args.y, button: 'left', clickCount: 1 });
      contents?.sendInputEvent({ type: 'mouseUp', x: args.x, y: args.y, button: 'left', clickCount: 1 });
    }, { id: guestId, x, y });
  };

  await clickLink(await appendLink('https://example.com/?clicked=1', '_self', 220));
  await expect.poll(currentUrl, { timeout: 30_000 }).toContain('clicked=1');

  const tabCount = await page.getByRole('tab').count();
  await clickLink(await appendLink('https://example.com/?popup=1', '_blank', 320));
  await expect(page.getByRole('tab')).toHaveCount(tabCount + 1);
  await expect
    .poll(() => pageInfo(), { timeout: 30_000 })
    .toMatchObject({ url: expect.stringContaining('popup=1') });
});

test('hands the real page to a window that follows the cursor', async () => {
  await page.getByRole('textbox', { name: '地址和搜索栏' }).fill('example.com/?follow=1');
  await page.getByRole('textbox', { name: '地址和搜索栏' }).press('Enter');
  await expect(page.getByRole('tab', { name: 'Example Domain' }).first()).toBeVisible({ timeout: 20_000 });

  await page.getByRole('button', { name: '新建标签页 (Ctrl+T)' }).click();
  await page.getByRole('textbox', { name: '地址和搜索栏' }).fill('example.com/?follow=2');
  await page.getByRole('textbox', { name: '地址和搜索栏' }).press('Enter');
  await expect.poll(async () => (await pageInfo()).url, { timeout: 20_000 }).toContain('follow=2');

  const tabId = await activeTabId();
  const pageBounds = (await pageInfo(tabId)).bounds;
  const windowsBefore = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((win) => win.id));
  const tabsBefore = await page.getByRole('tab').count();

  const dispatch = (type: 'dragstart' | 'drag' | 'dragend', args: { clientX: number; clientY: number; screenX: number; screenY: number }) => (
    page.locator('.browser-tab.is-active').evaluate((element, payload) => {
      const data = new DataTransfer();
      data.setData('text/plain', element.getAttribute('data-tab-id') || '');
      data.setData('application/x-luma-item', 'tab');
      element.dispatchEvent(new DragEvent(payload.type, {
        bubbles: true,
        cancelable: true,
        dataTransfer: data,
        clientX: payload.clientX,
        clientY: payload.clientY,
        screenX: payload.screenX,
        screenY: payload.screenY,
      }));
    }, { type, ...args })
  );

  const dropPoint = { screenX: 720, screenY: 520 };
  await dispatch('dragstart', { clientX: 200, clientY: 18, ...dropPoint });
  // Leaving the tab bar (clientY > 40) starts the tear-off.
  await dispatch('drag', { clientX: 520, clientY: 320, ...dropPoint });

  // A frameless window now carries the live page: the view moved there as is.
  await expect.poll(
    () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
    { timeout: 10_000 },
  ).toBe(windowsBefore.length + 1);
  const follower = await app.evaluate(({ BrowserWindow }, before) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => !before.includes(candidate.id));
    return win ? { bounds: win.getBounds(), resizable: win.isResizable(), url: win.webContents.getURL() } : null;
  }, windowsBefore);
  expect(follower).not.toBeNull();
  expect(follower!.resizable).toBe(false);
  // The follower wears a tab bar and a toolbar, so the page starts 86px lower.
  const moving = (await pageInfo(tabId)).bounds;
  expect(moving.x).toBe(0);
  expect(moving.y).toBe(86);
  expect(Math.abs(moving.height - (follower!.bounds.height - 86))).toBeLessThanOrEqual(2);
  expect(follower!.bounds.width).toBeGreaterThan(pageBounds.width - 8);

  await dispatch('dragend', { clientX: 200, clientY: 18, ...dropPoint });
  await expect.poll(
    () => page.getByRole('tab').count(),
    { timeout: 10_000 },
  ).toBe(tabsBefore - 1);
  // The frameless follower is replaced by a normal browser window that keeps the page.
  await expect.poll(
    () => app.evaluate(({ BrowserWindow }, before) => BrowserWindow.getAllWindows()
      .filter((win) => !before.includes(win.id))
      .filter((win) => !win.isResizable()).length, windowsBefore),
    { timeout: 10_000 },
  ).toBe(0);
  await expect.poll(
    () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
    { timeout: 10_000 },
  ).toBe(windowsBefore.length + 1);

  await app.evaluate(({ BrowserWindow }, before) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!before.includes(win.id)) win.close();
    }
  }, windowsBefore);
  await page.waitForTimeout(400);
});

test('finds text in a native page and keeps the page visible under the find bar', async () => {
  await page.getByRole('button', { name: '新建标签页 (Ctrl+T)' }).click();
  const address = page.getByRole('textbox', { name: '地址和搜索栏' });
  await address.fill('example.com/?find=1');
  await address.press('Enter');
  await expect(page.getByRole('tab', { name: 'Example Domain' }).last()).toBeVisible({ timeout: 20_000 });
  await expect.poll(async () => (await pageInfo()).url, { timeout: 20_000 }).toContain('find=1');

  const before = await pageInfo();
  await page.keyboard.press('Control+f');
  const bar = page.locator('.find-bar');
  await expect(bar).toBeVisible();

  // The native page makes room for the bar instead of being covered by it.
  await expect.poll(async () => (await pageInfo()).bounds.y, { timeout: 5_000 })
    .toBeGreaterThanOrEqual(before.bounds.y + 40);

  await bar.getByLabel('查找内容').fill('domain');
  await expect(bar.locator('.find-bar__count')).toHaveText(/\d+\/\d+/, { timeout: 10_000 });
  // Matches are drawn by the page itself, so the page must stay visible.
  expect((await pageInfo()).visible).toBe(true);

  await page.keyboard.press('Escape');
  await expect(bar).toHaveCount(0);
  await expect.poll(async () => (await pageInfo()).bounds.y, { timeout: 5_000 }).toBe(before.bounds.y);
});

test('shows and manages website data in privacy settings', async () => {
  const address = page.getByRole('textbox', { name: '地址和搜索栏' });
  await address.fill('luma://settings');
  await address.press('Enter');
  await page.getByRole('button', { name: '隐私与安全' }).click();

  await expect(page.getByRole('heading', { name: '网站数据管理' })).toBeVisible();
  await expect(page.getByText('缓存占用', { exact: true })).toBeVisible();
  await expect(page.getByText('Cookie 总数', { exact: true })).toBeVisible();
  await expect(page.getByText('已发现网站', { exact: true })).toBeVisible();
  await expect(page.getByText('正在读取网站数据…')).toHaveCount(0, { timeout: 10_000 });

  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.getByText('正在读取网站数据…')).toHaveCount(0, { timeout: 10_000 });

  await page.getByRole('button', { name: '清除缓存' }).click();
  await expect(page.getByText('网页缓存已清除')).toBeVisible();
});

test('opens an incognito window and the download manager', async () => {
  const incognitoPromise = app.waitForEvent('window');
  await page.keyboard.press('Control+Shift+N');
  const incognito = await incognitoPromise;
  await incognito.waitForLoadState('domcontentloaded');
  await expect(incognito.locator('.incognito-badge')).toBeVisible();
  expect(await incognito.evaluate(() => Boolean(window.lumaDesktop?.isIncognito))).toBe(true);
  await expect(incognito.getByRole('heading', { name: '新标签页' })).toBeVisible();

  const incognitoAddress = incognito.getByRole('textbox', { name: '地址和搜索栏' });
  await incognitoAddress.fill('example.com');
  await incognitoAddress.press('Enter');
  await expect(incognito.getByRole('tab', { name: 'Example Domain' })).toBeVisible({ timeout: 30_000 });
  await incognitoAddress.fill('luma://history');
  await incognitoAddress.press('Enter');
  await expect(incognito.getByRole('heading', { name: '还没有浏览足迹' })).toBeVisible();

  const downloadsPromise = app.waitForEvent('window');
  await incognito.keyboard.press('Control+J');
  const downloads = await downloadsPromise;
  await downloads.waitForLoadState('domcontentloaded');
  await expect(downloads.getByRole('heading', { name: '下载内容', exact: true, level: 1 })).toBeVisible();
  await expect(downloads.getByText('还没有下载内容')).toBeVisible();

  await downloads.close();
  await incognito.close();
});

test('saves a download and lists it in the download manager', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="luma-e2e.txt"',
    });
    response.end('luma download test');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  try {
    await app.evaluate(
      ({ session }, url) => session.fromPartition('persist:luma-browser').downloadURL(url),
      `http://127.0.0.1:${port}/luma-e2e.txt`,
    );

    await expect
      .poll(
        async () => page.evaluate(async () => {
          const items = await window.lumaDesktop?.listDownloads();
          return items?.find((item) => item.filename === 'luma-e2e.txt')?.state;
        }),
        { timeout: 20_000 },
      )
      .toBe('completed');

    const downloadsPromise = app.waitForEvent('window');
    await page.keyboard.press('Control+J');
    const downloads = await downloadsPromise;
    await downloads.waitForLoadState('domcontentloaded');
    await expect(downloads.getByText('luma-e2e.txt', { exact: true })).toBeVisible();
    await expect(downloads.getByText('已完成', { exact: true })).toBeVisible();

    const record = await page.evaluate(async () => {
      const items = await window.lumaDesktop?.listDownloads();
      return items?.find((item) => item.filename === 'luma-e2e.txt');
    });
    expect(record?.speed).toBe(0);
    expect(record?.savePath).toBeTruthy();
    expect(existsSync(record!.savePath!)).toBe(true);

    await app.evaluate(({ dialog }) => {
      (dialog as unknown as { showMessageBox: unknown }).showMessageBox = async () => ({
        response: 1,
        checkboxChecked: false,
      });
    });
    await downloads.getByRole('button', { name: '删除 luma-e2e.txt 及其本地文件' }).click();
    await expect.poll(() => existsSync(record!.savePath!), { timeout: 10_000 }).toBe(false);
    await expect(downloads.getByText('还没有下载内容')).toBeVisible();

    await downloads.close();
  } finally {
    server.close();
  }
});

test('opens a link dropped onto the page area', async () => {
  await page.evaluate(() => {
    const target = document.querySelector('.browser-content');
    if (!target) throw new Error('Missing content area');
    const data = new DataTransfer();
    data.setData('text/uri-list', 'https://example.com/?dropped=1');
    data.setData('text/plain', 'https://example.com/?dropped=1');
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
  });

  const address = page.getByRole('textbox', { name: '地址和搜索栏' });
  await expect(address).toHaveValue(/dropped=1/, { timeout: 10_000 });
  await expect(page.getByRole('tab', { name: 'Example Domain' }).first()).toBeVisible({ timeout: 30_000 });
});

test('keeps the window alive when a bookmark folder is double-clicked', async () => {
  const windowId = await mainWindowId();
  await app.evaluate(({ BrowserWindow }, id) => {
    const win = BrowserWindow.fromId(id);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    win.setSize(1440, 900);
  }, windowId);
  const address = page.getByRole('textbox', { name: '地址和搜索栏' });
  await address.fill('luma://bookmarks');
  await address.press('Enter');
  const main = page.getByRole('main', { name: '网页内容区域' });
  await expect(main.getByRole('heading', { name: '书签', level: 1 })).toBeVisible();

  const errors: string[] = [];
  const onPageError = (error: Error) => errors.push(error.message);
  page.on('pageerror', onPageError);
  // Earlier tests may have switched the bookmarks bar off; the shortcut makes
  // this test independent of what ran before it.
  if (await page.locator('.bookmarks-bar').count() === 0) {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Control+Shift+B');
    await expect(page.locator('.bookmarks-bar')).toBeVisible();
  }
  // Guarantee the fixture exists: an earlier test may have removed or renamed
  // the folder, and this test must not depend on what ran before it.
  const folderButton = page.locator('.bookmarks-bar').getByRole('button', { name: /工作资料/ });
  if (await folderButton.count() === 0) {
    await main.getByRole('button', { name: '新建文件夹' }).click();
    await page.getByLabel('文件夹名称').fill('工作资料');
    await page.getByLabel('文件夹名称').press('Enter');
    await expect(main.getByRole('button', { name: /^工作资料/ })).toBeVisible();
  }
  await folderButton.dblclick();
  // A double click used to open and immediately close the folder menu; the
  // second click must not be treated as "dismiss".
  const folderMenu = page.getByRole('menu', { name: /文件夹 工作资料/ });
  await expect(folderMenu).toBeVisible();
  await expect(folderMenu.getByRole('menuitem', { name: /团队知识库/ })).toBeVisible();
  await page.waitForTimeout(300);
  // Leave no menu behind: its full-screen dismiss layer would swallow clicks
  // in later tests.
  await page.keyboard.press('Escape');
  await expect(folderMenu).toHaveCount(0);
  page.off('pageerror', onPageError);

  expect(errors).toEqual([]);
  await expect(main.getByRole('heading', { name: '书签', level: 1 })).toBeVisible();
  expect(await page.locator('#root').evaluate((element) => element.childElementCount)).toBeGreaterThan(0);
});

test('accepts links dropped on the empty area of the tab bar', async () => {
  const region = await page.locator('.tab-list').evaluate((element) =>
    getComputedStyle(element).getPropertyValue('-webkit-app-region'),
  );
  expect(region).toBe('drag');

  const before = await page.getByRole('tab').count();
  await page.evaluate(() => {
    const target = document.querySelector('.tab-list');
    if (!target) throw new Error('Missing tab list');
    const data = new DataTransfer();
    data.setData('text/uri-list', 'https://example.com/?tabbar-drop=1');
    data.setData('text/plain', 'https://example.com/?tabbar-drop=1');
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
  });

  await expect(page.getByRole('tab')).toHaveCount(before + 1);
  await expect(page.getByRole('textbox', { name: '地址和搜索栏' })).toHaveValue(/tabbar-drop=1/);
});

test('opens recent pages in a new tab', async () => {
  const before = await page.getByRole('tab').count();
  await page.getByRole('button', { name: '最近打开' }).click();
  const menu = page.getByRole('menu', { name: '最近打开' });
  await expect(menu).toBeVisible();
  const first = menu.locator('.recent-menu__item').first();
  await expect(first).toBeVisible();
  const label = (await first.locator('.recent-menu__text strong').textContent())?.trim() ?? '';

  await first.click();
  await expect(menu).toHaveCount(0);
  await expect(page.getByRole('tab')).toHaveCount(before + 1);
  // An entry without a loaded title shows its URL; the tab then adopts the page title.
  if (label && !/^https?:/i.test(label)) await expect(page.getByRole('tab', { name: label }).first()).toBeVisible();
});

test('shows an audio indicator and lets the user mute a tab', async () => {
  await page.getByRole('button', { name: '新建标签页 (Ctrl+T)' }).click();
  const address = page.getByRole('textbox', { name: '地址和搜索栏' });
  await address.fill('example.com');
  await address.press('Enter');
  await expect(page.getByRole('tab', { name: 'Example Domain' }).last()).toBeVisible({ timeout: 30_000 });

  const tab = page.locator('.browser-tab.is-active');
  const audioState = async () => {
    const id = (await pageInfo()).webContentsId;
    return app.evaluate(({ webContents }, target) => {
      const contents = webContents.fromId(target);
      return contents ? contents.isAudioMuted() : null;
    }, id);
  };

  // The page reports playback to the main process; the tab mirrors it.
  await app.evaluate(({ webContents }, id) => {
    webContents.fromId(id)?.emit('media-started-playing');
  }, (await pageInfo()).webContentsId);
  await expect(tab.locator('.browser-tab__audio')).toBeVisible();

  await tab.locator('.browser-tab__audio').click();
  await expect.poll(audioState).toBe(true);
  await expect(tab.locator('.browser-tab__audio')).toHaveClass(/is-muted/);

  await tab.locator('.browser-tab__audio').click();
  await expect.poll(audioState).toBe(false);

  await app.evaluate(({ webContents }, id) => {
    webContents.fromId(id)?.emit('media-paused');
  }, (await pageInfo()).webContentsId);
  await expect(tab.locator('.browser-tab__audio')).toHaveCount(0);
});

test('opens settings in a new tab and applies webpage font and zoom preferences', async () => {
  const tabCount = await page.getByRole('tab').count();

  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '设置', level: 1 })).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(tabCount + 1);

  await page.getByLabel('网页缩放').evaluate((element, value) => {
    const input = element as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, 150);
  await expect(page.locator('.zoom-control strong')).toHaveText('150%');
  await page.getByLabel('网页字号').selectOption('22');
  await page.getByLabel('网页字体').selectOption({ label: '宋体' });

  const exampleTab = await tabIdByUrl('example.com');
  const zoom = async () => {
    const id = (await pageInfo(exampleTab)).webContentsId;
    return app.evaluate(({ webContents }, target) => webContents.fromId(target)?.getZoomFactor() ?? 0, id);
  };
  await expect.poll(zoom).toBeCloseTo(1.5, 2);
  await expect
    .poll(() => runInPage<string>('getComputedStyle(document.body).fontSize', exampleTab))
    .toBe('22px');

  const displayCard = page.locator('.settings-card').filter({ hasText: '网页显示' });
  await displayCard.getByRole('button', { name: '重置' }).click();
  await page.getByLabel('网页字号').selectOption('16');
  await page.getByLabel('网页字体').selectOption('');
  await expect.poll(zoom).toBeCloseTo(1, 2);
});

test('changes the default download directory', async () => {
  // Self-contained: the settings page may have been left on another section.
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '设置', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: '更改位置' })).toBeVisible();

  const custom = path.join(userDataDir, 'CustomDownloads');
  mkdirSync(custom, { recursive: true });
  await app.evaluate(({ dialog }, directory) => {
    (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => ({
      canceled: false,
      filePaths: [directory],
    });
  }, custom);

  await page.getByRole('button', { name: '更改位置' }).click();
  await expect(page.locator('.download-path')).toHaveText(custom);
  const info = await page.evaluate(() => window.lumaDesktop?.getDownloadDirectory());
  expect(info?.directory).toBe(custom);
  expect(info?.isDefault).toBe(false);

  await page.getByRole('button', { name: '恢复默认' }).click();
  await expect.poll(
    async () => (await page.evaluate(() => window.lumaDesktop?.getDownloadDirectory()))?.isDefault,
  ).toBe(true);
  const restored = await page.evaluate(() => window.lumaDesktop?.getDownloadDirectory());
  expect(restored?.directory).not.toBe(custom);
  // The default lives one level above the application folder (or Downloads
  // while running from source).
  expect(restored?.directory ?? '').not.toContain('LumaDownload');
});

test('imports and exports bookmark HTML files', async () => {
  const address = page.getByRole('textbox', { name: '地址和搜索栏' });
  await address.fill('luma://bookmarks');
  await address.press('Enter');
  const main = page.getByRole('main', { name: '网页内容区域' });
  await expect(main.getByRole('heading', { name: '书签', level: 1 })).toBeVisible();

  const importFile = path.join(userDataDir, 'import-bookmarks.html');
  writeFileSync(
    importFile,
    [
      '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
      '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
      '<TITLE>Bookmarks</TITLE>',
      '<DL><p>',
      '    <DT><H3>导入资料</H3>',
      '    <DL><p>',
      '        <DT><A HREF="https://example.com/imported">导入的书签</A>',
      '    </DL><p>',
      '</DL><p>',
    ].join('\n'),
    'utf8',
  );
  await app.evaluate(({ dialog }, filePath) => {
    (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => ({
      canceled: false,
      filePaths: [filePath],
    });
  }, importFile);

  await page.getByRole('button', { name: '导入书签' }).click();
  await expect(page.getByText('已导入 1 个书签').first()).toBeVisible();
  await expect(page.getByText('导入的书签', { exact: true })).toBeVisible();
  await expect(main.getByRole('button', { name: /^导入资料/ })).toBeVisible();

  const exportFile = path.join(userDataDir, 'exported-bookmarks.html');
  await app.evaluate(({ dialog }, filePath) => {
    (dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = async () => ({
      canceled: false,
      filePath,
    });
  }, exportFile);

  await page.getByRole('button', { name: '导出书签' }).click();
  await expect.poll(() => existsSync(exportFile), { timeout: 10_000 }).toBe(true);
  const exported = readFileSync(exportFile, 'utf8');
  expect(exported).toContain('导入的书签');
  expect(exported).toContain('导入资料');
  await expect(page.getByText('书签已导出')).toBeVisible();
});

test('persists the maximized window state', async () => {
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  const statePath = path.join(userData, 'window-state.json');
  const maximized = () => {
    try {
      return JSON.parse(readFileSync(statePath, 'utf8')).maximized;
    } catch {
      return undefined;
    }
  };

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize());
  await expect.poll(maximized, { timeout: 10_000 }).toBe(true);

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].unmaximize());
  await expect.poll(maximized, { timeout: 10_000 }).toBe(false);
});

test('shows download speed while a transfer is in progress', async () => {
  const total = 1024 * 1024;
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(total),
      'Content-Disposition': 'attachment; filename="luma-slow.bin"',
    });
    const chunk = Buffer.alloc(16 * 1024, 2);
    let sent = 0;
    const timer = setInterval(() => {
      if (sent >= total) {
        clearInterval(timer);
        response.end();
        return;
      }
      response.write(chunk);
      sent += chunk.length;
    }, 150);
    response.on('close', () => clearInterval(timer));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  try {
    await app.evaluate(
      ({ session }, url) => session.fromPartition('persist:luma-browser').downloadURL(url),
      `http://127.0.0.1:${port}/luma-slow.bin`,
    );

    const downloadsPromise = app.waitForEvent('window');
    await page.keyboard.press('Control+J');
    const downloads = await downloadsPromise;
    await downloads.waitForLoadState('domcontentloaded');
    await expect(downloads.getByText('luma-slow.bin', { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(downloads.locator('.download-item__speed')).toBeVisible({ timeout: 20_000 });
    await expect(downloads.locator('.download-item__speed')).toHaveText(/\/s$/);

    await downloads.getByRole('button', { name: '取消下载' }).click();
    await expect(downloads.getByText('已取消', { exact: true })).toBeVisible({ timeout: 10_000 });
    await downloads.close();
  } finally {
    server.close();
  }
});

test('opens bookmarks in new tabs from the manager and the bookmarks bar', async () => {
  const address = page.getByRole('textbox', { name: '地址和搜索栏' });
  await address.fill('luma://bookmarks');
  await address.press('Enter');
  const main = page.getByRole('main', { name: '网页内容区域' });
  await expect(main.getByRole('heading', { name: '书签', level: 1 })).toBeVisible();

  await main.getByRole('button', { name: '新建文件夹' }).click();
  await page.getByLabel('文件夹名称').fill('打开测试');
  await page.getByLabel('文件夹名称').press('Enter');
  await expect(main.getByRole('button', { name: /^打开测试/ })).toBeVisible();

  await main.locator('.library-hero').getByRole('button', { name: '添加书签', exact: true }).click();
  await page.locator('#add-bookmark-form input').nth(0).fill('新标签测试');
  await page.locator('#add-bookmark-form input').nth(1).fill('https://example.com/open-in-tab');
  await page.getByRole('button', { name: '保存书签' }).click();

  const tree = main.getByRole('tree', { name: '书签树' });
  const beforeManager = await page.getByRole('tab').count();
  await tree.getByRole('treeitem', { name: /新标签测试/ }).click();
  await expect(page.getByRole('tab')).toHaveCount(beforeManager + 1);
  await expect(address).toHaveValue(/example\.com\/open-in-tab/);

  await page.locator('.bookmarks-bar__folder', { hasText: '打开测试' }).click();
  const folderMenu = page.getByRole('menu', { name: '文件夹 打开测试' });
  const beforeBar = await page.getByRole('tab').count();
  await folderMenu.getByRole('menuitem', { name: /新标签测试/ }).click();
  await expect(page.getByRole('tab')).toHaveCount(beforeBar + 1);
});

test('keeps the recent pages button left of the address bar and pastes from the context menu', async () => {
  await page.getByRole('button', { name: '主页', exact: true }).click();
  const recent = page.getByRole('button', { name: '最近打开' });
  await expect(recent).toBeVisible();
  const leftOfAddress = await page.evaluate(() => {
    const button = document
      .querySelector('.navigation-controls button[aria-label="最近打开"]');
    const address = document.getElementById('browser-address');
    if (!button || !address) return false;
    return button.getBoundingClientRect().right < address.getBoundingClientRect().left;
  });
  expect(leftOfAddress).toBe(true);

  await app.evaluate(({ clipboard }) => clipboard.writeText('example.net'));
  const address = page.getByRole('textbox', { name: '地址和搜索栏' });
  await address.fill('');
  await address.click({ button: 'right' });
  await page.getByRole('menu', { name: '地址栏选项' }).getByRole('menuitem', { name: '粘贴 Ctrl+V' }).click();
  await expect(address).toHaveValue('example.net');
});

test('toggles fullscreen and developer tools from the browser menu', async () => {
  await page.getByRole('button', { name: '主页', exact: true }).click();
  await expect(page.getByRole('heading', { name: '今天，想去哪里？' })).toBeVisible();

  await page.getByRole('button', { name: '自定义及控制 Luma' }).click();
  const menu = page.locator('.browser-menu');
  await expect(menu.getByRole('button', { name: /^全屏/ })).toBeVisible();
  await expect(menu.getByRole('button', { name: /^开发者工具/ })).toHaveCount(0);

  await menu.getByRole('button', { name: /^全屏/ }).click();
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen()), { timeout: 10_000 })
    .toBe(true);
  await page.keyboard.press('F11');
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen()), { timeout: 10_000 })
    .toBe(false);

  // Internal pages refuse to open developer tools, including through F12.
  await page.keyboard.press('F12');
  await expect(page.locator('aside[aria-label="开发者工具"]')).toHaveCount(0);

  const address = page.getByRole('textbox', { name: '地址和搜索栏' });
  await address.fill('https://example.com');
  await address.press('Enter');
  await expect.poll(async () => (await pageInfo()).url, { timeout: 30_000 }).toContain('example.com');

  await page.getByRole('button', { name: '自定义及控制 Luma' }).click();
  await page.locator('.browser-menu').getByRole('button', { name: /^开发者工具/ }).click();
  const panel = page.locator('aside[aria-label="开发者工具"]');
  await expect(panel).toBeVisible();
  await expect
    .poll(
      () => app.evaluate(({ webContents }) => webContents.getAllWebContents().some((contents) => contents.getURL().startsWith('devtools://'))),
      { timeout: 15_000 },
    )
    .toBe(true);
  // The DevTools frontend must render real UI content, not a blank surface.
  const backendId = await app.evaluate(async ({ webContents }) => {
    const devtools = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith('devtools://'));
    return devtools ? devtools.id : 0;
  });
  expect(backendId).toBeGreaterThan(0);
  await expect
    .poll(
      () => app.evaluate(async ({ webContents }, id) => {
        const devtools = webContents.fromId(id);
        if (!devtools) return 0;
        const image = await devtools.capturePage();
        const { width, height } = image.getSize();
        const bitmap = image.toBitmap();
        let ink = 0;
        for (let index = 0; index < bitmap.length; index += 4) {
          if (bitmap[index] < 235 || bitmap[index + 1] < 235 || bitmap[index + 2] < 235) ink += 1;
        }
        return ink / Math.max(1, width * height);
      }, backendId),
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0.02);
  const devtoolsShot = await app.evaluate(async ({ webContents }, id) => {
    const devtools = webContents.fromId(id);
    if (!devtools) return '';
    const image = await devtools.capturePage();
    return image.toPNG().toString('base64');
  }, backendId);
  writeFileSync(path.join('test-results', 'ui-devtools-native.png'), Buffer.from(devtoolsShot, 'base64'));

  const handle = page.getByRole('separator', { name: '调整开发者工具宽度' });
  const panelBox = await panel.boundingBox();
  const handleBox = await handle.boundingBox();
  expect(panelBox).not.toBeNull();
  expect(handleBox).not.toBeNull();
  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + 100);
  await page.mouse.down();
  await page.mouse.move(panelBox!.x - 120, handleBox!.y + 100, { steps: 6 });
  await page.mouse.up();
  await expect
    .poll(async () => (await panel.boundingBox())?.width ?? 0, { timeout: 5_000 })
    .toBeGreaterThan(panelBox!.width + 80);

  await page.getByRole('button', { name: '关闭开发者工具' }).click();
  await expect(panel).toHaveCount(0);

  await page.keyboard.press('F12');
  await expect(panel).toBeVisible();
  await page.keyboard.press('F12');
  await expect(panel).toHaveCount(0);
});

test('reorders bookmark folders by dragging in the tree and the bookmarks bar', async () => {
  const address = page.getByRole('textbox', { name: '地址和搜索栏' });
  await address.fill('luma://bookmarks');
  await address.press('Enter');
  const main = page.getByRole('main', { name: '网页内容区域' });
  await expect(main.getByRole('tree', { name: '书签树' })).toBeVisible();

  for (const name of ['拖拽甲', '拖拽乙']) {
    await main.getByRole('button', { name: '新建文件夹' }).click();
    await page.getByLabel('文件夹名称').fill(name);
    await page.getByLabel('文件夹名称').press('Enter');
    await expect(main.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible();
  }
  await main.getByRole('button', { name: /^全部书签/ }).click();

  const rootRow = main.locator('.bookmark-tree__row--root-link', { hasText: '根书签并列测试' });
  await main.locator('.library-hero').getByRole('button', { name: '添加书签', exact: true }).click();
  await page.locator('#add-bookmark-form input').nth(0).fill('根书签并列测试');
  await page.locator('#add-bookmark-form input').nth(1).fill('https://example.com/root-interleave');
  await page.getByRole('button', { name: '保存书签' }).click();
  await expect(rootRow).toBeVisible();
  await expect(main.getByRole('treeitem', { name: /^未分类/ })).toHaveCount(0);

  const folderNames = () => main.locator('.bookmark-tree__row--folder .bookmark-tree__title').allTextContents();
  await expect.poll(async () => {
    const names = await folderNames();
    return names.indexOf('拖拽甲') >= 0 && names.indexOf('拖拽甲') < names.indexOf('拖拽乙');
  }, { timeout: 10_000 }).toBe(true);

  await main.locator('.bookmark-tree__row--folder', { hasText: '拖拽甲' })
    .dragTo(main.locator('.bookmark-tree__row--folder', { hasText: '拖拽乙' }));
  await expect.poll(async () => {
    const names = await folderNames();
    return names.indexOf('拖拽乙') < names.indexOf('拖拽甲');
  }, { timeout: 10_000 }).toBe(true);

  const rootOrder = () => main.locator('.bookmark-tree > *').evaluateAll((nodes) => nodes.map((node) => {
    const label = node.querySelector('.bookmark-tree__title')?.textContent ?? '';
    return `${node.classList.contains('bookmark-tree__row--root-link') ? 'bookmark' : 'folder'}:${label}`;
  }));
  await rootRow.dragTo(main.locator('.bookmark-tree__row--folder', { hasText: '拖拽乙' }), {
    targetPosition: { x: 30, y: 2 },
  });
  await expect.poll(async () => {
    const order = await rootOrder();
    return order.indexOf('bookmark:根书签并列测试') >= 0
      && order.indexOf('bookmark:根书签并列测试') < order.indexOf('folder:拖拽乙');
  }, { timeout: 10_000 }).toBe(true);

  const barFolderNames = () => page.locator('.bookmarks-bar__folder').allTextContents();
  const barBefore = await barFolderNames();
  expect(barBefore.findIndex((name) => name.includes('拖拽乙')))
    .toBeLessThan(barBefore.findIndex((name) => name.includes('拖拽甲')));

  await page.locator('.bookmarks-bar__folder', { hasText: '拖拽甲' })
    .dragTo(page.locator('.bookmarks-bar__folder', { hasText: '拖拽乙' }));
  await expect.poll(async () => {
    const names = await barFolderNames();
    return names.findIndex((name) => name.includes('拖拽甲'))
      < names.findIndex((name) => name.includes('拖拽乙'));
  }, { timeout: 10_000 }).toBe(true);

  // Narrowing the row forces overflow; hidden entries must be reachable from the "more" popover.
  const items = page.locator('.bookmarks-bar__items');
  const setRowWidth = (width: string) => items.evaluate((element, value) => {
    const row = element as HTMLElement;
    row.style.flex = value ? `0 0 ${value}` : '';
    row.style.width = value;
  }, width);
  await setRowWidth('240px');
  const more = page.getByRole('button', { name: /展开隐藏的书签/ });
  await expect(more).toBeVisible();
  await more.click();
  const overflow = page.getByRole('menu', { name: '更多书签' });
  await expect(overflow).toBeVisible();
  await expect(overflow.getByRole('menuitem', { name: /拖拽乙/ })).toBeVisible();
  await expect(overflow.getByRole('menuitem', { name: /拖拽甲/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(overflow).toHaveCount(0);
  await setRowWidth('');
  await expect(more).toHaveCount(0);
});

test('turns the reload button into a stop button while a page is loading', async () => {
  const server = createServer((_request, response) => {
    const timer = setTimeout(() => {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end('<html><head><title>慢速页面</title></head><body>loaded</body></html>');
    }, 4_000);
    response.on('close', () => clearTimeout(timer));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const addressInfo = server.address();
    if (!addressInfo || typeof addressInfo === 'string') throw new Error('Missing test server port');
    await page.getByRole('button', { name: '新建标签页 (Ctrl+T)' }).click();
    const address = page.getByRole('textbox', { name: '地址和搜索栏' });
    await address.fill(`http://127.0.0.1:${addressInfo.port}/slow`);
    await address.press('Enter');
    const stop = page.getByRole('button', { name: '停止加载', exact: true });
    await expect(stop).toBeVisible({ timeout: 5_000 });
    await stop.click();
    await expect(page.getByRole('button', { name: '刷新 (Ctrl+R)', exact: true })).toBeVisible();
    await expect(page.locator('.loading-track')).toHaveCount(0);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test('tears a tab into a new window without reloading either page', async () => {
  // Two live pages: one stays behind, one is dragged out.
  const tabsBefore = await page.getByRole('tab').count();
  await page.getByRole('textbox', { name: '地址和搜索栏' }).fill('example.com/?keep-live=1');
  await page.getByRole('textbox', { name: '地址和搜索栏' }).press('Enter');
  await expect(page.getByRole('tab', { name: 'Example Domain' }).first()).toBeVisible({ timeout: 20_000 });
  const keptTab = await activeTabId();
  await runInPage('window.__lumaKept = "kept"', keptTab);

  await page.getByRole('button', { name: '新建标签页 (Ctrl+T)' }).click();
  const address = page.getByRole('textbox', { name: '地址和搜索栏' });
  await address.fill('example.com/?tearoff-live=1');
  await address.press('Enter');
  await expect(page.getByRole('tab')).toHaveCount(tabsBefore + 1, { timeout: 20_000 });
  await expect.poll(async () => (await pageInfo()).url, { timeout: 20_000 }).toContain('tearoff-live=1');
  const tornTab = await activeTabId();
  await runInPage('window.__lumaLiveMarker = "kept"', tornTab);

  const windowId = await mainWindowId();
  const layout = await app.evaluate(({ BrowserWindow, screen }, id) => {
    const win = BrowserWindow.fromId(id);
    if (!win) throw new Error('Missing main window');
    if (win.isMaximized()) win.unmaximize();
    const area = screen.getPrimaryDisplay().workArea;
    const bounds = {
      x: area.x + 40,
      y: area.y + 40,
      width: Math.min(1000, area.width - 80),
      height: Math.min(700, area.height - 120),
    };
    win.setBounds(bounds);
    return { bounds, area };
  }, windowId);
  await page.waitForTimeout(300);

  // Drop inside the page area: tearing off must also work below the tab bar.
  const dropPoint = { screenX: layout.bounds.x + 620, screenY: layout.bounds.y + 380 };
  expect(dropPoint.screenY).toBeGreaterThan(layout.bounds.y + 40);

  // Pin the dragged element: the source switches to another tab once the drag starts.
  const active = page.locator(`.browser-tab[data-tab-id="${tornTab}"]`);
  const windowsBefore = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((win) => win.id));
  await setTestCursor({ x: dropPoint.screenX, y: dropPoint.screenY });

  // dragstart → drag (leaves the tab bar, so the page starts following) → dragend.
  const dispatchStep = (step: { type: string; clientX: number; clientY: number }) =>
    active.evaluate((element, args) => {
      const data = new DataTransfer();
      data.setData('text/plain', element.getAttribute('data-tab-id') || '');
      data.setData('application/x-luma-item', 'tab');
      element.dispatchEvent(new DragEvent(args.step.type, {
        bubbles: true,
        cancelable: true,
        dataTransfer: data,
        screenX: args.point.screenX,
        screenY: args.point.screenY,
        clientX: args.step.clientX,
        clientY: args.step.clientY,
      }));
    }, { step, point: dropPoint });

  await dispatchStep({ type: 'dragstart', clientX: 200, clientY: 18 });
  await dispatchStep({ type: 'drag', clientX: 520, clientY: 320 });
  // The window must open exactly where the drag preview was.
  const followerBounds = await app.evaluate(({ BrowserWindow }, before) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => !before.includes(candidate.id));
    return win ? win.getBounds() : null;
  }, windowsBefore);
  await dispatchStep({ type: 'dragend', clientX: 200, clientY: 18 });

  // The dragged tab, with its running page, appears in a new window at the drop point.
  await expect.poll(
    () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
    { timeout: 15_000 },
  ).toBe(windowsBefore.length + 1);

  const after = await app.evaluate(({ BrowserWindow }, before) => {
    const wins = BrowserWindow.getAllWindows();
    const created = wins.find((candidate) => !before.includes(candidate.id));
    const source = wins.find((candidate) => before.includes(candidate.id));
    return {
      source: source ? { bounds: source.getBounds(), title: source.getTitle() } : null,
      created: created ? { bounds: created.getBounds(), title: created.getTitle() } : null,
    };
  }, windowsBefore);

  // The original window stays where it was, minus the tab that left.
  expect(after.source?.bounds).toEqual(layout.bounds);
  expect(after.source?.title).toContain('Example Domain');
  await expect(page.locator('.browser-tab')).toHaveCount(tabsBefore);
  await expect(page.locator('.browser-tab.is-active')).toHaveAttribute('data-tab-id', keptTab);
  expect(await runInPage('window.__lumaKept', keptTab)).toBe('kept');

  // The window opens exactly where the drag preview was.
  expect(followerBounds).not.toBeNull();
  expect(after.created?.bounds).toEqual(followerBounds);
  await expect.poll(
    () => app.windows().filter((candidate) => candidate !== page && candidate.url().startsWith('file:')).length,
    { timeout: 20_000 },
  ).toBeGreaterThan(0);
  const createdPage = app.windows().find((candidate) => candidate !== page && candidate.url().startsWith('file:'));
  expect(createdPage).toBeTruthy();
  if (createdPage) {
    await expect(createdPage.locator('.browser-tab')).toHaveCount(1, { timeout: 20_000 });
    await expect(createdPage.locator('.browser-tab.is-active')).toHaveAttribute('data-tab-id', tornTab);
    const marker = await createdPage.evaluate(
      (tab) => window.lumaDesktop?.pageView.command(tab, 'executeJavaScript', ['window.__lumaLiveMarker']),
      tornTab,
    );
    expect(marker).toBe('kept');
  }

  await app.evaluate(({ BrowserWindow }, before) => {
    BrowserWindow.getAllWindows().find((candidate) => !before.includes(candidate.id))?.close();
  }, windowsBefore);
  await setTestCursor(null);
  await app.evaluate(({ BrowserWindow }, bounds) => {
    BrowserWindow.getAllWindows()[0]?.setBounds(bounds);
  }, layout.bounds);
  await page.waitForTimeout(400);
});

test('keeps the maximized window in place when a tab is torn out', async () => {
  await page.getByRole('button', { name: '新建标签页 (Ctrl+T)' }).click();
  const address = page.getByRole('textbox', { name: '地址和搜索栏' });
  await address.fill('example.com/?tearoff-maximized=1');
  await address.press('Enter');
  await expect(page.getByRole('tab', { name: 'Example Domain' }).last()).toBeVisible({ timeout: 20_000 });

  const windowsBefore = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => candidate.getTitle().includes('Example Domain'))
      ?? BrowserWindow.getAllWindows()[0];
    win.maximize();
    return BrowserWindow.getAllWindows().map((candidate) => candidate.id);
  });
  await page.waitForTimeout(400);

  const tabId = await activeTabId();
  // Pin the element: the source switches to another tab once the drag starts.
  const active = page.locator(`.browser-tab[data-tab-id="${tabId}"]`);
  const dropPoint = { screenX: 700, screenY: 420 };
  await setTestCursor({ x: dropPoint.screenX, y: dropPoint.screenY });

  for (const step of [
    { type: 'dragstart', clientX: 220, clientY: 18 },
    { type: 'drag', clientX: 520, clientY: 320 },
    { type: 'dragend', clientX: 220, clientY: 18 },
  ] as const) {
    await active.evaluate((element, args) => {
      const data = new DataTransfer();
      data.setData('text/plain', element.getAttribute('data-tab-id') || '');
      data.setData('application/x-luma-item', 'tab');
      element.dispatchEvent(new DragEvent(args.step.type, {
        bubbles: true,
        cancelable: true,
        dataTransfer: data,
        screenX: args.point.screenX,
        screenY: args.point.screenY,
        clientX: args.step.clientX,
        clientY: args.step.clientY,
      }));
    }, { step, point: dropPoint });
  }

  await expect.poll(
    () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
    { timeout: 15_000 },
  ).toBe(windowsBefore.length + 1);

  const state = await app.evaluate(({ BrowserWindow }, before) => {
    const wins = BrowserWindow.getAllWindows();
    const created = wins.find((candidate) => !before.includes(candidate.id));
    const source = wins.find((candidate) => before.includes(candidate.id));
    return {
      created: created ? { maximized: created.isMaximized(), bounds: created.getBounds() } : null,
      source: source ? { maximized: source.isMaximized(), bounds: source.getBounds() } : null,
    };
  }, windowsBefore);

  // The original window stays maximized in place; the torn page opens as a
  // normal window at the drop point, like other browsers.
  expect(state.source?.maximized).toBe(true);
  expect(state.created?.maximized).toBe(false);
  expect(state.created?.bounds.x).toBe(dropPoint.screenX - 220);
  expect(state.created?.bounds.y).toBe(dropPoint.screenY - 18);

  await setTestCursor(null);
  await app.evaluate(({ BrowserWindow }, before) => {
    BrowserWindow.getAllWindows().find((candidate) => !before.includes(candidate.id))?.close();
    const source = BrowserWindow.getAllWindows().find((candidate) => before.includes(candidate.id));
    if (source) {
      if (source.isMaximized()) source.unmaximize();
      source.setBounds({ x: 80, y: 80, width: 1100, height: 760 });
    }
  }, windowsBefore);
});

test('reads chapters with font controls and navigates to the next chapter', async () => {
  const chapterOne = `<!doctype html><html><head><meta charset="utf-8"><title>第一章</title></head><body>
    <h1>第一章 风起</h1>
    <article><p>${'夜色沿着山脊缓慢落下，远处的灯火像细小的星。'.repeat(45)}</p>
    <p>${'他合上书页，听见风从窗缝里经过。'.repeat(35)}</p></article>
    <div class="bottem"><a href="/reader/2">下一章 →</a></div>
  </body></html>`;
  const chapterTwo = `<!doctype html><html><head><meta charset="utf-8"><title>第二章</title></head><body>
    <h1>第二章 远行</h1>
    <article><p>${'清晨的雾还没有散去，路上只有马蹄和石子的声音。'.repeat(45)}</p></article>
    <div class="bottem"><a href="/reader/1">上一章</a><a href="/reader/3">下一章 →</a></div>
  </body></html>`;
  const server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(request.url === '/reader/2' ? chapterTwo : chapterOne);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const addressInfo = server.address();
    if (!addressInfo || typeof addressInfo === 'string') throw new Error('Missing test server port');
    await page.getByRole('button', { name: '新建标签页 (Ctrl+T)' }).click();
    const address = page.getByRole('textbox', { name: '地址和搜索栏' });
    await address.fill(`http://127.0.0.1:${addressInfo.port}/reader/1`);
    await address.press('Enter');
    await expect(page.getByRole('tab', { name: '第一章' })).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: /^阅读模式/ }).click();
    const reader = page.getByRole('document', { name: '阅读模式' });
    await expect(reader.getByRole('heading', { name: '第一章 风起' })).toBeVisible();

    await reader.getByRole('button', { name: '阅读字体设置' }).click();
    const settings = reader.getByRole('dialog', { name: '阅读字体设置' });
    await expect(settings).toBeVisible();
    const fontSlider = settings.getByRole('slider', { name: '阅读字号' });
    await fontSlider.evaluate((element) => {
      const input = element as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, '24');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settings.getByLabel('字体').selectOption('sans');
    await expect.poll(async () =>
      reader.locator('.reader-article').evaluate((element) => getComputedStyle(element).fontSize),
    ).toBe('24px');
    await page.screenshot({ path: 'test-results/ui-reader-settings.png' });
    await reader.getByRole('button', { name: '关闭阅读设置' }).click();

    await reader.getByRole('button', { name: '下一章' }).click();
    await expect(reader.getByRole('heading', { name: '第二章 远行' })).toBeVisible({ timeout: 15_000 });
    await expect(address).toHaveValue(new RegExp(`127\\.0\\.0\\.1:${addressInfo.port}/reader/2`));
    await page.screenshot({ path: 'test-results/ui-reader-chapter.png' });
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test('captures the visible page into the clipboard', async () => {
  await page.getByRole('button', { name: '新建标签页 (Ctrl+T)' }).click();
  const address = page.getByRole('textbox', { name: '地址和搜索栏' });
  await address.fill('example.com/?capture=1');
  await address.press('Enter');
  await expect(page.getByRole('tab', { name: 'Example Domain' }).last()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: /^网页截图/ })).toBeEnabled();

  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: /^网页截图/ }).click();
  const popover = page.getByRole('dialog', { name: '网页截图' });
  await expect(popover).toBeVisible();
  await page.screenshot({ path: 'test-results/ui-screenshot-popover.png' });
  await popover.getByRole('button', { name: '复制到剪贴板' }).click();
  await expect(page.locator('.toast').filter({ hasText: '截图已复制到剪贴板' })).toBeVisible();

  const hasImage = await app.evaluate(async ({ clipboard }) => clipboard.has('image/png'));
  expect(hasImage).toBe(true);

  const info = await pageInfo();
  const fullPage = await page.evaluate((id) => window.lumaDesktop!.capturePage(id, { mode: 'copy', fullPage: true }), info.webContentsId);
  expect(fullPage.ok).toBe(true);
});

test('merges a torn-off tab back into the window under the drop point', async () => {
  const mainTabCountBefore = await page.locator('.browser-tab').count();
  const windowsBefore = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((win) => win.id),
  );
  if (windowsBefore.length === 0) throw new Error('Missing main window');

  // A second window holding a single tab, positioned away from the main tab bar.
  const createdWindowId = await page.evaluate(() => {
    const tab = {
      id: 'merge-test-tab',
      title: '新标签页',
      entries: [{ url: 'luma://newtab', title: '新标签页', visitedAt: Date.now() }],
      historyIndex: 0,
    };
    return window.lumaDesktop?.splitTabs([tab], tab.id, { x: 0, y: 0, width: 420, height: 320 });
  });
  expect(typeof createdWindowId).toBe('number');

  await expect.poll(
    () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
    { timeout: 15_000 },
  ).toBe(windowsBefore.length + 1);

  const layout = await app.evaluate(({ BrowserWindow, screen }, args) => {
    const main = BrowserWindow.fromId(args.mainId);
    const created = BrowserWindow.fromId(args.createdId);
    if (!main || !created) return null;
    const area = screen.getPrimaryDisplay().workArea;
    main.setBounds({
      x: area.x + 40,
      y: area.y + 40,
      width: Math.min(900, area.width - 80),
      height: Math.min(700, area.height - 120),
    });
    // Keep the torn window away from the drop point, but wide enough that the
    // desktop tab strip is used (narrow windows switch to the mobile layout).
    created.setBounds({
      x: area.x + area.width - 760,
      y: area.y + area.height - 460,
      width: 740,
      height: 420,
    });
    return { main: main.getBounds(), created: created.getBounds() };
  }, { mainId: windowsBefore[0], createdId: createdWindowId as number });
  if (!layout) throw new Error('Missing window layout');

  // Merging is intentionally limited to the target window's tab bar.
  const dropPoint = {
    screenX: layout.main.x + 220,
    screenY: layout.main.y + 18,
  };
  expect(dropPoint.screenX < layout.created.x || dropPoint.screenY > layout.created.y + layout.created.height).toBe(true);

  await expect.poll(
    () => app.windows().filter((candidate) => candidate !== page && candidate.url().startsWith('file:')).length,
    { timeout: 15_000 },
  ).toBeGreaterThan(0);
  const tornPage = app.windows().find((candidate) => candidate !== page && candidate.url().startsWith('file:'));
  if (!tornPage) throw new Error('Missing torn window page');
  await expect(tornPage.locator('.browser-tab').first()).toBeVisible({ timeout: 15_000 });

  // The pointer is over the target tab bar while the drag starts: entering it is
  // enough to merge, no button release needed.
  await setTestCursor({ x: dropPoint.screenX, y: dropPoint.screenY });
  await tornPage.locator('.browser-tab.is-active').evaluate((element, point) => {
    const data = new DataTransfer();
    data.setData('text/plain', element.getAttribute('data-tab-id') || '');
    data.setData('application/x-luma-item', 'tab');
    element.dispatchEvent(new DragEvent('dragstart', {
      bubbles: true,
      cancelable: true,
      dataTransfer: data,
      screenX: point.screenX,
      screenY: point.screenY,
      clientX: 80,
      clientY: 18,
    }));
  }, dropPoint);

  await expect.poll(
    () => page.locator('.browser-tab').count(),
    { timeout: 15_000 },
  ).toBe(mainTabCountBefore + 1);
  await expect(page.locator('.browser-tab.is-active')).toContainText('新标签页');
  // The source window had nothing left, so it closed.
  await expect.poll(
    () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
    { timeout: 15_000 },
  ).toBe(windowsBefore.length);

  await setTestCursor(null);
  await app.evaluate(({ BrowserWindow }, bounds) => {
    BrowserWindow.getAllWindows()[0]?.setBounds(bounds);
  }, layout.main);
  await page.waitForTimeout(300);
});

test('keeps bookmark icons in the local cache instead of refetching them', async () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const server = createServer((request, response) => {
    if (request.url === '/favicon.ico') {
      response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      response.end(png);
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html><head><meta charset="utf-8"><title>图标缓存页面</title><link rel="icon" href="/favicon.ico"></head><body><h1>图标缓存页面</h1></body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const addressInfo = server.address();
    if (!addressInfo || typeof addressInfo === 'string') throw new Error('Missing test server port');
    const origin = `http://127.0.0.1:${addressInfo.port}`;

    await page.getByRole('button', { name: '新建标签页 (Ctrl+T)' }).click();
    const address = page.getByRole('textbox', { name: '地址和搜索栏' });
    await address.fill(`${origin}/article`);
    await address.press('Enter');
    await expect(page.getByRole('tab', { name: '图标缓存页面' })).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: '为此页添加书签 (Ctrl+D)' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '保存书签' }).click();

    await expect.poll(
      () => page.evaluate((iconOrigin) => {
        const cache = JSON.parse(localStorage.getItem('luma.favicon-cache.v1') || '{}');
        return cache[iconOrigin]?.icon?.startsWith('data:image/') ?? false;
      }, origin),
      { timeout: 15_000 },
    ).toBe(true);

    await expect.poll(
      () => page.evaluate((articleUrl) => {
        const bookmarks = JSON.parse(localStorage.getItem('luma.bookmarks.v1') || '[]');
        return bookmarks.find((bookmark: { url: string }) => bookmark.url === articleUrl)?.favicon ?? '';
      }, `${origin}/article`),
      { timeout: 15_000 },
    ).toMatch(/^data:image\//);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test('captures a dragged-out region of the page', async () => {
  await page.getByRole('button', { name: '新建标签页 (Ctrl+T)' }).click();
  const address = page.getByRole('textbox', { name: '地址和搜索栏' });
  await address.fill('example.com/?region-capture=1');
  await address.press('Enter');
  await expect(page.getByRole('tab', { name: 'Example Domain' }).last()).toBeVisible({ timeout: 20_000 });

  const cropped = await page.evaluate(async (webContentsId) => {
    const host = document.querySelector('.page-host-layer');
    const rect = host?.getBoundingClientRect();
    if (!rect) return null;
    const result = await window.lumaDesktop!.capturePage(webContentsId, {
      mode: 'copy',
      region: { x: 20, y: 20, width: 200, height: 120 },
      viewport: { width: rect.width, height: rect.height },
    });
    return { result, viewport: { width: rect.width, height: rect.height } };
  }, (await pageInfo()).webContentsId);
  expect(cropped?.result.ok, JSON.stringify(cropped?.result)).toBe(true);
  expect(cropped?.result.size?.width ?? 0).toBeGreaterThan(150);
  expect(cropped?.result.size?.height ?? 0).toBeGreaterThan(90);
  const width = cropped!.result.size!.width;
  const height = cropped!.result.size!.height;
  expect(width / height).toBeCloseTo(200 / 120, 1);

  await page.getByRole('button', { name: /^网页截图/ }).click();
  await page.getByRole('dialog', { name: '网页截图' }).getByRole('button', { name: '选择区域' }).click();
  const overlay = page.getByRole('dialog', { name: '选择截图区域' });
  await expect(overlay).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(overlay).toHaveCount(0);
  await page.getByRole('button', { name: /^网页截图/ }).click();
  await page.getByRole('dialog', { name: '网页截图' }).getByRole('button', { name: '选择区域' }).click();
  await expect(overlay).toBeVisible();
  const bounds = await overlay.boundingBox();
  if (!bounds) throw new Error('Missing selection overlay');
  await page.mouse.move(bounds.x + 36, bounds.y + 32);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 236, bounds.y + 172, { steps: 6 });
  await page.mouse.up();
  const actions = overlay.locator('.region-capture__actions');
  await expect(actions).toBeVisible();
  await expect(overlay.locator('.region-capture__size')).toHaveText(/200 × 140/);
  await page.screenshot({ path: 'test-results/ui-region-capture.png' });
  await actions.getByRole('button', { name: '复制' }).click();
  await expect(page.locator('.toast').filter({ hasText: '截图已复制到剪贴板' })).toBeVisible();
  await expect(overlay).toHaveCount(0);

  const clipboardBytes = await app.evaluate(async ({ clipboard }) => {
    const items = await clipboard.read();
    const image = await items[0]?.getType('image/png');
    return image?.size ?? 0;
  });
  expect(clipboardBytes).toBeGreaterThan(0);
});

test('cycles tabs from the keyboard and opens one from the empty strip', async () => {
  const countBefore = await page.locator('.browser-tab').count();
  await page.getByRole('button', { name: '新建标签页 (Ctrl+T)' }).click();
  await expect(page.locator('.browser-tab')).toHaveCount(countBefore + 1);

  // Key events only reach the browser chrome when no page view holds focus.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const before = await activeTabId();
  await page.keyboard.press('Control+Tab');
  await expect.poll(() => activeTabId()).not.toBe(before);

  await page.keyboard.press('Control+Shift+Tab');
  await expect.poll(() => activeTabId()).toBe(before);

  // Double-clicking the empty part of the strip is the Chrome shortcut for a
  // new tab. The event is aimed at the strip itself, which is the empty area
  // the handler checks for; earlier tests leave an unknown number of tabs open.
  await page.evaluate(() => {
    document.querySelector('.tab-list')?.dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true, cancelable: true }),
    );
  });
  await expect(page.locator('.browser-tab')).toHaveCount(countBefore + 2);
});

test('installs an unpacked extension and runs its content script', async () => {
  const extensionDir = mkdtempSync(path.join(os.tmpdir(), 'luma-e2e-ext-'));
  writeFileSync(path.join(extensionDir, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'E2E Probe',
    version: '1.0.0',
    description: 'content script probe',
    permissions: ['storage'],
    host_permissions: ['<all_urls>'],
    content_scripts: [{ matches: ['<all_urls>'], js: ['content.js'], run_at: 'document_end' }],
  }, null, 2));
  writeFileSync(path.join(extensionDir, 'content.js'), `
    const marker = document.createElement('div');
    marker.id = 'luma-e2e-ext';
    marker.textContent = 'probe-ok';
    marker.style.cssText = 'position:fixed;left:-9999px';
    document.documentElement.appendChild(marker);
  `);

  const installed = await page.evaluate(
    (source) => window.lumaDesktop.installExtension(source),
    extensionDir,
  );
  expect(installed.ok).toBe(true);
  const probeEntry = installed.list.find((item: { name: string }) => item.name === 'E2E Probe');
  expect(probeEntry).toBeTruthy();
  expect(probeEntry.enabled).toBe(true);
  expect(probeEntry.loaded).toBe(true);

  const address = page.getByRole('textbox', { name: '地址和搜索栏' });
  await address.fill('example.com/?ext=1');
  await address.press('Enter');
  await expect.poll(async () => {
    const info = await pageInfo();
    return info.url;
  }, { timeout: 30_000 }).toContain('ext=1');

  const injected = await app.evaluate(async ({ webContents }) => {
    const target = webContents.getAllWebContents().find((contents) => contents.getURL().includes('ext=1'));
    if (!target) return null;
    return target.executeJavaScript("document.getElementById('luma-e2e-ext')?.textContent ?? null");
  });
  expect(injected).toBe('probe-ok');

  // Removing the extension unloads it and deletes the managed copy.
  const removed = await page.evaluate((id) => window.lumaDesktop.removeExtension(id), probeEntry.id);
  expect(removed.ok).toBe(true);
  expect(removed.list.some((item: { name: string }) => item.name === 'E2E Probe')).toBe(false);
  rmSync(extensionDir, { recursive: true, force: true });
});

test('opens an extension popup from the toolbar and closes it again', async () => {
  const extensionDir = mkdtempSync(path.join(os.tmpdir(), 'luma-e2e-popup-'));
  writeFileSync(path.join(extensionDir, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'Popup Probe',
    version: '1.0.0',
    action: { default_title: 'Popup Probe', default_popup: 'popup.html' },
  }, null, 2));
  writeFileSync(path.join(extensionDir, 'popup.html'),
    '<!doctype html><html><body style="margin:0;padding:14px;font:14px sans-serif;background:#fff">'
    + '<div id="probe">popup-body</div></body></html>');

  const installed = await page.evaluate((dir) => window.lumaDesktop.installExtension(dir), extensionDir);
  expect(installed.ok).toBe(true);

  const toolbarIcon = page.getByRole('button', { name: '扩展 Popup Probe' });
  await expect(toolbarIcon).toBeVisible({ timeout: 10_000 });
  // Toolbar icons live in the address bar row, not in the tab strip.
  expect(await page.locator('.navigation-bar .extension-action').count()).toBeGreaterThan(0);
  expect(await page.locator('.browser-tabbar .extension-actions').count()).toBe(0);

  const popupPromise = app.waitForEvent('window', { timeout: 15_000 });
  await toolbarIcon.click();
  const popup = await popupPromise;
  await popup.waitForLoadState('domcontentloaded');
  expect(popup.url()).toContain('chrome-extension://');
  expect(popup.url()).toContain('popup.html');
  await expect(popup.locator('#probe')).toHaveText('popup-body');

  // The host follows Chrome: clicking the icon again toggles the popup shut.
  await toolbarIcon.click();
  await expect.poll(
    () => app.windows().filter((window) => window.url().startsWith('chrome-extension://')).length,
    { timeout: 5_000 },
  ).toBe(0);

  const removed = await page.evaluate((id) => window.lumaDesktop.removeExtension(id), installed.list[0].id);
  expect(removed.ok).toBe(true);
  rmSync(extensionDir, { recursive: true, force: true });
});

test('pins a tab to the left edge and unpins it from the context menu', async () => {
  await page.getByRole('button', { name: '新建标签页 (Ctrl+T)' }).click();
  const tabs = page.locator('.browser-tab');
  const total = await tabs.count();
  const last = tabs.nth(total - 1);
  await last.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: '标签页选项' });
  await menu.getByRole('menuitem', { name: /固定标签页/ }).click();

  const pinned = page.locator('.browser-tab.is-pinned');
  await expect(pinned).toHaveCount(1);
  // Pinned tabs always move to the front and shrink to an icon.
  await expect(page.locator('.browser-tab').first()).toHaveClass(/is-pinned/);
  const width = await pinned.first().evaluate((element) => element.getBoundingClientRect().width);
  expect(width).toBeLessThanOrEqual(50);
  await expect(pinned.first().locator('.browser-tab__close')).toHaveCount(0);

  await pinned.first().click({ button: 'right' });
  await page.getByRole('menu', { name: '标签页选项' }).getByRole('menuitem', { name: /取消固定/ }).click();
  await expect(page.locator('.browser-tab.is-pinned')).toHaveCount(0);
});

test('moves between tabs with the arrow keys', async () => {
  const newTab = page.getByRole('button', { name: '新建标签页 (Ctrl+T)' });
  await newTab.click();
  await newTab.click();
  const tabs = page.locator('.browser-tab');
  const total = await tabs.count();
  expect(total).toBeGreaterThanOrEqual(3);

  await tabs.nth(0).locator('.browser-tab__main').focus();
  // Focusing a tab does not select it, so the baseline is the focused tab and
  // not the active one.
  const focusedId = await page.locator('.browser-tab__main:focus').evaluate(
    (element) => element.closest('.browser-tab')?.getAttribute('data-tab-id') ?? '',
  );
  expect(focusedId).not.toBe('');
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => activeTabId(), { timeout: 5_000 }).not.toBe(focusedId);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => activeTabId(), { timeout: 5_000 }).toBe(focusedId);
  // Only the active tab is in the tab order.
  const focusable = await page.locator('.browser-tab__main[tabindex="0"]').count();
  expect(focusable).toBe(1);
});


test('offers picture-in-picture for the current page', async () => {
  const address = page.getByRole('textbox', { name: '地址和搜索栏' });
  await address.fill('example.com/?pip=1');
  await address.press('Enter');
  await expect.poll(async () => (await pageInfo()).url, { timeout: 30_000 }).toContain('pip=1');

  await page.getByRole('button', { name: '自定义及控制 Luma' }).click();
  await page.getByRole('button', { name: '视频小窗' }).click();
  // No <video> on the page: the app must explain instead of failing silently.
  await expect(page.locator('.toast').filter({ hasText: /没有正在播放的视频/ })).toBeVisible();
});
