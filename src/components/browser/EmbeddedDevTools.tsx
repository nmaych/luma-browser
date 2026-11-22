import { useCallback, useEffect, useRef, useState } from 'react';
import { Code2, X } from 'lucide-react';
import { IconButton } from '../common/IconButton';
import { readStorage, writeStorage } from '../../utils/storage';

const WIDTH_KEY = 'luma.devtools.width.v1';
const MIN_WIDTH = 320;
const MAX_WIDTH = 980;
/**
 * Width of the strip left of the panel where the resize handle lives. The
 * native page surface has to stop short of it, or the handle would be covered
 * by the page view and could never be grabbed (see `.devtools-panel__resize`).
 */
export const DEVTOOLS_RESIZE_GUTTER = 6;

function clampWidth(value: number): number {
  const maxForWindow = Math.max(280, Math.min(MAX_WIDTH, window.innerWidth - 300));
  return Math.round(Math.min(Math.max(value, MIN_WIDTH), maxForWindow));
}

/** Only the contents id is needed; both page backends provide it. */
export interface DevToolsTarget {
  getWebContentsId(): number;
}

interface EmbeddedDevToolsProps {
  target: DevToolsTarget;
  visible: boolean;
  onClose: () => void;
  openDevTools: (targetId: number, bounds: LumaDevtoolsBounds) => Promise<boolean>;
  resizeDevTools: (targetId: number, bounds: LumaDevtoolsBounds) => Promise<boolean>;
  setDevToolsVisible: (targetId: number, visible: boolean) => Promise<boolean>;
  closeDevTools: (targetId: number) => Promise<boolean>;
  /** Lets the page surface make room for the docked panel. */
  onWidthChange?: (width: number) => void;
}

export function EmbeddedDevTools({
  target,
  visible,
  onClose,
  openDevTools,
  resizeDevTools,
  setDevToolsVisible,
  closeDevTools,
  onWidthChange,
}: EmbeddedDevToolsProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const targetIdRef = useRef<number | null>(null);
  const [width, setWidth] = useState(() => clampWidth(readStorage<number>(WIDTH_KEY, 560)));
  const [attached, setAttached] = useState(false);
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    onWidthChange?.(width);
  }, [onWidthChange, width]);

  const sendBounds = useCallback(() => {
    const body = bodyRef.current;
    const targetId = targetIdRef.current;
    if (!body || targetId === null) return;
    const rect = body.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    void resizeDevTools(targetId, {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
  }, [resizeDevTools]);

  const boundsOf = (body: HTMLElement): LumaDevtoolsBounds => {
    const rect = body.getBoundingClientRect();
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  };

  useEffect(() => {
    const body = bodyRef.current;
    let disposed = false;
    let attachedId: number | null = null;
    let retry = 0;
    const attach = () => {
      if (disposed || attachedId !== null || !bodyRef.current) return;
      let targetId: number;
      try {
        targetId = target.getWebContentsId();
      } catch {
        targetId = -1;
      }
      if (!Number.isInteger(targetId) || targetId <= 0) {
        // The page is still being created; try again shortly.
        retry = window.setTimeout(attach, 200);
        return;
      }
      const bounds = boundsOf(bodyRef.current);
      if (bounds.width < 1 || bounds.height < 1) return;
      attachedId = targetId;
      targetIdRef.current = targetId;
      void openDevTools(targetId, bounds).then((opened) => {
        if (disposed) {
          if (opened) void closeDevTools(targetId);
          return;
        }
        if (opened) {
          setAttached(true);
          requestAnimationFrame(sendBounds);
        } else {
          attachedId = null;
          targetIdRef.current = null;
        }
      });
    };
    const timer = window.setTimeout(attach, 120);
    const observer = typeof ResizeObserver === 'undefined' || !body
      ? null
      : new ResizeObserver(() => sendBounds());
    if (body && observer) observer.observe(body);
    window.addEventListener('resize', sendBounds);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      window.clearTimeout(retry);
      observer?.disconnect();
      window.removeEventListener('resize', sendBounds);
      setAttached(false);
      const targetId = attachedId;
      if (targetId !== null) void closeDevTools(targetId);
    };
  }, [closeDevTools, openDevTools, sendBounds, target]);

  useEffect(() => {
    const targetId = targetIdRef.current;
    if (!attached || targetId === null) return;
    void setDevToolsVisible(targetId, visible);
  }, [attached, setDevToolsVisible, visible]);

  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.focus();
    const startX = event.clientX;
    const startWidth = width;
    const move = (moveEvent: PointerEvent) => {
      setWidth(clampWidth(startWidth + startX - moveEvent.clientX));
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      document.body.classList.remove('is-resizing-devtools');
      setResizing(false);
      setWidth((current) => {
        writeStorage(WIDTH_KEY, current);
        return current;
      });
    };
    document.body.classList.add('is-resizing-devtools');
    setResizing(true);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  };

  return (
    <aside className="devtools-panel" aria-label="开发者工具" style={{ flexBasis: width, width }}>
      <div
        className="devtools-panel__resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整开发者工具宽度"
        tabIndex={0}
        onPointerDown={beginResize}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          const delta = event.key === 'ArrowLeft' ? 24 : -24;
          setWidth((current) => {
            const next = clampWidth(current + delta);
            writeStorage(WIDTH_KEY, next);
            return next;
          });
        }}
      />
      <header className="devtools-panel__header">
        <span><Code2 size={14} /> 开发者工具</span>
        <IconButton size="small" label="关闭开发者工具" onClick={onClose}><X size={15} /></IconButton>
      </header>
      <div className="devtools-panel__body" ref={bodyRef} />
      {resizing && <div className="devtools-resize-shield" aria-hidden="true" />}
    </aside>
  );
}
