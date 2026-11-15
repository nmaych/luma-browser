import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface ContextMenuAction {
  id: string;
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export type ContextMenuEntry = ContextMenuAction | { id: string; separator: true };

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuEntry[];
  label?: string;
  onClose: () => void;
}

export function ContextMenu({ x, y, items, label = '操作菜单', onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x, y });

  useLayoutEffect(() => {
    const rect = menuRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition({
      x: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)),
    });
  }, [x, y, items.length]);

  useEffect(() => {
    const handleResize = () => onClose();
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('resize', handleResize);
    window.addEventListener('blur', handleResize);
    window.addEventListener('keydown', handleKeydown);
    const firstItem = menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)');
    firstItem?.focus({ preventScroll: true });
    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('blur', handleResize);
      window.removeEventListener('keydown', handleKeydown);
    };
  }, [onClose]);

  return createPortal(
    <div className="context-scrim" onMouseDown={onClose} onContextMenu={(event) => { event.preventDefault(); onClose(); }}>
      <div
        className="app-context-menu"
        ref={menuRef}
        role="menu"
        aria-label={label}
        style={{ left: position.x, top: position.y }}
        onMouseDown={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const step = event.key === 'ArrowDown' ? 1 : -1;
            buttons[(index + step + buttons.length) % buttons.length]?.focus();
          } else if (event.key === 'Home' || event.key === 'End') {
            event.preventDefault();
            buttons[event.key === 'Home' ? 0 : buttons.length - 1]?.focus();
          }
        }}
      >
        {items.map((item) =>
          'separator' in item ? (
            <div className="app-context-menu__divider" role="separator" key={item.id} />
          ) : (
            <button
              type="button"
              role="menuitem"
              className={item.danger ? 'is-danger' : ''}
              key={item.id}
              disabled={item.disabled}
              onClick={() => {
                onClose();
                item.onSelect();
              }}
            >
              <span className="app-context-menu__icon">{item.icon}</span>
              <span className="app-context-menu__label">{item.label}</span>
              {item.shortcut && <span className="app-context-menu__shortcut">{item.shortcut}</span>}
            </button>
          ),
        )}
      </div>
    </div>,
    document.body,
  );
}
