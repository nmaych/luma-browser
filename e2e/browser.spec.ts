import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '新标签页' })).toBeVisible();
});

test('tab navigation keeps independent back and forward history', async ({ page }) => {
  await page.getByRole('button', { name: '新建标签页 (Ctrl+T)' }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await page.getByRole('textbox', { name: '地址和搜索栏' }).fill('luma://bookmarks');
  await page.getByRole('textbox', { name: '地址和搜索栏' }).press('Enter');
  await expect(page.getByRole('heading', { name: '书签', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: '后退 (Alt+←)' }).click();
  await expect(page.getByRole('heading', { name: '新标签页' })).toBeVisible();
  await page.getByRole('button', { name: '前进 (Alt+→)' }).click();
  await expect(page.getByRole('heading', { name: '书签', level: 1 })).toBeVisible();
});

test('bookmark dialog validates, saves and displays a bookmark', async ({ page }) => {
  await page.getByRole('textbox', { name: '地址和搜索栏' }).fill('luma://bookmarks');
  await page.getByRole('textbox', { name: '地址和搜索栏' }).press('Enter');
  const main = page.getByRole('main', { name: '网页内容区域' });
  await main.getByRole('button', { name: '添加书签' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.locator('#add-bookmark-form input').nth(0).fill('Luma 项目');
  await page.locator('#add-bookmark-form input').nth(1).fill('example.com');
  await page.getByRole('button', { name: '保存书签' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const tree = main.getByRole('tree', { name: '书签树' });
  const savedBookmark = tree.getByRole('treeitem', { name: /Luma 项目/ });
  await expect(savedBookmark).toBeVisible();
  await savedBookmark.click({ button: 'right' });
  const contextMenu = page.getByRole('menu', { name: '书签选项' });
  await expect(contextMenu).toBeVisible();
  await expect(contextMenu.getByRole('menuitem', { name: '在新标签页中打开' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(contextMenu).toHaveCount(0);
});

test('offline navigation produces a recoverable error state', async ({ page, context }) => {
  await context.setOffline(true);
  await page.getByRole('textbox', { name: '地址和搜索栏' }).fill('example.com');
  await page.getByRole('textbox', { name: '地址和搜索栏' }).press('Enter');
  await expect(page.getByRole('heading', { name: '当前似乎已离线' })).toBeVisible();
  await expect(page.getByText('ERR_INTERNET_DISCONNECTED')).toBeVisible();
  await context.setOffline(false);
  await page.getByRole('button', { name: '返回上一页' }).click();
  await expect(page.getByRole('heading', { name: '新标签页' })).toBeVisible();
});

test('desktop, tablet and mobile layouts do not overflow', async ({ page }) => {
  const sizes = [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'tablet', width: 820, height: 1180 },
    { name: 'mobile', width: 390, height: 844 },
  ];
  for (const size of sizes) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '新标签页' })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
    await page.screenshot({ path: `test-results/luma-${size.name}.png`, fullPage: true });
  }
  await expect(page.getByRole('navigation', { name: '移动端浏览器导航' })).toBeVisible();
  await page.getByRole('button', { name: '管理 1 个标签页' }).click();
  await expect(page.getByRole('dialog', { name: '标签页' })).toBeVisible();
  await page.getByRole('button', { name: '新建标签页', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('theme and reduced motion preferences are applied', async ({ page }) => {
  await page.getByRole('textbox', { name: '地址和搜索栏' }).fill('luma://settings');
  await page.getByRole('textbox', { name: '地址和搜索栏' }).press('Enter');
  await page.getByRole('button', { name: '深色', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByLabel('减少动态效果').check();
  await expect(page.locator('html')).toHaveAttribute('data-reduce-motion', 'true');
});
