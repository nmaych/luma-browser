import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * The guest preload is a CommonJS module that talks to Electron directly. It is
 * loaded through Node's own loader (like the PiP script) with `electron`
 * swapped for a stub, so the dropdown can be driven through real DOM events.
 */
const calls: Array<{ channel: string; args: unknown[] }> = [];
let suggestions: Array<{ id: string; username: string }> = [
  { id: 'entry-1', username: 'alice@example.com' },
];

const ipcRenderer = {
  invoke: (channel: string, ...args: unknown[]) => {
    calls.push({ channel, args });
    if (channel === 'passwords:suggest') return Promise.resolve(suggestions);
    if (channel === 'passwords:fill-entry') {
      return Promise.resolve({ username: 'alice@example.com', password: 's3cret-pass' });
    }
    return Promise.resolve(null);
  },
  send: () => undefined,
  on: () => undefined,
};

let restoreLoader: () => void = () => undefined;

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nodeModule = require('node:module') as any;
  const original = nodeModule._load;
  nodeModule._load = function patched(request: string, parent: unknown, isMain: boolean) {
    if (request === 'electron') return { ipcRenderer };
    return original.call(this, request, parent, isMain);
  };
  restoreLoader = () => {
    nodeModule._load = original;
  };
  require('../electron/guest-preload.cjs');
});

afterAll(() => {
  restoreLoader();
});

beforeEach(() => {
  document.body.innerHTML = '';
  suggestions = [{ id: 'entry-1', username: 'alice@example.com' }];
});

const PANEL = '[data-luma-autofill]';

async function waitFor(predicate: () => boolean, timeout = 1500): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition was not met in time');
}

function stubRect(element: HTMLElement): void {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      left: 40, top: 120, right: 280, bottom: 156, width: 240, height: 36, x: 40, y: 120, toJSON: () => ({}),
    }),
  });
}

function loginForm(): { user: HTMLInputElement; password: HTMLInputElement } {
  document.body.innerHTML = '<form><input id="user" type="text"><input id="password" type="password"></form>';
  const user = document.getElementById('user') as HTMLInputElement;
  const password = document.getElementById('password') as HTMLInputElement;
  stubRect(user);
  stubRect(password);
  return { user, password };
}

describe('saved-login dropdown', () => {
  it('opens above a clicked login field and keeps the list out of the page DOM', async () => {
    const { user } = loginForm();
    user.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));

    await waitFor(() => Boolean(document.querySelector(PANEL)));
    const host = document.querySelector(PANEL) as HTMLElement;
    // A closed shadow root is what keeps page scripts from reading the accounts.
    expect(host.shadowRoot).toBeNull();
    expect(host.textContent).toBe('');
    expect(calls.some((call) => call.channel === 'passwords:suggest')).toBe(true);
  });

  it('ignores fields on a page that never asks for a password', async () => {
    document.body.innerHTML = '<input id="search" type="search">';
    const search = document.getElementById('search') as HTMLInputElement;
    stubRect(search);
    search.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(document.querySelector(PANEL)).toBeNull();
  });

  it('dismisses on Escape', async () => {
    const { user } = loginForm();
    user.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    await waitFor(() => Boolean(document.querySelector(PANEL)));

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector(PANEL)).toBeNull();
  });

  it('fills both fields when a suggestion is picked with the keyboard', async () => {
    const { user, password } = loginForm();
    user.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    await waitFor(() => Boolean(document.querySelector(PANEL)));

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    await waitFor(() => password.value === 's3cret-pass');
    expect(user.value).toBe('alice@example.com');
    expect(document.querySelector(PANEL)).toBeNull();
    expect(calls.some((call) => call.channel === 'passwords:fill-entry')).toBe(true);
  });
});
