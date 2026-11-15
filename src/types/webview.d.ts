interface LumaWebviewElement extends HTMLElement {
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  stop: () => void;
  loadURL: (url: string) => Promise<void>;
  getURL: () => string;
  getWebContentsId: () => number;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  isLoading: () => boolean;
  capturePage: () => Promise<LumaNativeImage>;
  findInPage: (text: string, options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean }) => number;
  stopFindInPage: (action: 'clearSelection' | 'keepSelection' | 'activateSelection') => void;
  executeJavaScript: <T = unknown>(code: string, userGesture?: boolean) => Promise<T>;
  insertCSS: (css: string) => Promise<string>;
  removeInsertedCSS: (key: string) => Promise<void>;
  setZoomFactor: (factor: number) => void;
  getZoomFactor: () => number;
  setAudioMuted: (muted: boolean) => void;
  isAudioMuted: () => boolean;
  isCurrentlyAudible: () => boolean;
  copy: () => void;
  cut: () => void;
  paste: () => void;
  selectAll: () => void;
}

interface LumaNativeImage {
  toDataURL: () => string;
  isEmpty: () => boolean;
}

interface LumaWebviewFaviconEvent extends Event {
  favicons: string[];
}

interface LumaWebviewNavigationEvent extends Event {
  url: string;
  isMainFrame?: boolean;
  isSameDocument?: boolean;
  title?: string;
}

interface LumaWebviewFailEvent extends Event {
  errorCode: number;
  errorDescription: string;
  validatedURL: string;
  isMainFrame: boolean;
}

interface LumaWebviewTitleEvent extends Event {
  title: string;
}

interface LumaWebviewFoundInPageEvent extends Event {
  result: {
    activeMatchOrdinal: number;
    matches: number;
    finalUpdate: boolean;
  };
}
