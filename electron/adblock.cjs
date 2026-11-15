// Ad blocking has two layers:/n//  1. A Ghostery engine built from EasyList / EasyPrivacy / EasyList China /
//     AdGuard Chinese, cached on disk and refreshed weekly.
// 2. A compact built-in host list used before the engine is ready or when the
//     machine is offline.

const fs = require('node:fs');
const path = require('node:path');
const { ElectronBlocker, Request } = require('@ghostery/adblocker-electron');

const BLOCKED_HOSTS = new Set([
  // Google advertising & analytics
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'googletagservices.com',
  'googletagmanager.com',
  'google-analytics.com',
  'analytics.google.com',
  'adservice.google.com',
  'adservice.google.com.hk',
  'pagead2.googlesyndication.com',
  'partner.googleadservices.com',
  '2mdn.net',
  'serving-sys.com',
  // Amazon / Microsoft / Yahoo ad networks
  'amazon-adsystem.com',
  'adsymptotic.com',
  'ads.linkedin.com',
  'bat.bing.com',
  'clarity.ms',
  'adnxs.com',
  'ads.yahoo.com',
  'analytics.yahoo.com',
  'gemini.yahoo.com',
  // Major independent ad exchanges & trackers
  'adsrvr.org',
  'advertising.com',
  'adform.net',
  'adroll.com',
  'adsafeprotected.com',
  'bidswitch.net',
  'casalemedia.com',
  'contextweb.com',
  'criteo.com',
  'criteo.net',
  'demdex.net',
  'dotomi.com',
  'exelator.com',
  'eyeota.net',
  'googleadapis.com',
  'ib.adnxs.com',
  'improvedigital.com',
  'indexww.com',
  'inmobi.com',
  'innity.com',
  'krxd.net',
  'lijit.com',
  'mathtag.com',
  'media.net',
  'moatads.com',
  'mookie1.com',
  'openx.net',
  'outbrain.com',
  'pubmatic.com',
  'quantserve.com',
  'quantcount.com',
  'rubiconproject.com',
  'scorecardresearch.com',
  'sharethrough.com',
  'simpli.fi',
  'smartadserver.com',
  'sovrn.com',
  'spotxchange.com',
  'taboola.com',
  'teads.tv',
  'tremorhub.com',
  'tribalfusion.com',
  'turn.com',
  'yieldmo.com',
  'zedo.com',
  'zemanta.com',
  '33across.com',
  '3lift.com',
  '1rx.io',
  'agkn.com',
  'bluekai.com',
  'rlcdn.com',
  'tapad.com',
  'crwdcntrl.net',
  'narrative.io',
  'liadm.com',
  'id5-sync.com',
  'adsymptotic.com',
  'adhigh.net',
  'adkernel.com',
  'adotmob.com',
  'adpone.com',
  'adpushup.com',
  'adskeeper.com',
  'adspirit.de',
  'advertising.com',
  'adx.opera.com',
  'aerserv.com',
  'am15.net',
  'aniview.com',
  'apester.com',
  'appier.net',
  'appnexus.com',
  'bebi.com',
  'bidr.io',
  'bidsxchange.com',
  'bidvertiser.com',
  'bizographics.com',
  'brealtime.com',
  'bttrack.com',
  'buysellads.com',
  'buzzoola.com',
  'chartbeat.com',
  'chartbeat.net',
  'clickagy.com',
  'clicktale.net',
  'connatix.com',
  'convertro.com',
  'crazyegg.com',
  'ctnsnet.com',
  'de17a.com',
  'deepintent.com',
  'districtm.io',
  'domdex.com',
  'doubleverify.com',
  'dsp.io',
  'e-planning.net',
  'emxdgt.com',
  'ensighten.com',
  'everesttech.net',
  'extremereach.com',
  'fastclick.net',
  'fout.jp',
  'freewheel.tv',
  'getintent.com',
  'gumgum.com',
  'heapanalytics.com',
  'hotjar.com',
  'im-apps.net',
  'impact-ad.jp',
  'impactradius.com',
  'inspectlet.com',
  'intellitxt.com',
  'intergient.com',
  'ipredictive.com',
  'jads.co',
  'jivox.com',
  'justpremium.com',
  'kargo.com',
  'kissmetrics.com',
  'krushmedia.com',
  'liveramp.com',
  'loopme.me',
  'lqm.io',
  'madadsmedia.com',
  'marfeel.com',
  'mediaplex.com',
  'metadsp.co.uk',
  'mgid.com',
  'mixpanel.com',
  'mobpro.com',
  'monetate.net',
  'nativeads.com',
  'nativo.com',
  'netmng.com',
  'nexage.com',
  'nrich.ai',
  'ntv.io',
  'nuanceads.com',
  'omtrdc.net',
  'onclasrv.com',
  'onetag-sys.com',
  'openx.com',
  'optimatic.com',
  'parsely.com',
  'perfectaudience.com',
  'permutive.com',
  'pippio.com',
  'pixel.ad',
  'platform161.com',
  'playground.xyz',
  'plista.com',
  'popads.net',
  'powerlinks.com',
  'ppjol.com',
  'presage.io',
  'pro-market.net',
  'pubmatic.com',
  'pulsepoint.com',
  'pushcrew.com',
  'quantum-advertising.com',
  'recreativ.ru',
  'revcontent.com',
  'revenuehits.com',
  'rhythmone.com',
  'rtbhouse.com',
  'rubiconproject.com',
  'sape.ru',
  'seedtag.com',
  'serving-sys.com',
  'sessioncam.com',
  'sharethis.com',
  'siftscience.com',
  'sizmek.com',
  'skimresources.com',
  'smartlook.com',
  'smadex.com',
  'socdm.com',
  'sonobi.com',
  'springserve.com',
  'statcounter.com',
  'storygize.net',
  'stupidfox.net',
  'sumo.com',
  'supersonicads.com',
  'survata.com',
  'tealiumiq.com',
  'tidaltv.com',
  'tns-counter.ru',
  'top100.ru',
  'trafficjunky.net',
  'tradedoubler.com',
  'tradelab.fr',
  'tribalfusion.com',
  'trustx.org',
  'twiago.com',
  'uberads.com',
  'unrulymedia.com',
  'usemax.de',
  'vidoomy.com',
  'vidora.com',
  'vindicosuite.com',
  'visualrevenue.com',
  'vungle.com',
  'weborama.fr',
  'webtrends.com',
  'widespace.com',
  'yieldlab.net',
  'yieldmanager.com',
  'yieldmo.com',
  'yieldoptimizer.com',
  'zeotap.com',
  // Chinese advertising, analytics & tracking services
  'cpro.baidu.com',
  'pos.baidu.com',
  'hm.baidu.com',
  'union.baidu.com',
  'tanx.com',
  'alimama.com',
  'mmstat.com',
  'atanx.alicdn.com',
  'log.mmstat.com',
  'cnzz.com',
  'umeng.com',
  'umeng.co',
  'umengcloud.com',
  'talkingdata.com',
  'talkingdata.net',
  'growingio.com',
  'sensorsdata.cn',
  'sensorsdata.com',
  'miaozhen.com',
  'admaster.com.cn',
  'ipinyou.com',
  'mediav.com',
  'irs01.com',
  'irs01.net',
  'adview.cn',
  'domob.cn',
  'gdt.qq.com',
  'e.qq.com',
  'pingjs.qq.com',
  'ta.qq.com',
  'pingtcss.qq.com',
  'analytics.163.com',
  'iadmat.cn',
  'adchina.com',
  'allyes.com',
  'wangmeng.baidu.com',
  'cpro.baidustatic.com',
  'mobads.baidu.com',
  'mobads-logs.baidu.com',
  'adx.xiaomi.com',
  'tracking.miui.com',
  'stat.ameba.jp',
  'ad.360yield.com',
  'admaster.xyz',
]);

