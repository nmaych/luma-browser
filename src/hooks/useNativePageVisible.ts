import { useSyncExternalStore } from 'react';

// Menus only need the mirror view when a native page actually covers the React
// layer; on internal luma:// pages the regular DOM popovers are visible.
let current = false;
const listeners = new Set<() => void>();

export function setNativePageVisible(value: boolean) {
  if (current === value) return;
  current = value;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useNativePageVisible() {
  return useSyncExternalStore(subscribe, () => current, () => false);
}
