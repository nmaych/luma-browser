const { net } = require('electron');

/**
 * Page translation service.
 *
 * Providers are tried in order and the first one that answers wins:
 *
 *  - Microsoft Edge's translator endpoint needs no API key (it swaps a short
 *    lived token for it), accepts a JSON array of segments and returns them in
 *    the same order, which keeps long pages aligned.
 *  - Google's public endpoint is the historical default and is still the
 *    fastest option where it is reachable.
 *  - MyMemory is the last resort; it has no batch mode and a small quota.
 *
 * Chunking, language detection and HTML entity decoding live here so the main
 * process only has to wire an IPC channel.
 */

const TRANSLATION_TARGETS = new Set(['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'ru']);
const PROVIDERS = new Set(['auto', 'deepl', 'google', 'mymemory']);

const MICROSOFT_TARGETS = {
  'zh-CN': 'zh-Hans',
  'zh-TW': 'zh-Hant',
};

function fetchText(url, { timeoutMs = 12_000, method = 'GET', headers = {}, body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return net.fetch(url, {
    method,
    body,
    signal: controller.signal,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Luma/1.0',
      ...headers,
    },
  }).finally(() => clearTimeout(timer));
}

async function fetchJson(url, options) {
  const response = await fetchText(url, options);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json();
}

// -------------------------------------------------------------------- DeepL

/** DeepL uses its own language codes and splits free/paid by the key suffix. */
const DEEPL_TARGETS = {
  'zh-CN': 'ZH',
  'zh-TW': 'ZH',
  en: 'EN-US',
  ja: 'JA',
  ko: 'KO',
  fr: 'FR',
  de: 'DE',
  es: 'ES',
  ru: 'RU',
};

async function translateWithDeepl(texts, target, apiKey) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key) throw new Error('deepl key missing');
  const host = key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
  const results = [];
  for (let index = 0; index < texts.length; index += 25) {
    const batch = texts.slice(index, index + 25);
    const form = new URLSearchParams();
    for (const text of batch) form.append('text', text);
    form.append('target_lang', DEEPL_TARGETS[target] ?? 'ZH');
    const response = await fetchText(`${host}/v2/translate`, {
      method: 'POST',
      timeoutMs: 15_000,
      headers: {
        Authorization: `DeepL-Auth-Key ${key}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const items = payload?.translations;
    if (!Array.isArray(items) || items.length !== batch.length) throw new Error('deepl shape');
    for (const item of items) {
      if (typeof item?.text !== 'string' || !item.text.trim()) throw new Error('deepl empty');
      results.push(item.text);
    }
  }
  return results;
}

// ------------------------------------------------------------------- Google

let googleTranslationBlockedUntil = 0;

function googleEndpoint(text, target) {
  return 'https://translate.googleapis.com/translate_a/single'
    + `?client=gtx&sl=auto&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(text)}`;
}

function parseGoogleResponse(data) {
  const segments = Array.isArray(data?.[0]) ? data[0] : [];
  return segments
    .map((segment) => (Array.isArray(segment) && typeof segment[0] === 'string' ? segment[0] : ''))
    .join('');
}

async function translateWithGoogle(texts, target) {
  if (Date.now() < googleTranslationBlockedUntil) throw new Error('google unavailable');
  const results = [];
  // One request per batch keeps the common case fast; a line-count mismatch
  // means Google merged or split paragraphs, so that batch is retried one by
  // one instead of shifting every later translation by one.
  for (let index = 0; index < texts.length; index += 6) {
    const batch = texts.slice(index, index + 6);
    try {
      const data = await fetchJson(googleEndpoint(batch.join('\n'), target), { timeoutMs: 4_000 });
      const translated = parseGoogleResponse(data);
      const lines = translated.split('\n');
      if (lines.length === batch.length && lines.every((line) => line.trim())) {
        results.push(...lines);
        continue;
      }
    } catch (error) {
      googleTranslationBlockedUntil = Date.now() + 30 * 60_000;
      throw error;
    }
    for (const text of batch) {
      const data = await fetchJson(googleEndpoint(text, target), { timeoutMs: 4_000 });
      const translated = parseGoogleResponse(data);
      if (!translated.trim()) throw new Error('empty translation');
      results.push(translated);
    }
  }
  return results;
}

// ----------------------------------------------------------------- MyMemory

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

async function translateOneWithMyMemory(text, target) {
  const source = detectSourceLanguage(text);
  if (source === target) return text;
  // MyMemory rejects queries over 500 bytes, which CJK text reaches at ~160
  // characters even though the string itself looks short.
  const pieces = [];
  let rest = text;
  while (rest) {
    const chunk = splitForTranslation(rest, 450)[0] ?? rest;
    if (Buffer.byteLength(chunk, 'utf8') <= 480) {
      pieces.push(chunk);
      rest = rest.slice(chunk.length);
      continue;
    }
    let cut = Math.min(chunk.length, 150);
    while (cut > 20 && Buffer.byteLength(chunk.slice(0, cut), 'utf8') > 480) cut -= 10;
    pieces.push(chunk.slice(0, cut));
    rest = rest.slice(cut);
  }
  const results = [];
  for (const piece of pieces) {
    const endpoint = 'https://api.mymemory.translated.net/get'
      + `?q=${encodeURIComponent(piece)}&langpair=${encodeURIComponent(source)}|${encodeURIComponent(target)}`;
    const data = await fetchJson(endpoint, { timeoutMs: 15_000 });
    const translated = data?.responseData?.translatedText;
    if (typeof translated !== 'string' || !translated.trim()) throw new Error('empty translation');
    if (/INVALID SOURCE LANGUAGE|QUERY LENGTH LIMIT|MYMEMORY WARNING/i.test(translated)) {
      throw new Error('translation rejected');
    }
    if (data?.quotaFinished) throw new Error('mymemory quota reached');
    results.push(decodeHtmlEntities(translated));
  }
  return results.join(' ');
}

async function translateWithMyMemory(texts, target) {
  const results = new Array(texts.length);
  let cursor = 0;
  // The free quota is per-IP and drops requests under load; two at a time keeps
  // long pages moving without tripping it.
  const worker = async () => {
    while (cursor < texts.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await translateOneWithMyMemory(texts[index], target);
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, texts.length) }, worker));
  return results;
}

// --------------------------------------------------------------- Dispatcher

const BASE_ORDER = ['deepl', 'google', 'mymemory'];
/** The last provider that answered, so a long article does not re-probe a dead one. */
let preferredProvider = '';

function providerOrder(requested) {
  if (requested !== 'auto') return [requested, ...BASE_ORDER.filter((item) => item !== requested)];
  const order = [...BASE_ORDER];
  if (preferredProvider && order.includes(preferredProvider)) {
    order.splice(order.indexOf(preferredProvider), 1);
    order.unshift(preferredProvider);
  }
  return order;
}

async function runProvider(provider, texts, target, apiKey) {
  if (provider === 'deepl') return translateWithDeepl(texts, target, apiKey);
  if (provider === 'google') return translateWithGoogle(texts, target);
  return translateWithMyMemory(texts, target);
}

async function translateTexts(texts, target, provider = 'auto', apiKey = '') {
  const cleanTarget = TRANSLATION_TARGETS.has(target) ? target : 'zh-CN';
  const cleanProvider = PROVIDERS.has(provider) ? provider : 'auto';
  const cleanTexts = (Array.isArray(texts) ? texts : [])
    .filter((text) => typeof text === 'string' && text.trim())
    .map((text) => text.slice(0, 4000))
    .slice(0, 320);
  if (cleanTexts.length === 0) return { ok: true, translations: [], provider: cleanProvider };

  const source = detectSourceLanguage(cleanTexts.join(' '));
  if (source === cleanTarget) {
    return { ok: false, error: 'same-language', translations: [], provider: cleanProvider };
  }

  // Google answers in well under a second where it is reachable, and times out
  // where it is not. Waiting for that timeout on every first page is the main
  // reason translation felt broken, so MyMemory joins after 0.7 s and whichever
  // finishes first wins.
  if (cleanProvider === 'auto' && !String(apiKey || '').trim()) {
    const tasks = [
      { id: 'google', promise: translateWithGoogle(cleanTexts, cleanTarget) },
      {
        id: 'mymemory',
        promise: new Promise((resolve) => setTimeout(resolve, 700))
          .then(() => translateWithMyMemory(cleanTexts, cleanTarget)),
      },
    ].map((task) => task.promise.then(
      (translations) => ({ id: task.id, ok: true, translations }),
      (error) => ({ id: task.id, ok: false, error: error instanceof Error ? error.message : String(error) }),
    ));

    const failures = [];
    let pending = tasks;
    while (pending.length > 0) {
      const winner = await Promise.race(pending);
      pending = pending.filter((task) => task !== winner);
      if (!winner.ok) {
        failures.push(`${winner.id}: ${winner.error}`);
        continue;
      }
      const translations = Array.isArray(winner.translations) ? winner.translations : [];
      if (translations.length !== cleanTexts.length) {
        failures.push(`${winner.id}: length mismatch`);
        continue;
      }
      if (!translations.some((text, index) => text && text !== cleanTexts[index])) {
        failures.push(`${winner.id}: no change`);
        continue;
      }
      preferredProvider = winner.id;
      return { ok: true, translations, provider: winner.id };
    }
    return {
      ok: false,
      error: failures.join('; ') || 'translation unavailable',
      translations: [],
      provider: cleanProvider,
    };
  }

  let lastError = '';
  for (const candidate of providerOrder(cleanProvider)) {
    if (candidate === 'deepl' && !String(apiKey || '').trim()) {
      if (cleanProvider === 'deepl') lastError = 'deepl key missing';
      continue;
    }
    try {
      const translations = await runProvider(candidate, cleanTexts, cleanTarget, apiKey);
      if (!Array.isArray(translations) || translations.length !== cleanTexts.length) {
        throw new Error('length mismatch');
      }
      const changed = translations.some((text, index) => typeof text === 'string' && text && text !== cleanTexts[index]);
      if (!changed) throw new Error('no change');
      preferredProvider = candidate;
      return { ok: true, translations, provider: candidate };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return { ok: false, error: lastError || 'translation unavailable', translations: [], provider: cleanProvider };
}

module.exports = {
  translateTexts,
  splitForTranslation,
  detectSourceLanguage,
  matchProvider: (value) => (PROVIDERS.has(value) ? value : 'auto'),
};
