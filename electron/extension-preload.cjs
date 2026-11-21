/**
 * Extension-page compatibility shim.
 *
 * Electron implements a slice of `chrome.*`, but not `chrome.tabs.create` or
 * `chrome.windows.create` — the two calls an extension uses to open a page. A
 * dashboard button therefore threw `chrome.tabs.create is not a function` and
 * the click did nothing.
 *
 * This preload runs in the page's own world (these windows disable context
 * isolation) so it can patch the very `chrome` object the extension sees. Each
 * call is forwarded to the browser process, which decides where the page goes:
 * an `http(s)` address becomes a normal tab, a `chrome-extension://` address
 * opens in its own window so it keeps its own origin.
 *
 * Only these two methods are added. Everything else stays exactly as Electron
 * implements it, and a missing method is never faked beyond what the browser
 * process can actually honour.
 */

const { ipcRenderer } = require('electron');

const CALLBACK_OK = (value) => value;

function openThroughBrowser(url, active) {
  const target = typeof url === 'string' ? url.trim() : '';
  if (!target) return Promise.resolve(null);
  return ipcRenderer
    .invoke('extensions:open-url', { url: target, active: active !== false })
    .then((result) => (result && result.ok ? { id: result.tabId ?? -1, url: result.url ?? target, active: active !== false } : null))
    .catch(() => null);
}

/** Chrome accepts a string, a props object, or nothing at all. */
function propsOf(input) {
  if (typeof input === 'string') return { url: input };
  if (input && typeof input === 'object') return input;
  return {};
}

function install() {
  const chrome = (window.chrome = window.chrome || {});

  const tabs = chrome.tabs || (chrome.tabs = {});
  if (typeof tabs.create !== 'function') {
    tabs.create = (input, callback) => {
      const props = propsOf(input);
      const request = openThroughBrowser(props.url, props.active).then((tab) => {
        const done = typeof callback === 'function' ? callback : CALLBACK_OK;
        done(tab ?? undefined);
        return tab ?? undefined;
      });
      return request;
    };
  }

  if (!chrome.windows) {
    chrome.windows = {
      create: (input, callback) => {
        const props = propsOf(input);
        const target = Array.isArray(props.url) ? props.url[0] : props.url;
        const request = openThroughBrowser(target, true).then((tab) => {
          const result = tab ? { id: tab.id, focused: true, tabs: [tab] } : undefined;
          const done = typeof callback === 'function' ? callback : CALLBACK_OK;
          done(result);
          return result;
        });
        return request;
      },
    };
  }
}

// A preload runs before the document, so the extension's own scripts already
// see the patched object.
install();
