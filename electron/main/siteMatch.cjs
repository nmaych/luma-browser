/**
 * Ad blocking is paused per site, not per hostname.
 *
 * The toolbar stores the host the address bar shows, which drops the `www.`
 * prefix (`bilibili.com`), while requests and documents arrive with the full
 * host (`www.bilibili.com`, `api.bilibili.com`, `s1.hdslb.com`, ...). Comparing
 * the two by equality made "暂停此网站拦截" a silent no-op on every site that is
 * served from a subdomain — the switch flipped, the settings file changed, and
 * requests were still cancelled.
 *
 * A site therefore covers itself and everything below it, and the `www.` form
 * is treated as the same site as the bare domain. Nothing is collapsed past
 * that: disabling `s1.hdslb.com` must not disable `www.bilibili.com`.
 */

function siteKey(host) {
  return String(host ?? '').trim().toLowerCase().replace(/^www\./, '');
}

function hostMatchesSite(host, site) {
  const key = siteKey(host);
  const parent = siteKey(site);
  if (!key || !parent) return false;
  return key === parent || key.endsWith(`.${parent}`);
}

function sitesIncludeHost(sites, host) {
  if (!Array.isArray(sites) || !host) return false;
  return sites.some((site) => hostMatchesSite(host, site));
}

module.exports = { siteKey, hostMatchesSite, sitesIncludeHost };
