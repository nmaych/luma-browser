import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import pngToIco from 'png-to-ico';

const root = join(import.meta.dirname, '..');
const svg = await readFile(join(root, 'public', 'favicon.svg'), 'utf8');
const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
    : {},
);
const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
await page.setContent(
  `<style>html,body{margin:0;background:transparent;overflow:hidden}svg{display:block;width:100vw;height:100vh}</style>${svg}`,
);
const pngPath = join(root, 'build', 'icon.png');
await page.screenshot({ path: pngPath, omitBackground: true });
await browser.close();

const ico = await pngToIco(pngPath);
await writeFile(join(root, 'build', 'icon.ico'), ico);
console.log('Generated build/icon.png and build/icon.ico');
