export type PageRect = {
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
  x: number;
  y: number;
};

export type PageNavigationState = { canGoBack: boolean; canGoForward: boolean };

/**
 * Everything the UI needs from a page. Two implementations exist: a wrapper
 * around an Electron <webview> guest, and a native WebContentsView handle that
 * talks to the main process. The native one is what allows a running tab to be
 * moved between windows without reloading it.
 */
export interface PageHandle {
  readonly tabId: string;
  readonly native: boolean;
  getWebContentsId(): number;
  canGoBack(): boolean;
  canGoForward(): boolean;
  getBoundingClientRect(): PageRect;
  reload(): void;
  stop(): void;
  goBack(): void;
  goForward(): void;
  loadURL(url: string): void;
  setZoomFactor(factor: number): void;
  insertCSS(css: string): Promise<string>;
  removeInsertedCSS(key: string): Promise<void>;
  executeJavaScript<T = unknown>(code: string, userGesture?: boolean): Promise<T>;
  findInPage(text: string, options?: { forward?: boolean; findNext?: boolean }): void;
  stopFindInPage(action?: 'clearSelection' | 'keepSelection' | 'activateSelection'): void;
  setAudioMuted(muted: boolean): void;
  copy(): void;
  cut(): void;
  paste(): void;
  selectAll(): void;
  /** Returns a PNG data URL of the current frame, or null when unavailable. */
  capturePage(): Promise<string | null>;
}

export function emptyRect(): PageRect {
  return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0 };
}


type PageViewBridge = NonNullable<Window['lumaDesktop']>['pageView'];

/** Splits the app into tabs backed by native WebContentsViews in the main process. */
export class NativePageHandle implements PageHandle {
  readonly native = true;
  private info: LumaPageViewInfo | null = null;
  private rect: PageRect = emptyRect();
  private cssKeys: string[] = [];

  constructor(readonly tabId: string, private readonly incognito: boolean) {}

  private bridge(): PageViewBridge | undefined {
    return window.lumaDesktop?.pageView;
  }

  applyInfo(info: LumaPageViewInfo | null) {
    if (!info) return;
    this.info = info;
  }

  setRect(rect: PageRect) {
    this.rect = rect;
  }

  getWebContentsId(): number {
    return this.info?.webContentsId ?? -1;
  }

  canGoBack(): boolean {
    return Boolean(this.info?.canGoBack);
  }

  canGoForward(): boolean {
    return Boolean(this.info?.canGoForward);
  }

  getBoundingClientRect(): PageRect {
    return this.rect;
  }

  navigation(): PageNavigationState {
    return { canGoBack: this.canGoBack(), canGoForward: this.canGoForward() };
  }

  private command<T = unknown>(name: string, args: unknown[] = []): Promise<T | null> {
    const bridge = this.bridge();
    if (!bridge) return Promise.resolve(null);
    return bridge.command(this.tabId, name, args, this.incognito).catch(() => null) as Promise<T | null>;
  }

  reload() {
    void this.command('reload');
  }

  stop() {
    void this.command('stop');
  }

  goBack() {
    void this.command('goBack');
  }

  goForward() {
    void this.command('goForward');
  }

  loadURL(url: string) {
    void this.command('load', [url]);
  }

  setZoomFactor(factor: number) {
    void this.command('setZoomFactor', [factor]);
  }

  async insertCSS(css: string): Promise<string> {
    const key = await this.command<string>('insertCSS', [css]);
    if (typeof key !== 'string') return '';
    this.cssKeys.push(key);
    return key;
  }

  async removeInsertedCSS(key: string): Promise<void> {
    this.cssKeys = this.cssKeys.filter((item) => item !== key);
    await this.command('removeInsertedCSS', [key]);
  }

  async executeJavaScript<T = unknown>(code: string, userGesture = false): Promise<T> {
    const result = await this.command<T>('executeJavaScript', [code, userGesture]);
    return result as T;
  }

  findInPage(text: string, options?: { forward?: boolean; findNext?: boolean }) {
    void this.command('findInPage', [text, options ?? {}]);
  }

  stopFindInPage(action: 'clearSelection' | 'keepSelection' | 'activateSelection' = 'clearSelection') {
    void this.command('stopFindInPage', [action]);
  }

  setAudioMuted(muted: boolean) {
    void this.command('setAudioMuted', [muted]);
  }

  copy() {
    void this.command('edit', ['copy']);
  }

  cut() {
    void this.command('edit', ['cut']);
  }

  paste() {
    void this.command('edit', ['paste']);
  }

  selectAll() {
    void this.command('edit', ['selectAll']);
  }

  async capturePage(): Promise<string | null> {
    const data = await this.command<string>('capturePage');
    return typeof data === 'string' ? data : null;
  }

  /** Removes every stylesheet this handle injected, e.g. before the page is reused. */
  clearStyles() {
    for (const key of this.cssKeys) void this.command('removeInsertedCSS', [key]);
    this.cssKeys = [];
  }
}
