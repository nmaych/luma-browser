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
 * The homepage carousel ships eleven slides but only nine pagination dots: two
 * of the slides are the empty ad slot, which the site fills with `eva.png`, a
 * 76px placeholder tile. The dots skip those two, the automatic rotation does
 * not, so every full cycle parks the strip on a slide with nothing to paint: the
 * banner area turns into a white-to-grey gradient for a whole rotation while the
 * dots and arrows keep working.
 *
 * The patch samples the strip and steps off a placeholder slide with the next
 * pagination dot. The two placeholder slides are adjacent, so two steps are
 * needed in a row; the cooldown keeps that from becoming a click loop, and the
 * geometry fallback still covers an index that runs off the end of the strip.
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
  // the viewport past the last real slide. Nothing can be painted there.
  function pastLastDot(wrap) {
    var dots = wrap.querySelectorAll('.carousel-dots-dot');
    var strip = wrap.querySelector('.vui_carousel__slides');
    if (!dots.length || !strip) return false;
    var raw = (strip.style.getPropertyValue('--translate-x-slides') || '').trim();
    var match = /^-?(\\d+(?:\\.\\d+)?)%$/.exec(raw);
    if (!match) return false;
    return Number(match[1]) / 100 > dots.length - 1 + 0.01;
  }

  // The empty ad slot comes back as eva.png, a 76px transparent tile, sometimes
  // scaled up by the slide. Anything that small, or that specific, gives the
  // reader nothing to look at even though the slide itself has a healthy width.
  function slideCoverState(slide) {
    var img = slide.querySelector('img');
    if (!img) return 'blank';
    var src = img.currentSrc || img.src || '';
    if (/\\/eva\\.png(\\?|$)/.test(src)) return 'blank';
    if (img.naturalWidth > 0 && img.naturalWidth < 200) return 'blank';
    return 'cover';
  }

  // 'covered'     — the viewport shows a real banner
  // 'placeholder' — it sits on the empty ad slot instead
  // 'empty'       — no slide of usable width overlaps the viewport at all
  function viewportState(wrap) {
    var box = wrap.getBoundingClientRect();
    var left = Math.max(box.left, 0);
    var right = Math.min(box.right, window.innerWidth);
    if (right - left < 80) return 'covered';
    var slides = wrap.querySelectorAll('.vui_carousel__slide');
    var overlapping = 0;
    var covered = 0;
    var blank = 0;
    for (var i = 0; i < slides.length; i += 1) {
      var rect = slides[i].getBoundingClientRect();
      if (rect.width < 40) continue;
      if (rect.right <= left + 24 || rect.left >= right - 24) continue;
      overlapping += 1;
      if (slideCoverState(slides[i]) === 'cover') covered += 1;
      else blank += 1;
    }
    if (!overlapping) return 'empty';
    if (covered) return 'covered';
    return blank ? 'placeholder' : 'empty';
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

  function repair(wrap, cooldown) {
    if (Date.now() - lastRepair < cooldown) return;
    if (!advance(wrap)) return;
    lastRepair = Date.now();
    window.__lumaCarouselFixRepairs += 1;
  }

  function check() {
    if (document.hidden) { strikes = 0; return; }
    var wrap = document.querySelector('.vui_carousel');
    if (!wrap || !onScreen(wrap)) { strikes = 0; return; }
    if (siteShowsNotice(wrap)) { strikes = 0; return; }
    if (pastLastDot(wrap)) { strikes = 0; repair(wrap, 600); return; }
    var state = viewportState(wrap);
    if (state === 'covered') { strikes = 0; return; }
    if (state === 'placeholder') {
      // Deterministic: the strip is parked on the ad slot, not mid-transition.
      // Step off right away, then once more for the second adjacent slot.
      strikes = 0;
      repair(wrap, 600);
      return;
    }
    // Nothing of usable width overlaps the viewport: wait out a slide transition
    // before deciding the strip really is empty.
    strikes += 1;
    if (strikes < 4) return;
    strikes = 0;
    repair(wrap, 1500);
  }

  window.setInterval(check, 150);
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