const EXEMPT_RESOURCE_TYPES = new Set(['mainFrame']);

function hostnameOf(url) {
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isBlockedHost(host) {
  if (!host) return false;
  // Walk the domain suffixes instead of scanning the whole list for every request.
  let candidate = host;
  while (candidate) {
    if (BLOCKED_HOSTS.has(candidate)) return true;
    const dot = candidate.indexOf('.');
    if (dot < 0) break;
    candidate = candidate.slice(dot + 1);
  }
  return false;
}

/**
 * @param {string} url
 * @param {string | null} siteHost top-level page host, used to exempt first-party requests
 * @param {string} resourceType
 */
function shouldBlock(url, siteHost, resourceType) {
  if (EXEMPT_RESOURCE_TYPES.has(resourceType)) return false;
  const host = hostnameOf(url);
  if (!host) return false;
  if (siteHost && (host === siteHost || host.endsWith(`.${siteHost}`))) return false;
  return isBlockedHost(host);
}

const RULE_LISTS = [
  { id: 'easylist', label: 'EasyList', url: 'https://easylist.to/easylist/easylist.txt' },
  { id: 'easyprivacy', label: 'EasyPrivacy', url: 'https://easylist.to/easylist/easyprivacy.txt' },
  { id: 'easylist-china', label: 'EasyList China', url: 'https://easylist-downloads.adblockplus.org/easylistchina.txt' },
  { id: 'adguard-china', label: 'AdGuard 中文', url: 'https://filters.adtidy.org/extension/ublock/filters/224.txt' },
];
const CACHE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Luma/1.4';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class AdblockManager {
  constructor({ userDataDir, fetchImpl, onUpdate }) {
    this.directory = path.join(userDataDir, 'adblock');
    this.fetchImpl = fetchImpl;
    this.onUpdate = typeof onUpdate === 'function' ? onUpdate : null;
    this.blocker = null;
    this.ruleCount = BLOCKED_HOSTS.size;
    this.lastUpdated = null;
    this.updating = false;
    this.error = null;
    this.sources = [];
    this.loadPromise = null;
  }

  cacheFile(name) {
    return path.join(this.directory, name);
  }

  status() {
    return {
      engine: this.blocker ? 'ghostery' : 'builtin',
      ruleCount: this.ruleCount,
      lastUpdated: this.lastUpdated,
      updating: this.updating,
      error: this.error,
      sources: this.sources,
    };
  }

  async fetchText(url, attempts = 3) {
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25_000);
      try {
        const response = await this.fetchImpl(url, {
          signal: controller.signal,
          headers: { 'User-Agent': USER_AGENT, Accept: 'text/plain,*/*' },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        if (!text || text.length < 1000) throw new Error('empty rule list');
        return text;
      } catch (error) {
        lastError = error;
        await delay(400 * (attempt + 1));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError ?? new Error('rule list unavailable');
  }

  async load() {
    try {
      const meta = JSON.parse(fs.readFileSync(this.cacheFile('meta.json'), 'utf8'));
      const serialized = fs.readFileSync(this.cacheFile('engine.bin'));
      this.blocker = ElectronBlocker.deserialize(new Uint8Array(serialized));
      this.lastUpdated = Number(meta.lastUpdated) || null;
      this.ruleCount = Number(meta.ruleCount) || this.ruleCount;
      this.sources = Array.isArray(meta.sources) ? meta.sources : [];
    } catch {
      // No usable cache yet; the built-in list covers the first page loads.
    }
    if (!this.blocker || !this.lastUpdated || Date.now() - this.lastUpdated > CACHE_MAX_AGE) {
      void this.update(false);
    }
    return this.status();
  }

  async update(force = false) {
    if (this.updating) return this.status();
    if (!force && this.blocker && this.lastUpdated && Date.now() - this.lastUpdated < CACHE_MAX_AGE) {
      return this.status();
    }
    this.updating = true;
    this.error = null;
    try {
      const results = await Promise.allSettled(RULE_LISTS.map(async (list) => ({
        ...list,
        text: await this.fetchText(list.url),
      })));
      const available = results
        .filter((result) => result.status === 'fulfilled')
        .map((result) => result.value);
      if (available.length === 0) throw new Error('规则列表全部下载失败');
      const blocker = ElectronBlocker.parse(available.map((list) => list.text).join('\n'));
      const filters = blocker.getFilters();
      const ruleCount = filters.networkFilters.length + filters.cosmeticFilters.length;
      if (ruleCount < 1000) throw new Error('规则列表内容异常');
      this.blocker = blocker;
      this.ruleCount = ruleCount;
      this.lastUpdated = Date.now();
      this.sources = available.map((list) => ({ id: list.id, label: list.label }));
      this.persist(blocker, {
        lastUpdated: this.lastUpdated,
        ruleCount,
        sources: this.sources,
      });
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      console.error('[adblock] update failed:', this.error);
    } finally {
      this.updating = false;
      if (this.onUpdate) {
        try {
          this.onUpdate(this.status());
        } catch {
          // A listener failure must not break rule loading.
        }
      }
    }
    return this.status();
  }

  persist(blocker, meta) {
    try {
      fs.mkdirSync(this.directory, { recursive: true });
      const engineTmp = this.cacheFile('engine.bin.tmp');
      fs.writeFileSync(engineTmp, Buffer.from(blocker.serialize()));
      fs.renameSync(engineTmp, this.cacheFile('engine.bin'));
      const metaTmp = this.cacheFile('meta.json.tmp');
      fs.writeFileSync(metaTmp, JSON.stringify(meta, null, 2), 'utf8');
      fs.renameSync(metaTmp, this.cacheFile('meta.json'));
    } catch (error) {
      console.error('[adblock] could not persist rule engine:', error);
    }
  }

  /**
   * @param {{ url: string; sourceUrl: string; type: string; siteHost: string | null }} request
   */
  match({ url, sourceUrl, type, siteHost }) {
    if (this.blocker) {
      try {
        const request = Request.fromRawDetails({ url, sourceUrl, type });
        if (request.isSupported) {
          const result = this.blocker.match(request);
          if (result.match && !result.exception) {
            return {
              block: true,
              redirect: result.redirect?.dataUrl ?? null,
            };
          }
          return { block: false, redirect: null };
        }
      } catch {
        // Fall through to the built-in list.
      }
    }
    return { block: shouldBlock(url, siteHost, type), redirect: null };
  }

  cosmetics(url) {
    if (!this.blocker) return null;
    try {
      const request = Request.fromRawDetails({ url, type: 'mainFrame' });
      if (!request.isSupported) return null;
      const result = this.blocker.getCosmeticsFilters({
        url,
        hostname: request.hostname,
        domain: request.domain || request.hostname,
        getBaseRules: true,
        getRulesFromHostname: true,
        getInjectionRules: false,
        getExtendedRules: false,
        getRulesFromDOM: false,
      });
      if (!result.active || !result.styles) return null;
      return { styles: result.styles.slice(0, 400_000) };
    } catch {
      return null;
    }
  }
}

module.exports = {
  shouldBlock,
  hostnameOf,
  isBlockedHost,
  AdblockManager,
  RULE_LISTS,
  ruleCount: BLOCKED_HOSTS.size,
};
