/**
 * Per-site compatibility patches that run in the page's main world.
 *
 * Everything here compensates for a defect on the site itself, so each entry is
 * scoped to one host and stays deliberately small: no globals leak, the script
 * guards against double injection, and a missing DOM node makes it a no-op.
 */

/**
 * bilibili.com home carousel.
 *
 * The homepage carousel renders 11 slides but only 9 pagination dots, because
 * two ad placeholders come back as zero-width slides. The site's index math then
 * walks past the end of the strip: the viewport lands on empty space, so the
 * banner area shows a blank grey block for several seconds while the dots and
 * arrows keep working.
 *
 * The patch watches the strip geometry. When no slide of usable width overlaps
 * the visible carousel area for two samples in a row (~0.8s, far longer than a
 * slide transition), it clicks the next pagination dot so the site re-renders a
 * valid index. It stays out of the way while the site itself is showing its
 * "content blocked" notice.
 */
const BILIBILI_CAROUSEL_FIX = `(function () {
  if (window.__lumaCarouselFix) return;
  window.__lumaCarouselFix = true;
  window.__lumaCarouselFixRepairs = 0;
  var strikes = 0;
  var lastRepair = 0;

  function onScreen(node) {
    var rect = node.getBoundingClientRect();
    if (rect.width < 80 || rect.height < 80) return false;
    return rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
  }

  function siteShowsNotice(wrap) {
    var tips = wrap.querySelectorAll('.extension-tips-v2');
    for (var i = 0; i < tips.length; i += 1) {
      var label = tips[i].querySelector('.tips1');
      if (label && getComputedStyle(label).display !== 'none') return true;
    }
    return false;
  }

  // The strip is translated by whole slide widths, so the site's index can park
  // the viewport past the last real slide. Nothing can be painted there; this is
  // the exact signature of the defect.
  function pastLastDot(wrap) {
    var dots = wrap.querySelectorAll('.carousel-dots-dot');
    var strip = wrap.querySelector('.vui_carousel__slides');
    if (!dots.length || !strip) return false;
    var raw = (strip.style.getPropertyValue('--translate-x-slides') || '').trim();
    var match = /^-?(\\d+(?:\\.\\d+)?)%$/.exec(raw);
    if (!match) return false;
    return Number(match[1]) / 100 > dots.length - 1 + 0.01;
  }

  // Geometry rather than hit testing: slide transitions animate the strip, so
  // elementFromPoint reports the moving container for a moment and cannot tell
  // a transition apart from an empty viewport.
  function hasUsableSlide(wrap) {
    var box = wrap.getBoundingClientRect();
    var left = Math.max(box.left, 0);
    var right = Math.min(box.right, window.innerWidth);
    if (right - left < 80) return true;
    var slides = wrap.querySelectorAll('.vui_carousel__slide');
    for (var i = 0; i < slides.length; i += 1) {
      var rect = slides[i].getBoundingClientRect();
      if (rect.width < 40) continue;
      if (rect.right > left + 24 && rect.left < right - 24) return true;
    }
    return false;
  }

  function advance(wrap) {
    var dots = Array.prototype.slice.call(wrap.querySelectorAll('.carousel-dots-dot'));
    if (!dots.length) return false;
    var active = wrap.querySelector('.carousel-dots-dot.is-active');
    var index = dots.indexOf(active);
    var next = dots[(index + 1) % dots.length];
    if (!next) return false;
    var sink = next.querySelector('*') || next;
    sink.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return true;
  }

  function repair(wrap) {
    // Never click twice in quick succession: a slow re-render must not cascade
    // into a burst of pagination jumps.
    if (Date.now() - lastRepair < 1500) return;
    if (!advance(wrap)) return;
    lastRepair = Date.now();
    window.__lumaCarouselFixRepairs += 1;
  }

  function check() {
    if (document.hidden) { strikes = 0; return; }
    var wrap = document.querySelector('.vui_carousel');
    if (!wrap || !onScreen(wrap)) { strikes = 0; return; }
    if (siteShowsNotice(wrap)) { strikes = 0; return; }
    if (!pastLastDot(wrap) && hasUsableSlide(wrap)) { strikes = 0; return; }
    strikes += 1;
    if (strikes < 2) return;
    strikes = 0;
    repair(wrap);
  }

  window.setInterval(check, 400);
})();`;

const SITE_FIXES = [
  { id: 'bilibili-carousel', host: /(^|\.)bilibili\.com$/i, script: BILIBILI_CAROUSEL_FIX },
];

/** @param {string} url */
function siteFixesFor(url) {
  let host = '';
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return [];
    host = parsed.hostname;
  } catch {
    return [];
  }
  return SITE_FIXES.filter((fix) => fix.host.test(host)).map((fix) => ({ id: fix.id, script: fix.script }));
}

module.exports = { siteFixesFor, SITE_FIXES };
