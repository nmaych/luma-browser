import { useCallback, useRef, useState, type MouseEvent } from 'react';
import { ClipboardPaste, Copy, CornerDownLeft, MousePointer2, Scissors } from 'lucide-react';
import { ContextMenu, type ContextMenuEntry } from '../components/common/ContextMenu';

interface InputContextMenuState {
  x: number;
  y: number;
  selectionStart: number;
  selectionEnd: number;
}

interface UseInputContextMenuOptions {
  value: string;
  onChange: (value: string) => void;
  onGo?: (value: string) => void;
  label?: string;
}

export function useInputContextMenu({ value, onChange, onGo, label = '输入框选项' }: UseInputContextMenuOptions) {
  const [menu, setMenu] = useState<InputContextMenuState | null>(null);
  const activeInput = useRef<HTMLInputElement | null>(null);

  const writeClipboard = async (text: string) => {
    if (window.lumaDesktop) await window.lumaDesktop.writeClipboard(text);
    else await navigator.clipboard.writeText(text);
  };

  const readClipboard = async () => {
    if (window.lumaDesktop) return window.lumaDesktop.readClipboard();
    return navigator.clipboard.readText();
  };

  const handleContextMenu = useCallback((event: MouseEvent<HTMLInputElement>) => {
    event.preventDefault();
    const input = event.currentTarget;
    activeInput.current = input;
    input.focus({ preventScroll: true });
    setMenu({
      x: event.clientX,
      y: event.clientY,
      selectionStart: input.selectionStart ?? input.value.length,
      selectionEnd: input.selectionEnd ?? input.value.length,
    });
  }, []);

  const replaceSelection = (text: string, andGo = false) => {
    const input = activeInput.current;
    const currentValue = input?.value ?? value;
    const start = Math.min(input?.selectionStart ?? menu?.selectionStart ?? currentValue.length, currentValue.length);
    const end = Math.min(input?.selectionEnd ?? menu?.selectionEnd ?? currentValue.length, currentValue.length);
    const nextValue = `${currentValue.slice(0, start)}${text}${currentValue.slice(end)}`;
    onChange(nextValue);
    const cursor = start + text.length;
    window.requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(cursor, cursor);
    });
    if (andGo) onGo?.(nextValue);
  };

  const selectedText = menu
    ? value.slice(Math.min(menu.selectionStart, menu.selectionEnd), Math.max(menu.selectionStart, menu.selectionEnd))
    : '';
  const hasSelection = menu ? menu.selectionStart !== menu.selectionEnd : false;

  const items: ContextMenuEntry[] = menu ? [
    {
      id: 'input-cut',
      label: '剪切',
      icon: <Scissors />,
      shortcut: 'Ctrl+X',
      disabled: !hasSelection,
      onSelect: () => {
        void writeClipboard(selectedText);
        replaceSelection('');
      },
    },
    {
      id: 'input-copy',
      label: '复制',
      icon: <Copy />,
      shortcut: 'Ctrl+C',
      disabled: !hasSelection,
      onSelect: () => void writeClipboard(selectedText),
    },
    {
      id: 'input-paste',
      label: '粘贴',
      icon: <ClipboardPaste />,
      shortcut: 'Ctrl+V',
      onSelect: () => {
        void readClipboard().then((text) => replaceSelection(text));
      },
    },
    { id: 'input-separator', separator: true },
    {
      id: 'input-select-all',
      label: '全选',
      icon: <MousePointer2 />,
      shortcut: 'Ctrl+A',
      onSelect: () => activeInput.current?.select(),
    },
    ...(onGo ? [{
      id: 'input-paste-go',
      label: '粘贴并前往',
      icon: <CornerDownLeft />,
      onSelect: () => {
        void readClipboard().then((text) => replaceSelection(text, true));
      },
    }] : []),
  ] : [];

  return {
    onContextMenu: handleContextMenu,
    inputContextMenu: menu ? (
      <ContextMenu x={menu.x} y={menu.y} items={items} label={label} onClose={() => setMenu(null)} />
    ) : null,
  };
}
