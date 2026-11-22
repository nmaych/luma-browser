import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pipButtonScriptFor, PIP_BUTTON_SCRIPT } = require('../electron/main/pip-button.cjs');

describe('pip button injection', () => {
  it('runs on http(s) pages only', () => {
    expect(pipButtonScriptFor('https://www.bilibili.com/video/BV1')).toBe(PIP_BUTTON_SCRIPT);
    expect(pipButtonScriptFor('http://127.0.0.1:8080/player')).toBe(PIP_BUTTON_SCRIPT);
    for (const url of ['file:///D:/dist/index.html', 'luma://settings', 'about:blank', '', null]) {
      expect(pipButtonScriptFor(url)).toBe('');
    }
  });

  it('paints the button over the hovered video and toggles the native window', () => {
    expect(PIP_BUTTON_SCRIPT).toContain("document.addEventListener('mousemove'");
    expect(PIP_BUTTON_SCRIPT).toContain('luma-pip-button');
    expect(PIP_BUTTON_SCRIPT).toContain('requestPictureInPicture');
    expect(PIP_BUTTON_SCRIPT).toContain('position:fixed');
    expect(PIP_BUTTON_SCRIPT).toContain("setAttribute('aria-label', '视频小窗')");
  });

  it('publishes the video title instead of the page URL', () => {
    // The floating window takes its title from the document; a player that
    // leaves a URL in document.title made the window look like a URL bar.
    expect(PIP_BUTTON_SCRIPT).toContain('navigator.mediaSession.metadata');
    expect(PIP_BUTTON_SCRIPT).toContain('MediaMetadata');
    expect(PIP_BUTTON_SCRIPT).toContain('og:title');
    expect(PIP_BUTTON_SCRIPT).toContain('document.title = title');
  });
});
