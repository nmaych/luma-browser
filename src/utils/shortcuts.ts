export interface ParsedAccelerator {
  key: string;
  control: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'OS']);

function normalizeKeyToken(token: string): string {
  const lower = token.trim().toLowerCase();
  if (lower === 'space' || lower === 'spacebar' || token === ' ') return 'space';
  if (lower === 'left' || lower === 'arrowleft') return 'arrowleft';
  if (lower === 'right' || lower === 'arrowright') return 'arrowright';
  if (lower === 'up' || lower === 'arrowup') return 'arrowup';
  if (lower === 'down' || lower === 'arrowdown') return 'arrowdown';
  if (lower === 'esc' || lower === 'escape') return 'escape';
  return lower;
}

export function parseAccelerator(accelerator: string): ParsedAccelerator | null {
  if (typeof accelerator !== 'string' || !accelerator.trim()) return null;
  const parts = accelerator.split('+').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const key = parts.pop();
  if (!key) return null;
  const parsed: ParsedAccelerator = { key: normalizeKeyToken(key), control: false, shift: false, alt: false, meta: false };
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'ctrl' || lower === 'control') parsed.control = true;
    else if (lower === 'shift') parsed.shift = true;
    else if (lower === 'alt' || lower === 'option') parsed.alt = true;
    else if (['meta', 'cmd', 'command', 'super', 'win'].includes(lower)) parsed.meta = true;
    else return null;
  }
  if (!parsed.key) return null;
  // Plain letters would swallow normal typing; only function keys stand alone.
  if (!parsed.control && !parsed.shift && !parsed.alt && !parsed.meta && !/^f\d{1,2}$/.test(parsed.key)) {
    return null;
  }
  return parsed;
}

export function matchShortcutEvent(event: KeyboardEvent, accelerator: string): boolean {
  const parsed = parseAccelerator(accelerator);
  if (!parsed) return false;
  if (normalizeKeyToken(event.key) !== parsed.key) return false;
  return event.ctrlKey === parsed.control
    && event.shiftKey === parsed.shift
    && event.altKey === parsed.alt
    && event.metaKey === parsed.meta;
}

/** Builds an accelerator from a keydown event; returns null for lone modifiers. */
export function acceleratorFromEvent(event: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null;
  const key = normalizeKeyToken(event.key);
  if (!key) return null;
  const parts: string[] = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.metaKey) parts.push('Meta');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  const isFunctionKey = /^f\d{1,2}$/.test(key);
  if (parts.length === 0 && !isFunctionKey) return null;
  const displayKey = key === 'space' ? 'Space' : key.length === 1 ? key.toUpperCase() : key;
  parts.push(displayKey.charAt(0).toUpperCase() + displayKey.slice(1));
  return parts.join('+');
}

export function formatAccelerator(accelerator: string): string[] {
  const parsed = parseAccelerator(accelerator);
  if (!parsed) return [accelerator || '未设置'];
  const parts: string[] = [];
  if (parsed.control) parts.push('Ctrl');
  if (parsed.meta) parts.push('Win');
  if (parsed.alt) parts.push('Alt');
  if (parsed.shift) parts.push('Shift');
  const keyLabels: Record<string, string> = {
    space: 'Space',
    arrowleft: '←',
    arrowright: '→',
    arrowup: '↑',
    arrowdown: '↓',
    escape: 'Esc',
  };
  parts.push(keyLabels[parsed.key] ?? (parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key));
  return parts;
}

export function isValidAccelerator(accelerator: string): boolean {
  return parseAccelerator(accelerator) !== null;
}

/** Returns the action already bound to the accelerator, if any. */
export function findShortcutConflict(
  shortcuts: Record<string, string>,
  action: string,
  accelerator: string,
): string | null {
  const parsed = parseAccelerator(accelerator);
  if (!parsed) return null;
  for (const [otherAction, otherAccelerator] of Object.entries(shortcuts)) {
    if (otherAction === action) continue;
    const other = parseAccelerator(otherAccelerator);
    if (!other) continue;
    if (
      other.key === parsed.key
      && other.control === parsed.control
      && other.shift === parsed.shift
      && other.alt === parsed.alt
      && other.meta === parsed.meta
    ) {
      return otherAction;
    }
  }
  return null;
}
