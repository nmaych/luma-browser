/**
 * Floating "video mini window" button, injected into every http(s) page.
 *
 * The menu entry made people hunt for it, so the affordance now lives where the
 * video is: hovering a player paints a small round button in its top-right
 * corner, and clicking it opens the system picture-in-picture window. The click
 * is a real user gesture, so the page can call `requestPictureInPicture()`
 * directly — no IPC round-trip, no "largest video" guessing.
 *
 * The floating window title comes from the document's media metadata, so the
 * button publishes the played video's own title (og:title / heading / player
 * label) instead of letting the window fall back to the page URL.
 */
const PIP_BUTTON_SCRIPT = `(function () {
  if (window.__lumaPipButton) return;
  window.__lumaPipButton = true;
  // Only the top document owns the overlay; embedded players are reached
  // through their own video element when the site renders one in this document.
  if (window.top !== window) return;

  var SIZE = 30;
  var INSET = 10;
  var MIN_W = 240;
  var MIN_H = 135;
  var button = null;
  var activeVideo = null;
  var frame = 0;

  function makeIcon() {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('aria-hidden', 'true');
    var screen = document.createElementNS(ns, 'rect');
    screen.setAttribute('x', '2');
    screen.setAttribute('y', '3.5');
    screen.setAttribute('width', '16');
    screen.setAttribute('height', '13');
    screen.setAttribute('rx', '2');
    screen.setAttribute('fill', 'none');
    screen.setAttribute('stroke', 'currentColor');
    screen.setAttribute('stroke-width', '1.4');
    var inner = document.createElementNS(ns, 'rect');
    inner.setAttribute('x', '10');
    inner.setAttribute('y', '9.5');
    inner.setAttribute('width', '6');
    inner.setAttribute('height', '5');
    inner.setAttribute('rx', '1.2');
    inner.setAttribute('fill', 'currentColor');
    svg.appendChild(screen);
    svg.appendChild(inner);
    return svg;
  }

  function ensureButton() {
    if (button && button.isConnected) return button;
    button = document.createElement('button');
    button.type = 'button';
    button.id = 'luma-pip-button';
    button.setAttribute('aria-label', '视频小窗');
    button.title = '视频小窗';
    button.style.cssText = [
      'position:fixed',
      'z-index:2147483646',
      'width:' + SIZE + 'px',
      'height:' + SIZE + 'px',
      'padding:0',
      'display:none',
      'align-items:center',
      'justify-content:center',
      'border-radius:9px',
      'border:1px solid rgba(255,255,255,.24)',
      'background:rgba(20,22,28,.82)',
      'color:#fff',
      'cursor:pointer',
      'opacity:0',
      'pointer-events:none',
      'box-shadow:0 6px 18px rgba(0,0,0,.38)',
      '-webkit-backdrop-filter:blur(8px)',
      'backdrop-filter:blur(8px)',
      'transition:opacity .12s ease',
    ].join(';');
    button.appendChild(makeIcon());
    // The page must not see these clicks: stop every pointer event here.
    ['pointerdown', 'mousedown', 'mouseup', 'touchstart', 'touchend'].forEach(function (type) {
      button.addEventListener(type, function (event) {
        event.preventDefault();
        event.stopPropagation();
      }, true);
    });
    button.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      if (activeVideo) toggle(activeVideo);
    }, true);
    (document.body || document.documentElement).appendChild(button);
    return button;
  }

  function visibleBox(video) {
    var rect = video.getBoundingClientRect();
    if (rect.width < MIN_W || rect.height < MIN_H) return null;
    if (rect.bottom <= 0 || rect.top >= window.innerHeight) return null;
    if (rect.right <= 0 || rect.left >= window.innerWidth) return null;
    return rect;
  }

  function videoUnder(x, y) {
    var videos = document.querySelectorAll('video');
    for (var i = 0; i < videos.length; i += 1) {
      var video = videos[i];
      if (!video || video.disablePictureInPicture) continue;
      if (!video.currentSrc && !video.src) continue;
      var rect = visibleBox(video);
      if (!rect) continue;
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return video;
    }
    return null;
  }

  function place(video) {
    var rect = visibleBox(video);
    if (!rect) { hide(); return; }
    ensureButton();
    var left = Math.min(rect.right - SIZE - INSET, window.innerWidth - SIZE - 6);
    var top = Math.max(6, Math.min(rect.top + INSET, window.innerHeight - SIZE - 6));
    left = Math.max(6, left);
    button.style.left = Math.round(left) + 'px';
    button.style.top = Math.round(top) + 'px';
    button.style.display = 'flex';
    button.style.opacity = '1';
    button.style.pointerEvents = 'auto';
    activeVideo = video;
  }

  function hide() {
    activeVideo = null;
    if (!button) return;
    button.style.opacity = '0';
    button.style.pointerEvents = 'none';
    button.style.display = 'none';
  }

  function cleanTitle(text) {
    return String(text || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
  }

  function mediaTitle() {
    try {
      var meta = navigator.mediaSession && navigator.mediaSession.metadata;
      if (meta && meta.title) return cleanTitle(meta.title);
    } catch (error) {}
    return '';
  }

  function titleFor(video) {
    var own = cleanTitle(video.getAttribute('title'));
    if (own && !/^https?:\\/\\//i.test(own)) return own;
    var og = document.querySelector('meta[property="og:title"]');
    var ogText = og ? cleanTitle(og.getAttribute('content')) : '';
    if (ogText) return ogText;
    var node = document.querySelector(
      'h1.video-title, .video-title, [class*="video-title"], [class*="videoTitle"], .bpx-player-container h1, h1'
    );
    var heading = node ? cleanTitle(node.textContent) : '';
    if (heading) return heading;
    var session = mediaTitle();
    if (session) return session;
    var pageTitle = cleanTitle(document.title);
    if (pageTitle && !/^https?:\\/\\//i.test(pageTitle)) return pageTitle;
    return '视频小窗';
  }

  var savedTitle = null;

  function publishTitle(video, title) {
    if (!title) return;
    if (!video.getAttribute('title') || /^https?:\\/\\//i.test(video.getAttribute('title'))) {
      video.setAttribute('title', title);
    }
    try {
      if (window.MediaMetadata && navigator.mediaSession) {
        navigator.mediaSession.metadata = new window.MediaMetadata({
          title: title,
          artist: location.hostname.replace(/^www\\./, ''),
          album: title,
        });
      }
    } catch (error) {}
    // The floating window copies the document title. Players that leave a URL
    // (or a bare site name) there made the window read like an address bar, so
    // swap in the video's own title for as long as the mini window is open and
    // put the original back when it closes.
    if (document.title !== title) {
      if (savedTitle === null) savedTitle = document.title;
      document.title = title;
    }
  }

  function restoreTitle() {
    if (savedTitle === null) return;
    document.title = savedTitle;
    savedTitle = null;
  }

  function toggle(video) {
    if (document.pictureInPictureElement) {
      if (document.pictureInPictureElement === video) {
        document.exitPictureInPicture().catch(function () {});
        return;
      }
      document.exitPictureInPicture().catch(function () {});
    }
    if (!video.requestPictureInPicture) {
      if (button) button.title = '这个视频不支持小窗';
      return;
    }
    if (document.pictureInPictureEnabled === false) {
      if (button) button.title = '这个页面不允许小窗播放';
      return;
    }
    publishTitle(video, titleFor(video));
    var pending = video.requestPictureInPicture();
    if (pending && typeof pending.catch === 'function') {
      pending.catch(function () {
        // The window never opened, so the title swap must not linger.
        restoreTitle();
        if (button) button.title = '无法进入视频小窗';
      });
    }
  }

  function onMove(event) {
    if (frame) return;
    var x = event.clientX;
    var y = event.clientY;
    frame = window.requestAnimationFrame(function () {
      frame = 0;
      var video = videoUnder(x, y);
      if (!video) { hide(); return; }
      place(video);
    });
  }

  function onLeave() {
    // The pointer left the document (a different window has focus).
    if (frame) { window.cancelAnimationFrame(frame); frame = 0; }
    hide();
  }

  function reposition() {
    if (activeVideo) place(activeVideo);
  }

  document.addEventListener('mousemove', onMove, { capture: true, passive: true });
  document.addEventListener('mouseleave', onLeave, true);
  window.addEventListener('scroll', reposition, { capture: true, passive: true });
  window.addEventListener('resize', reposition, { passive: true });
  document.addEventListener('fullscreenchange', reposition, true);
  document.addEventListener('enterpictureinpicture', function (event) {
    // Re-publish here as well: sites often rewrite the document title while the
    // player boots, which would otherwise put the page URL back on the window.
    publishTitle(event.target, titleFor(event.target));
    if (event.target === activeVideo && button) button.title = '退出视频小窗';
  }, true);
  document.addEventListener('leavepictureinpicture', function () {
    restoreTitle();
    if (button) button.title = '视频小窗';
  }, true);
  window.addEventListener('pagehide', hide, { once: true });
})()`;

const HTTP_URL = /^https?:\/\//i;

/** @param {string} url */
function pipButtonScriptFor(url) {
  return HTTP_URL.test(String(url || '')) ? PIP_BUTTON_SCRIPT : '';
}

module.exports = { pipButtonScriptFor, PIP_BUTTON_SCRIPT };
