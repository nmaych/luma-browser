import { afterEach, describe, expect, it } from 'vitest';
import {
  READER_EXTRACT_SCRIPT,
  TRANSLATION_EXTRACT_SCRIPT,
  TRANSLATION_RESTORE_SCRIPT,
  buildTranslationApplyScript,
  sanitizeReaderHtml,
  type ReaderExtractionResult,
} from '../src/utils/reader';

function runInPage<T>(script: string): T {
  return window.eval(script) as T;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('sanitizeReaderHtml', () => {
  it('removes scripts, event handlers and unsafe URLs', () => {
    const html = sanitizeReaderHtml(`
      <p onclick="steal()">正文<script>alert(1)</script></p>
      <a href="javascript:alert(1)">坏链接</a>
      <a href="https://example.com/docs">好链接</a>
      <img src="x" onerror="alert(1)" alt="图">
      <iframe src="https://ads.example.com"></iframe>
    `);

    expect(html).toContain('正文');
    expect(html).not.toContain('script');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('iframe');
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('rel="noreferrer"');
  });

  it('keeps relative links and image sources', () => {
    const html = sanitizeReaderHtml('<p><a href="/next">下一页</a><img src="/cover.png" alt="封面"></p>');
    expect(html).toContain('href="/next"');
    expect(html).toContain('src="/cover.png"');
  });
});

describe('reader article extraction', () => {
  it('finds the article and chapter navigation outside the article container', () => {
    document.body.innerHTML = `
      <header><h1>第一章 风起</h1></header>
      <main>
        <article>
          <p>${'这是正文内容。'.repeat(30)}</p>
          <p>${'故事继续向前发展。'.repeat(20)}</p>
        </article>
      </main>
      <div class="chapter-nav">
        <a href="/209/209891/68604245.html">上一章</a>
        <a id="next" href="/209/209891/68604247.html">下一章 →</a>
      </div>
    `;
    const result = runInPage<ReaderExtractionResult>(READER_EXTRACT_SCRIPT);
    expect(result.ok).toBe(true);
    expect(result.title).toContain('第一章');
    expect(result.content).toContain('这是正文内容');
    expect(result.nextUrl).toContain('/209/209891/68604247.html');
    expect(result.prevUrl).toContain('/209/209891/68604245.html');
  });

  it('prefers a dedicated chapter body over page metadata wrappers', () => {
    document.body.innerHTML = `
      <div class="yuedu_page">
        <div class="bookinfo">作品：测试小说 作者：测试作者 字数：999999</div>
        <div id="center_tip">最新网址：example.test</div>
        <div id="content">
          <p>${'正文第一段，故事从这里开始。'.repeat(28)}</p>
          <p>${'正文第二段，人物继续前行。'.repeat(28)}</p>
        </div>
      </div>
      <p class="button2"><a href="/next.html">下一章</a></p>
    `;
    const result = runInPage<ReaderExtractionResult>(READER_EXTRACT_SCRIPT);
    expect(result.ok).toBe(true);
    expect(result.content).toContain('正文第一段');
    expect(result.content).not.toContain('作品：测试小说');
    expect(result.content).not.toContain('最新网址');
    expect(result.nextUrl).toContain('/next.html');
  });
});

describe('page translation', () => {
  it('translates text nodes without destroying links, buttons or markup', () => {
    document.body.innerHTML = `
      <article>
        <p>Hello <strong>beautiful</strong> world. <a href="/docs">Read the docs</a></p>
        <button type="button">Buy now</button>
      </article>
    `;
    const extracted = runInPage<{ ok: boolean; texts: string[] }>(TRANSLATION_EXTRACT_SCRIPT);
    expect(extracted.ok).toBe(true);
    expect(extracted.texts).toContain('Hello');
    expect(extracted.texts).toContain('world.');
    expect(extracted.texts).toContain('Read the docs');
    expect(extracted.texts).toContain('Buy now');

    runInPage(buildTranslationApplyScript(extracted.texts.map((text) => `译:${text}`)));

    const link = document.querySelector('a')!;
    const button = document.querySelector('button')!;
    expect(link.isConnected).toBe(true);
    expect(link.getAttribute('href')).toBe('/docs');
    expect(link.textContent).toBe('译:Read the docs');
    expect(button.isConnected).toBe(true);
    expect(button.textContent).toBe('译:Buy now');
    expect(document.querySelector('strong')?.textContent).toBe('译:beautiful');
    expect(document.querySelector('p')?.textContent).toContain('译:Hello');
    expect(document.querySelector('p')?.textContent).toContain('译:world.');

    runInPage(TRANSLATION_RESTORE_SCRIPT);
    expect(document.querySelector('p')?.textContent).toContain('Hello');
    expect(document.querySelector('strong')?.textContent).toBe('beautiful');
    expect(link.getAttribute('href')).toBe('/docs');
  });
});
