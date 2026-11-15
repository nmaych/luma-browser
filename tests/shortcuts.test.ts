import { describe, expect, it } from 'vitest';
import {
  acceleratorFromEvent,
  findShortcutConflict,
  formatAccelerator,
  matchShortcutEvent,
  parseAccelerator,
} from '../src/utils/shortcuts';

function keyEvent(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', init);
}

describe('shortcut accelerators', () => {
  it('parses modifiers and normalizes arrow keys', () => {
    expect(parseAccelerator('Ctrl+Shift+T')).toMatchObject({
      key: 't',
      control: true,
      shift: true,
      alt: false,
      meta: false,
    });
    expect(parseAccelerator('Alt+ArrowLeft')?.key).toBe('arrowleft');
    expect(parseAccelerator('NotAKey')).toBeNull();
  });

  it('requires an exact modifier match', () => {
    expect(matchShortcutEvent(keyEvent({ key: 't', ctrlKey: true }), 'Ctrl+T')).toBe(true);
    expect(matchShortcutEvent(keyEvent({ key: 'T', ctrlKey: true, shiftKey: true }), 'Ctrl+T')).toBe(false);
    expect(matchShortcutEvent(keyEvent({ key: 'ArrowLeft', altKey: true }), 'Alt+ArrowLeft')).toBe(true);
  });

  it('builds accelerators from keyboard events', () => {
    expect(acceleratorFromEvent(keyEvent({ key: 'r', ctrlKey: true, altKey: true }))).toBe('Ctrl+Alt+R');
    expect(acceleratorFromEvent(keyEvent({ key: 'F12' }))).toBe('F12');
    expect(acceleratorFromEvent(keyEvent({ key: 'Control', ctrlKey: true }))).toBeNull();
    expect(acceleratorFromEvent(keyEvent({ key: 'a' }))).toBeNull();
  });

  it('formats and detects conflicts', () => {
    expect(formatAccelerator('Alt+ArrowRight')).toEqual(['Alt', '→']);
    expect(formatAccelerator('Ctrl+Shift+B')).toEqual(['Ctrl', 'Shift', 'B']);
    const shortcuts = { 'new-tab': 'Ctrl+T', 'reopen-tab': 'Ctrl+Shift+T' };
    expect(findShortcutConflict(shortcuts, 'new-tab', 'Ctrl+Shift+T')).toBe('reopen-tab');
    expect(findShortcutConflict(shortcuts, 'new-tab', 'Ctrl+Alt+T')).toBeNull();
  });
});
