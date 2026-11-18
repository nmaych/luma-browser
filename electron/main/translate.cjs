const { net } = require('electron');

/**
 * Page translation service.
 *
 * Two providers are chained: the Google endpoint answers whole paragraphs in a
 * single request, MyMemory is the fallback for networks where Google is
 * unreachable. Chunking, language detection and HTML entity decoding live here
 * so the main process only has to wire an IPC channel.
 */

const TRANSLATION_TARGETS = new Set(['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'ru']);

async function fetchJson(url, timeoutMs = 12_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await net.fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Luma/1.0',
        Accept: 'application/json',
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

let googleTranslationBlockedUntil = 0;

async function translateChunk(text, target) {
  if (Date.now() < googleTranslationBlockedUntil) throw new Error('google unavailable');
  const endpoint = 'https://translate.googleapis.com/translate_a/single'
    + `?client=gtx&sl=auto&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(text)}`;
  const data = await fetchJson(endpoint, 5_000).catch((error) => {
    // Remember the outage briefly so later chunks go straight to the fallback.
    googleTranslationBlockedUntil = Date.now() + 10 * 60_000;
    throw error;
  });
  const segments = Array.isArray(data?.[0]) ? data[0] : [];
  const translated = segments
    .map((segment) => (Array.isArray(segment) && typeof segment[0] === 'string' ? segment[0] : ''))
    .join('');
  if (!translated.trim()) throw new Error('empty translation');
  return translated;
}

/** Rough script-based source detection for the MyMemory fallback. */
function detectSourceLanguage(text) {
  if (/[\u3040-\u30ff]/.test(text)) return 'ja';
  if (/[\uac00-\ud7af]/.test(text)) return 'ko';
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh-CN';
  if (/[\u0400-\u04ff]/.test(text)) return 'ru';
  if (/[\u0600-\u06ff]/.test(text)) return 'ar';
  if (/[\u0e00-\u0e7f]/.test(text)) return 'th';
  return 'en';
}

function splitForTranslation(text, limit = 450) {
  if (text.length <= limit) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const cut = Math.max(
      window.lastIndexOf('. '),
      window.lastIndexOf('! '),
      window.lastIndexOf('? '),
      window.lastIndexOf('\n'),
      window.lastIndexOf(' '),
    );
    const index = cut > limit * 0.4 ? cut + 1 : limit;
    parts.push(rest.slice(0, index));
    rest = rest.slice(index);
  }
  if (rest) parts.push(rest);
  return parts;
}

/**
 * MyMemory is used when the Google endpoint is unreachable (for example on
 * mainland networks). It has no auto-detect, so the source script is guessed.
 */
function decodeHtmlEntities(text) {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

async function translateWithMyMemory(text, target) {
  const source = detectSourceLanguage(text);
  if (source === target) return text;
  const pieces = splitForTranslation(text);
  const results = [];
  for (const piece of pieces) {
    const endpoint = 'https://api.mymemory.translated.net/get'
      + `?q=${encodeURIComponent(piece)}&langpair=${encodeURIComponent(source)}|${encodeURIComponent(target)}`;
    const data = await fetchJson(endpoint, 15_000);
    const translated = data?.responseData?.translatedText;
    if (typeof translated !== 'string' || !translated.trim()) throw new Error('empty translation');
    if (/INVALID SOURCE LANGUAGE|QUERY LENGTH LIMIT|MYMEMORY WARNING/i.test(translated)) {
      throw new Error('translation rejected');
    }
    results.push(decodeHtmlEntities(translated));
  }
  return results.join(' ');
}

async function translateTexts(texts, target) {
  const cleanTarget = TRANSLATION_TARGETS.has(target) ? target : 'zh-CN';
  const cleanTexts = texts
    .filter((text) => typeof text === 'string' && text.trim())
    .map((text) => text.slice(0, 4000))
    .slice(0, 80);
  if (cleanTexts.length === 0) return { ok: true, translations: [] };

  const chunks = [];
  let current = [];
  let currentLength = 0;
  for (const text of cleanTexts) {
    if (current.length > 0 && (current.length >= 6 || currentLength + text.length > 1400)) {
      chunks.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(text);
    currentLength += text.length + 1;
  }
  if (current.length > 0) chunks.push(current);

  const translations = [];
  let lastError = '';
  for (const chunk of chunks) {
    let translatedLines = null;
    try {
      const result = await translateChunk(chunk.join('\n'), cleanTarget);
      const lines = result.split('\n');
      if (lines.length === chunk.length) translatedLines = lines;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (translatedLines) {
      translations.push(...translatedLines);
      continue;
    }
    // Primary endpoint unavailable: fall back in parallel so long pages finish quickly.
    const fallback = await Promise.all(chunk.map(async (text) => {
      try {
        return await translateWithMyMemory(text, cleanTarget);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        return text;
      }
    }));
    translations.push(...fallback);
  }
  const source = detectSourceLanguage(cleanTexts.join(' '));
  const succeeded = translations.some((text, index) => text !== cleanTexts[index]);
  if (!succeeded) {
    return {
      ok: false,
      error: source === cleanTarget ? 'same-language' : (lastError || 'translation unavailable'),
      translations: [],
    };
  }
  return { ok: true, translations };
}

module.exports = { translateTexts, splitForTranslation, detectSourceLanguage };
