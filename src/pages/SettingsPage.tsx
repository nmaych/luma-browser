import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  AlertTriangle,
  Bell,
  Bookmark,
  Camera,
  Check,
  Clipboard,
  Clock3,
  CloudOff,
  Compass,
  Cookie,
  Database,
  Download,
  Eye,
  EyeOff,
  FolderOpen,
  PackageOpen,
  Globe2,
  HardDrive,
  Home,
  Keyboard,
  KeyRound,
  Laptop,
  LockKeyhole,
  MapPin,
  Mic,
  Monitor,
  Moon,
  MousePointer2,
  Palette,
  PanelsTopLeft,
  Plus,
  Power,
  Puzzle,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  SquareArrowOutUpRight,
  Sun,
  Timer,
  Trash2,
  Type,
} from 'lucide-react';
import { SHORTCUT_GROUPS, SHORTCUT_ACTION_LABELS, DEFAULT_SHORTCUTS, type ShortcutAction } from '../data/shortcuts';
import { acceleratorFromEvent, findShortcutConflict, formatAccelerator } from '../utils/shortcuts';
import { getAllSearchEngines, validateSearchEngineTemplate } from '../data/searchEngines';
import type {
  AddressBarButton,
  HistoryItem,
  PermissionCategory,
  PermissionOverview,
  PermissionPolicy,
  PermissionSite,
  Preferences,
  SiteDataOverview,
  ThemePreference,
} from '../types';
import { formatHistoryDate, formatTime } from '../utils/date';
import { INTERNAL_ROUTES, displayUrl, getHost, parseBrowserInput } from '../utils/url';
import { Logo } from '../components/common/Logo';
import { SearchEngineMark } from '../components/common/SearchEngineMark';
import { Modal } from '../components/common/Modal';

/**
 * Remembers the section and scroll offset of the settings page. Internal pages
 * unmount when another tab becomes active, so without this the page snapped
 * back to 通用 / top on every return.
 */
let settingsMemory: { section: SettingsSection; scrollTop: number } | null = null;

type SettingsSection = 'general' | 'tabs' | 'search' | 'shortcuts' | 'adblock' | 'extensions' | 'passwords' | 'permissions' | 'privacy' | 'about';

interface SettingsPageProps {
  preferences: Preferences;
  history: HistoryItem[];
  historyCount: number;
  bookmarkCount: number;
  folderCount: number;
  tabCount: number;
  onUpdate: (patch: Partial<Preferences>) => void;
  onReset: () => void;
  onAddSearchEngine: (name: string, urlTemplate: string) => boolean;
  onRemoveSearchEngine: (id: string) => void;
  onClearSiteData: () => Promise<boolean>;
  onGetSiteData: () => Promise<SiteDataOverview | null>;
  onClearSiteDataForDomain: (domain: string) => Promise<boolean>;
  onClearCache: () => Promise<boolean>;
  onSleepBackgroundTabs: () => void;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

const themes: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon },
  { value: 'system', label: '跟随系统', icon: Laptop },
];

const WEB_FONT_SIZES = [12, 14, 16, 18, 20, 22, 24];

const WEB_FONT_FAMILIES = [
  { value: '', label: '跟随网页（默认）' },
  { value: '"Microsoft YaHei", "PingFang SC", sans-serif', label: '微软雅黑 / 苹方' },
  { value: '"SimSun", "Songti SC", serif', label: '宋体' },
  { value: '"KaiTi", "Kaiti SC", serif', label: '楷体' },
  { value: '"Segoe UI", Arial, sans-serif', label: 'Segoe UI' },
  { value: 'Arial, Helvetica, sans-serif', label: 'Arial' },
];

const sections: { id: SettingsSection; label: string; icon: typeof SlidersHorizontal }[] = [
  { id: 'general', label: '通用', icon: SlidersHorizontal },
  { id: 'tabs', label: '标签页与地址栏', icon: PanelsTopLeft },
  { id: 'search', label: '搜索引擎', icon: Search },
  { id: 'shortcuts', label: '快捷键', icon: Keyboard },
  { id: 'adblock', label: '广告与跟踪拦截', icon: ShieldCheck },
  { id: 'extensions', label: '扩展', icon: Puzzle },
  { id: 'passwords', label: '密码与自动填充', icon: KeyRound },
  { id: 'permissions', label: '权限管理', icon: LockKeyhole },
  { id: 'privacy', label: '隐私与安全', icon: ShieldCheck },
  { id: 'about', label: '数据与关于', icon: Database },
];

const SECTION_GROUPS: { label: string; ids: SettingsSection[] }[] = [
  { label: '基础', ids: ['general', 'tabs', 'search'] },
  { label: '浏览工具', ids: ['shortcuts', 'adblock', 'extensions', 'passwords'] },
  { label: '安全与数据', ids: ['permissions', 'privacy', 'about'] },
];

const sectionMeta: Record<SettingsSection, { title: string; description: string }> = {
  general: { title: '通用设置', description: '调整 Luma 的外观和日常浏览体验。' },
  tabs: { title: '标签页与地址栏', description: '自定义标签页的关闭、预览、内存节省和切换方式。' },
  search: { title: '搜索引擎', description: '管理默认搜索引擎，或添加自己的搜索服务。' },
  shortcuts: { title: '键盘快捷键', description: '为常用操作录制自己的按键组合，并设置一键隐藏窗口的老板键。' },
  adblock: { title: '广告与跟踪拦截', description: '内置离线拦截规则，可按网站单独暂停或恢复。' },
  extensions: { title: '扩展', description: '加载已解压的 Chrome 扩展（MV2 / MV3），或管理已安装的扩展。' },
  passwords: { title: '密码与自动填充', description: '登录信息使用系统安全存储加密保存在本机。' },
  permissions: { title: '权限管理', description: '决定网站可以访问哪些设备、位置和系统能力。' },
  privacy: { title: '隐私与安全', description: '了解数据和网站权限如何被保护。' },
  about: { title: '数据与关于', description: '查看本地存储、应用版本并管理浏览数据。' },
};

const PERMISSION_CATEGORIES: {
  id: PermissionCategory;
  label: string;
  description: string;
  icon: typeof Camera;
}[] = [
  { id: 'camera', label: '摄像头', description: '视频通话、扫码或拍照。', icon: Camera },
  { id: 'microphone', label: '麦克风', description: '语音通话、录音或语音输入。', icon: Mic },
  { id: 'notifications', label: '通知', description: '通过系统通知推送网站消息。', icon: Bell },
  { id: 'geolocation', label: '位置信息', description: '获取大致或精确的地理位置。', icon: MapPin },
  { id: 'clipboard', label: '剪贴板读取', description: '读取你复制到剪贴板的文字或内容。', icon: Clipboard },
  { id: 'fullscreen', label: '全屏', description: '占满整个屏幕显示视频或演示。', icon: Monitor },
  { id: 'pointerLock', label: '指针锁定', description: '锁定鼠标指针，常见于网页游戏。', icon: MousePointer2 },
];

const PERMISSION_POLICY_LABELS: Record<PermissionPolicy, string> = {
  ask: '每次询问',
  allow: '允许',
  deny: '拒绝',
};

function permissionHost(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function updateLineLabel(state: LumaUpdateState): string {
  return state.lines.find((line) => line.id === state.line)?.label ?? '';
}

function updateStatusText(state: LumaUpdateState | null, checking: boolean): string {
  if (!state) return checking ? '正在检查更新…' : '尚未检查更新';
  if (checking && state.status === 'idle') return '正在检查更新…';
  switch (state.status) {
    case 'checking':
      return '正在检查更新…';
    case 'available':
      return `发现新版本 ${state.version}，选择线路后点击“下载更新”。`;
    case 'downloading': {
      const via = updateLineLabel(state);
      const progress = state.total > 0 ? ` ${state.percent}%` : '';
      return via ? `正在通过${via}下载新版本${progress}` : `正在下载新版本${progress}`;
    }
    case 'downloaded': {
      const mode = state.prefs?.applyOnQuit === false
        ? '点击“重启并安装”立即完成安装。'
        : '关闭浏览器时会自动静默安装，下次启动即为新版本。';
      return `新版本 ${state.version} 已下载，${mode}`;
    }
    case 'not-available':
      return '当前已是最新版本。';
    case 'error':
      return state.error ? `更新失败：${state.error}` : '更新失败。';
    default:
      return '尚未检查更新';
  }
}

function PanelHeading({ icon, title, description }: { icon: ReactNode; title: string; description: string }) {
  return (
    <header className="settings-panel__heading">
      <span>{icon}</span>
      <div><h2>{title}</h2><p>{description}</p></div>
    </header>
  );
}

/** Every button the address bar can show, in display order. */
const ADDRESS_BAR_BUTTONS: { key: AddressBarButton; label: string; hint: string }[] = [
  { key: 'reader', label: '阅读模式', hint: '把文章从版式中抽出来阅读。' },
  { key: 'translate', label: '网页翻译', hint: '选择目标语言并翻译当前页面。' },
  { key: 'screenshot', label: '网页截图', hint: '保存可见区域、整页或框选区域。' },
  { key: 'adblock', label: '广告拦截', hint: '查看本页拦截数量并可临时关闭。' },
  { key: 'passwords', label: '密码填充', hint: '填入本网站已保存的登录信息，仅在有条目时出现。' },
  { key: 'bookmarks', label: '书签', hint: '打开书签管理器。' },
  { key: 'history', label: '历史记录', hint: '打开历史记录页面。' },
  { key: 'downloads', label: '下载内容', hint: '打开下载管理器并显示进行中数量。' },
  { key: 'extensions', label: '扩展图标', hint: '显示已启用扩展的工具栏图标。' },
  { key: 'settings', label: '设置', hint: '打开当前设置页面。' },
];

export function SettingsPage({
  preferences,
  history,
  historyCount,
  bookmarkCount,
  folderCount,
  tabCount,
  onUpdate,
  onReset,
  onAddSearchEngine,
  onRemoveSearchEngine,
  onClearSiteData,
  onGetSiteData,
  onClearSiteDataForDomain,
  onClearCache,
  onSleepBackgroundTabs,
}: SettingsPageProps) {
  const [activeSection, setActiveSection] = useState<SettingsSection>(() => settingsMemory?.section ?? 'general');
  const [sectionQuery, setSectionQuery] = useState('');
  const settingsScrollRef = useRef<HTMLDivElement | null>(null);
  // Restore once the remembered section has painted. Sections load data
  // asynchronously, so the height grows after mount and the offset is retried
  // until it sticks (or a short budget runs out).
  useEffect(() => {
    const container = settingsScrollRef.current;
    if (!container || !settingsMemory) return undefined;
    const target = settingsMemory.scrollTop;
    if (target <= 0) return undefined;
    let attempts = 0;
    let timer = 0;
    const restore = () => {
      if (!settingsScrollRef.current) return;
      container.scrollTop = target;
      attempts += 1;
      if (Math.abs(container.scrollTop - target) > 8 && attempts < 25) {
        timer = window.setTimeout(restore, 60);
      }
    };
    restore();
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const container = settingsScrollRef.current;
    if (!container) return undefined;
    const remember = () => {
      settingsMemory = { section: activeSection, scrollTop: container.scrollTop };
    };
    container.addEventListener('scroll', remember, { passive: true });
    remember();
    // Only detach: at unmount the element is already detached and reads 0,
    // which would erase the offset the user just left.
    return () => container.removeEventListener('scroll', remember);
  }, [activeSection]);

  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmClearData, setConfirmClearData] = useState(false);
  const [clearingData, setClearingData] = useState(false);
  const [engineDialogOpen, setEngineDialogOpen] = useState(false);
  const [engineName, setEngineName] = useState('');
  const [engineUrl, setEngineUrl] = useState('');
  const [engineError, setEngineError] = useState('');
  const [siteData, setSiteData] = useState<SiteDataOverview | null>(null);
  const [siteDataLoading, setSiteDataLoading] = useState(false);
  const [clearingDomain, setClearingDomain] = useState<string | null>(null);
  const [permissionOverview, setPermissionOverview] = useState<PermissionOverview | null>(null);
  const [permissionsLoading, setPermissionsLoading] = useState(false);
  const [permissionSite, setPermissionSite] = useState<string | null>(null);
  const [confirmClearPermissions, setConfirmClearPermissions] = useState(false);
  const [homeInput, setHomeInput] = useState(preferences.homePage === INTERNAL_ROUTES.home ? '' : displayUrl(preferences.homePage));
  const [homeError, setHomeError] = useState('');
  const desktop = window.lumaDesktop;
  const [downloadDirectory, setDownloadDirectory] = useState<LumaDownloadDirectoryInfo | null>(null);
  const [changingDirectory, setChangingDirectory] = useState(false);
  const [recording, setRecording] = useState<ShortcutAction | 'bossKey' | null>(null);
  const [shortcutError, setShortcutError] = useState('');
  const [bossKeyError, setBossKeyError] = useState('');
  const [adblockState, setAdblockState] = useState<LumaAdblockState | null>(null);
  const [passwordStatus, setPasswordStatus] = useState<LumaPasswordStatus | null>(null);
  const [savedPasswords, setSavedPasswords] = useState<LumaPasswordMeta[]>([]);
  const [revealedPassword, setRevealedPassword] = useState<LumaPasswordEntry | null>(null);
  const [passwordError, setPasswordError] = useState('');
  const [confirmClearPasswords, setConfirmClearPasswords] = useState(false);
  const [appVersions, setAppVersions] = useState<LumaAppVersions | null>(null);
  const [updateState, setUpdateState] = useState<LumaUpdateState | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateLine, setUpdateLine] = useState('github');
  const [appPaths, setAppPaths] = useState<LumaAppPaths | null>(null);
  const [extensions, setExtensions] = useState<LumaExtension[]>([]);
  const [extensionBusy, setExtensionBusy] = useState<string | null>(null);
  const [extensionError, setExtensionError] = useState('');
  const [userscripts, setUserscripts] = useState<LumaUserscript[]>([]);
  const [userscriptBusy, setUserscriptBusy] = useState<string | null>(null);
  const [userscriptError, setUserscriptError] = useState('');
  const [defaultBrowser, setDefaultBrowser] = useState<LumaDefaultBrowserStatus | null>(null);
  const [defaultBrowserBusy, setDefaultBrowserBusy] = useState(false);
  const [defaultBrowserMessage, setDefaultBrowserMessage] = useState('');
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const engines = getAllSearchEngines(preferences.customSearchEngines);
  const currentEngine = engines.find((engine) => engine.id === preferences.searchEngine) ?? engines[0];
  const builtInHome = preferences.homePage === INTERNAL_ROUTES.home;

  useEffect(() => {
    setHomeInput(preferences.homePage === INTERNAL_ROUTES.home ? '' : displayUrl(preferences.homePage));
    setHomeError('');
  }, [preferences.homePage]);

  useEffect(() => {
    if (!desktop || downloadDirectory) return undefined;
    let active = true;
    void desktop.getDownloadDirectory()
      .then((info) => {
        if (active) setDownloadDirectory(info);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [desktop, downloadDirectory]);

  const changeDownloadDirectory = async () => {
    if (!desktop) return;
    setChangingDirectory(true);
    try {
      setDownloadDirectory(await desktop.chooseDownloadDirectory());
    } finally {
      setChangingDirectory(false);
    }
  };

  const restoreDownloadDirectory = async () => {
    if (!desktop) return;
    setChangingDirectory(true);
    try {
      setDownloadDirectory(await desktop.resetDownloadDirectory());
    } finally {
      setChangingDirectory(false);
    }
  };

  const refreshSiteData = async () => {
    setSiteDataLoading(true);
    const data = await onGetSiteData();
    if (data) setSiteData(data);
    setSiteDataLoading(false);
  };

  useEffect(() => {
    if (activeSection === 'privacy' && !siteData) void refreshSiteData();
  }, [activeSection]);

  const refreshPermissions = async () => {
    if (!desktop) return;
    setPermissionsLoading(true);
    try {
      setPermissionOverview(await desktop.getPermissions());
    } finally {
      setPermissionsLoading(false);
    }
  };

  useEffect(() => {
    if (activeSection === 'permissions' && !permissionOverview) void refreshPermissions();
  }, [activeSection]);

  const changeDefaultPermission = async (category: PermissionCategory, policy: PermissionPolicy) => {
    if (!desktop) return;
    const next = await desktop.setPermissionDefault(category, policy);
    if (next) setPermissionOverview(next);
  };

  const changeSitePermission = async (origin: string, category: PermissionCategory, policy: PermissionPolicy | null) => {
    if (!desktop) return;
    const next = await desktop.setSitePermission(origin, category, policy);
    if (next) setPermissionOverview(next);
  };

  const removeSitePermission = async (origin: string) => {
    if (!desktop) return;
    const next = await desktop.removeSitePermission(origin);
    if (next) setPermissionOverview(next);
    setPermissionSite(null);
  };

  const clearAllPermissions = async () => {
    if (!desktop) return;
    setPermissionOverview(await desktop.clearSitePermissions());
    setConfirmClearPermissions(false);
  };

  const refreshAdblock = async () => {
    if (!desktop) return;
    try {
      setAdblockState(await desktop.getAdblockState());
    } catch {
      setAdblockState(null);
    }
  };

  const refreshPasswords = async () => {
    if (!desktop) return;
    try {
      setPasswordStatus(await desktop.getPasswordStatus());
      setSavedPasswords(await desktop.listPasswords());
    } catch {
      setPasswordStatus(null);
      setSavedPasswords([]);
    }
  };

  useEffect(() => {
    if (activeSection !== 'adblock') return undefined;
    void refreshAdblock();
    const timer = window.setInterval(() => void refreshAdblock(), 2500);
    return () => window.clearInterval(timer);
  }, [activeSection]);

  useEffect(() => {
    if (activeSection === 'passwords') void refreshPasswords();
    else setRevealedPassword(null);
  }, [activeSection]);

  useEffect(() => {
    if (!desktop?.getAppVersions) return undefined;
    let active = true;
    void desktop.getAppVersions().then((value) => {
      if (active) setAppVersions(value);
    }).catch(() => undefined);
    return () => {
      active = false;
    };
  }, [desktop]);

  useEffect(() => {
    if (!desktop?.getAppPaths) return undefined;
    let active = true;
    void desktop.getAppPaths().then((value) => {
      if (active && value) setAppPaths(value);
    }).catch(() => undefined);
    return () => {
      active = false;
    };
  }, [desktop]);

  const refreshExtensions = async () => {
    if (!desktop?.listExtensions) return;
    try {
      setExtensions(await desktop.listExtensions());
    } catch {
      // The list is re-fetched whenever the section is opened.
    }
  };

  useEffect(() => {
    if (activeSection !== 'extensions') return;
    void refreshExtensions();
    void (async () => {
      if (!desktop?.listUserscripts) return;
      try {
        setUserscripts(await desktop.listUserscripts());
      } catch {
        // The list is re-fetched whenever the section is opened.
      }
    })();
  }, [activeSection]);

  const installUserscript = async () => {
    if (!desktop?.installUserscript) return;
    setUserscriptBusy('install');
    setUserscriptError('');
    try {
      const result = await desktop.installUserscript();
      if (result?.list) setUserscripts(result.list);
      if (!result?.ok && !result?.cancelled) setUserscriptError(result?.error ?? '安装脚本失败');
    } catch (error) {
      setUserscriptError(error instanceof Error ? error.message : '安装脚本失败');
    } finally {
      setUserscriptBusy(null);
    }
  };

  const toggleUserscript = async (script: LumaUserscript, enabled: boolean) => {
    if (!desktop?.setUserscriptEnabled) return;
    setUserscriptError('');
    setUserscripts((current) => current.map((item) => (item.id === script.id ? { ...item, enabled } : item)));
    try {
      const result = await desktop.setUserscriptEnabled(script.id, enabled);
      if (result?.list) setUserscripts(result.list);
      if (!result?.ok) setUserscriptError(result?.error ?? '切换脚本状态失败');
    } catch {
      setUserscriptError('切换脚本状态失败');
    }
  };

  const removeUserscript = async (script: LumaUserscript) => {
    if (!desktop?.removeUserscript) return;
    if (userscriptBusy !== `remove:${script.id}`) {
      setUserscriptBusy(`remove:${script.id}`);
      return;
    }
    setUserscriptBusy(script.id);
    setUserscriptError('');
    try {
      const result = await desktop.removeUserscript(script.id);
      if (result?.list) setUserscripts(result.list);
      if (!result?.ok) setUserscriptError(result?.error ?? '移除脚本失败');
    } finally {
      setUserscriptBusy(null);
    }
  };

  // Windows only lets an app register itself; the user still confirms in
  // Settings, so the card links there and reports the real association state.
  useEffect(() => {
    if (!desktop?.getDefaultBrowserStatus) return undefined;
    let active = true;
    void desktop.getDefaultBrowserStatus().then((status) => {
      if (active) setDefaultBrowser(status);
    }).catch(() => undefined);
    return () => {
      active = false;
    };
  }, [desktop]);

  const makeDefaultBrowser = async () => {
    if (!desktop?.registerAsDefaultBrowser) return;
    setDefaultBrowserBusy(true);
    setDefaultBrowserMessage('');
    try {
      const result = await desktop.registerAsDefaultBrowser();
      if (result?.status) setDefaultBrowser(result.status);
      if (!result?.ok) setDefaultBrowserMessage(result?.error ?? '设置默认浏览器失败');
      else if (result.openedSettings) setDefaultBrowserMessage('已在系统设置中打开「默认应用」，请选择 Luma Browser 确认。');
      else setDefaultBrowserMessage('已注册为默认浏览器候选，请在系统设置中确认。');
    } catch {
      setDefaultBrowserMessage('设置默认浏览器失败');
    } finally {
      setDefaultBrowserBusy(false);
    }
  };

  const installExtension = async () => {
    if (!desktop?.installExtension) return;
    setExtensionBusy('install');
    setExtensionError('');
    try {
      const result = await desktop.installExtension();
      if (result?.list) setExtensions(result.list);
      if (!result?.ok && !result?.cancelled) setExtensionError(result?.error ?? '加载扩展失败');
    } catch (error) {
      setExtensionError(error instanceof Error ? error.message : '加载扩展失败');
    } finally {
      setExtensionBusy(null);
    }
  };

  const installCrx = async () => {
    if (!desktop?.installExtensionFromCrx) return;
    setExtensionBusy('crx');
    setExtensionError('');
    try {
      const result = await desktop.installExtensionFromCrx();
      if (result?.list) setExtensions(result.list);
      if (!result?.ok && !result?.cancelled) setExtensionError(result?.error ?? '安装扩展失败');
    } catch (error) {
      setExtensionError(error instanceof Error ? error.message : '安装扩展失败');
    } finally {
      setExtensionBusy(null);
    }
  };

  const toggleExtension = async (extension: LumaExtension, enabled: boolean) => {
    if (!desktop?.setExtensionEnabled) return;
    setExtensionError('');
    // Optimistic: the switch should react immediately even though loading is async.
    setExtensions((current) => current.map((item) => (item.id === extension.id ? { ...item, enabled } : item)));
    try {
      const result = await desktop.setExtensionEnabled(extension.id, enabled);
      if (result?.list) setExtensions(result.list);
      if (!result?.ok) setExtensionError(result?.error ?? '切换扩展状态失败');
    } catch {
      setExtensionError('切换扩展状态失败');
    }
  };

  const reloadExtension = async (extension: LumaExtension) => {
    if (!desktop?.reloadExtension) return;
    setExtensionBusy(extension.id);
    setExtensionError('');
    try {
      const result = await desktop.reloadExtension(extension.id);
      if (result?.list) setExtensions(result.list);
      if (!result?.ok) setExtensionError(result?.error ?? '重新加载失败');
    } finally {
      setExtensionBusy(null);
    }
  };

  const removeExtension = async (extension: LumaExtension) => {
    if (!desktop?.removeExtension) return;
    // Removing unloads code the user installed; ask once, inline.
    if (confirmRemoveId !== extension.id) {
      setConfirmRemoveId(extension.id);
      return;
    }
    setConfirmRemoveId(null);
    setExtensionBusy(extension.id);
    setExtensionError('');
    try {
      const result = await desktop.removeExtension(extension.id);
      if (result?.list) setExtensions(result.list);
      if (!result?.ok) setExtensionError(result?.error ?? '移除扩展失败');
    } finally {
      setExtensionBusy(null);
    }
  };

  useEffect(() => {
    if (!desktop?.getUpdateState) return undefined;
    let active = true;
    void desktop.getUpdateState().then((value) => {
      if (active && value) setUpdateState(value);
    }).catch(() => undefined);
    const unsubscribe = desktop.onUpdateState?.((value) => {
      if (!active) return;
      setUpdateState(value);
      if (value.status !== 'checking') setCheckingUpdate(false);
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [desktop]);

  const checkForUpdates = async () => {
    if (!desktop?.checkForUpdates || checkingUpdate) return;
    setCheckingUpdate(true);
    try {
      const value = await desktop.checkForUpdates();
      if (value) setUpdateState(value);
    } catch {
      setCheckingUpdate(false);
    }
  };

  const downloadUpdate = async () => {
    if (!desktop?.downloadUpdate) return;
    try {
      const value = await desktop.downloadUpdate(updateLine);
      if (value) setUpdateState(value);
    } catch {
      // The state stream reports download failures.
    }
  };

  const updatePrefs: LumaUpdatePrefs = updateState?.prefs ?? { autoDownload: true, applyOnQuit: true };

  const changeUpdatePrefs = async (patch: Partial<LumaUpdatePrefs>) => {
    if (!desktop?.setUpdatePrefs) return;
    try {
      const value = await desktop.setUpdatePrefs(patch);
      if (value) setUpdateState(value);
      else setUpdateState((current) => (current ? { ...current, prefs: { ...current.prefs, ...patch } } : current));
    } catch {
      // The state stream carries the authoritative values.
    }
  };

  useEffect(() => {
    const lines = updateState?.lines ?? [];
    if (lines.length > 0 && !lines.some((line) => line.id === updateLine)) {
      setUpdateLine(lines[0].id);
    }
  }, [updateState, updateLine]);

  useEffect(() => {
    if (!recording) return undefined;
    const handleRecord = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === 'Escape') {
        setRecording(null);
        setShortcutError('');
        setBossKeyError('');
        return;
      }
      const accelerator = acceleratorFromEvent(event);
      if (!accelerator) return;
      if (recording === 'bossKey') {
        if (!event.ctrlKey && !event.altKey && !event.metaKey) {
          setBossKeyError('老板键需要包含 Ctrl、Alt 或 Win 修饰键');
          return;
        }
        setBossKeyError('');
        setRecording(null);
        onUpdate({ bossKey: accelerator });
        if (desktop?.configureShortcuts) {
          void desktop.configureShortcuts(preferences.shortcuts, accelerator).then((result) => {
            if (!result.bossKeyRegistered) setBossKeyError('这个全局快捷键已被其他程序占用，请换一个组合');
          }).catch(() => undefined);
        }
        return;
      }
      const conflict = findShortcutConflict(preferences.shortcuts, recording, accelerator);
      if (conflict) {
        setShortcutError(`与「${SHORTCUT_ACTION_LABELS[conflict as ShortcutAction]}」冲突，请换一个组合`);
        return;
      }
      setShortcutError('');
      setRecording(null);
      onUpdate({ shortcuts: { ...preferences.shortcuts, [recording]: accelerator } });
    };
    window.addEventListener('keydown', handleRecord, true);
    return () => window.removeEventListener('keydown', handleRecord, true);
  }, [recording, onUpdate, preferences.shortcuts, desktop]);

  const resetShortcuts = () => {
    setShortcutError('');
    onUpdate({ shortcuts: { ...DEFAULT_SHORTCUTS } });
  };

  const toggleAdblockGlobal = async (enabled: boolean) => {
    if (!desktop) return;
    try {
      setAdblockState(await desktop.setAdblockEnabled(enabled));
    } catch {
      // Keep the previous state when the main process is unavailable.
    }
  };

  const restoreAdblockSite = async (host: string) => {
    if (!desktop) return;
    try {
      setAdblockState(await desktop.setAdblockSite(host, false));
    } catch {
      // Ignore a transient IPC failure.
    }
  };

  const updateAdblockRules = async () => {
    if (!desktop) return;
    setAdblockState((current) => (current ? { ...current, updating: true, error: null } : current));
    try {
      setAdblockState(await desktop.updateAdblock());
    } catch {
      setAdblockState((current) => (current ? { ...current, updating: false, error: '更新失败，请检查网络连接' } : current));
    }
  };

  const removeSavedPassword = async (id: string) => {
    if (!desktop) return;
    const result = await desktop.deletePassword(id);
    setSavedPasswords(result.entries);
    if (!result.ok) setPasswordError(result.reason === 'read-only' ? '密码库处于只读保护状态，无法删除。' : '删除失败，请稍后重试。');
    if (revealedPassword?.id === id) setRevealedPassword(null);
  };

  const clearSavedPasswords = async () => {
    if (!desktop) return;
    const result = await desktop.clearPasswords();
    setSavedPasswords(result.entries);
    if (!result.ok) setPasswordError(result.reason === 'read-only' ? '密码库处于只读保护状态，无法清除。' : '清除失败，请稍后重试。');
    setRevealedPassword(null);
    setConfirmClearPasswords(false);
  };

  const toggleRevealPassword = async (meta: LumaPasswordMeta) => {
    if (revealedPassword?.id === meta.id) {
      setRevealedPassword(null);
      return;
    }
    const entry = await desktop?.revealPassword(meta.id);
    if (entry) setRevealedPassword(entry);
  };

  const copySavedPassword = async (id: string) => {
    const entry = await desktop?.revealPassword(id);
    if (entry) await desktop?.writeClipboard(entry.password);
  };

  const editingSite: PermissionSite | undefined = permissionOverview?.sites.find(
    (site) => site.origin === permissionSite,
  );

  const siteRows = useMemo(() => {
    const rows = new Map<string, { domain: string; cookieCount: number; lastVisited?: number }>();
    siteData?.sites.forEach((site) => {
      rows.set(site.domain, { domain: site.domain, cookieCount: site.cookieCount });
    });
    history.forEach((item) => {
      if (!/^https?:\/\//i.test(item.url)) return;
      const domain = getHost(item.url).toLowerCase();
      if (!domain) return;
      const existing = rows.get(domain);
      if (existing) {
        if (!existing.lastVisited || item.visitedAt > existing.lastVisited) existing.lastVisited = item.visitedAt;
      } else {
        rows.set(domain, { domain, cookieCount: 0, lastVisited: item.visitedAt });
      }
    });
    return [...rows.values()].sort(
      (left, right) => (right.lastVisited ?? 0) - (left.lastVisited ?? 0) || right.cookieCount - left.cookieCount,
    );
  }, [history, siteData]);

  const openEngineDialog = () => {
    setEngineName('');
    setEngineUrl('');
    setEngineError('');
    setEngineDialogOpen(true);
  };

  const submitEngine = (event: FormEvent) => {
    event.preventDefault();
    const templateError = validateSearchEngineTemplate(engineUrl);
    if (!engineName.trim()) {
      setEngineError('请输入搜索引擎名称');
      return;
    }
    if (templateError) {
      setEngineError(templateError);
      return;
    }
    if (preferences.customSearchEngines.some((engine) => engine.urlTemplate.trim() === engineUrl.trim())) {
      setEngineError('这个搜索地址已经添加过了');
      return;
    }
    if (onAddSearchEngine(engineName, engineUrl)) {
      setEngineDialogOpen(false);
      setActiveSection('search');
    }
  };

  const clearSiteData = async () => {
    setClearingData(true);
    const cleared = await onClearSiteData();
    setClearingData(false);
    setConfirmClearData(false);
    if (cleared) await refreshSiteData();
  };

  const clearCache = async () => {
    const cleared = await onClearCache();
    if (cleared) await refreshSiteData();
  };

  const clearSiteForDomain = async (domain: string) => {
    setClearingDomain(domain);
    const cleared = await onClearSiteDataForDomain(domain);
    setClearingDomain(null);
    if (cleared) await refreshSiteData();
  };

  const submitHome = (event: FormEvent) => {
    event.preventDefault();
    const parsed = parseBrowserInput(homeInput, preferences.searchEngine, preferences.customSearchEngines);
    const isSearchQuery = parsed.isExternal && parsed.title === `${homeInput.trim()} - 搜索`;
    if (!parsed.ok || !parsed.url || isSearchQuery) {
      setHomeError(isSearchQuery ? '请输入完整的网址，例如 example.com' : parsed.message ?? '请输入有效的网址');
      return;
    }
    onUpdate({ homePage: parsed.url });
    setHomeError('');
  };

  const restoreHome = () => {
    onUpdate({ homePage: INTERNAL_ROUTES.home });
    setHomeInput('');
    setHomeError('');
  };

  return (
    <div className="settings-page page-scroll" ref={settingsScrollRef}>
      <main className="settings-container">
        <header className="settings-topbar">
          <div className="settings-topbar__title">
            <span><Settings2 size={21} /></span>
            <div><p>LUMA PREFERENCES</p><h1>设置</h1></div>
          </div>
          <span className="settings-saved"><i /> 所有设置会自动保存</span>
        </header>

        <div className="settings-workspace">
          <aside className="settings-sidebar">
            <div className="settings-sidebar__brand">
              <Logo size={34} withWordmark />
              <p>轻盈、安全的本机浏览器</p>
            </div>
            <nav aria-label="设置分类">
              <label className="settings-nav-search">
                <Search size={14} />
                <input
                  aria-label="查找设置"
                  value={sectionQuery}
                  onChange={(event) => setSectionQuery(event.target.value)}
                  placeholder="查找设置…"
                />
              </label>
              {SECTION_GROUPS.map((group) => {
                const keyword = sectionQuery.trim().toLowerCase();
                const visibleSections = sections.filter((section) =>
                  group.ids.includes(section.id)
                  && (!keyword || `${section.label} ${sectionMeta[section.id].title} ${sectionMeta[section.id].description}`.toLowerCase().includes(keyword)),
                );
                if (visibleSections.length === 0) return null;
                return (
                  <div className="settings-nav-group" key={group.label}>
                    <strong>{group.label}</strong>
                    {visibleSections.map((section) => {
                      const Icon = section.icon;
                      return (
                        <button
                          type="button"
                          key={section.id}
                          className={activeSection === section.id ? 'is-active' : ''}
                          aria-current={activeSection === section.id ? 'page' : undefined}
                          onClick={() => {
                            setActiveSection(section.id);
                            const container = settingsScrollRef.current;
                            if (!container) return;
                            if (typeof container.scrollTo === 'function') {
                              container.scrollTo({
                                top: 0,
                                behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
                              });
                            } else {
                              container.scrollTop = 0;
                            }
                          }}
                        >
                          <Icon size={16} />
                          <span>{section.label}</span>
                          {activeSection === section.id && <i aria-hidden="true" />}
                        </button>
                      );
                    })}
                  </div>
                );
              })}
              {sectionQuery && !sections.some((section) => `${section.label} ${sectionMeta[section.id].description}`.toLowerCase().includes(sectionQuery.trim().toLowerCase())) && (
                <p className="settings-nav-empty">没有匹配的设置分类</p>
              )}
            </nav>
            <div className="settings-sidebar__footer">
              <strong>Luma Browser</strong>
              <span>版本 {appVersions?.app ?? '1.21.8'} · Chromium {appVersions?.chrome?.split('.')[0] ?? '156'}</span>
            </div>
          </aside>

          <section className="settings-panel" aria-live="polite">
            <PanelHeading
              icon={activeSection === 'general' ? <SlidersHorizontal /> : activeSection === 'tabs' ? <PanelsTopLeft /> : activeSection === 'search' ? <Search /> : activeSection === 'shortcuts' ? <Keyboard /> : activeSection === 'permissions' ? <LockKeyhole /> : activeSection === 'privacy' ? <ShieldCheck /> : activeSection === 'extensions' ? <Puzzle /> : <Database />}
              title={sectionMeta[activeSection].title}
              description={sectionMeta[activeSection].description}
            />

            {activeSection === 'general' && (
              <div className="settings-content">
                <div className="settings-card">
                  <div className="settings-card__title"><Palette size={18} /><div><h3>外观主题</h3><p>选择最适合当前环境的配色。</p></div></div>
                  <div className="theme-options">
                    {themes.map((theme) => {
                      const Icon = theme.icon;
                      const selected = preferences.theme === theme.value;
                      return (
                        <button className={selected ? 'is-selected' : ''} type="button" key={theme.value} onClick={() => onUpdate({ theme: theme.value })} aria-pressed={selected}>
                          <span className={`theme-preview theme-preview--${theme.value}`}><i /><b /></span>
                          <span><Icon size={16} />{theme.label}</span>
                          {selected && <em><Check size={13} /></em>}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="settings-card">
                  <div className="settings-card__title"><Compass size={18} /><div><h3>默认浏览器</h3><p>让系统把网页链接交给 Luma 打开。</p></div></div>
                  <div className="setting-row">
                    <div>
                      <strong>{defaultBrowser?.isDefault ? 'Luma 已是默认浏览器' : '将 Luma 设为默认浏览器'}</strong>
                      <p>
                        {defaultBrowser?.isDefault
                          ? '在系统设置里点击其他链接时，将直接使用 Luma 打开。'
                          : defaultBrowser?.supported === false
                            ? defaultBrowser.reason || '当前系统需要在系统设置中手动选择。'
                            : '注册后 Windows 会打开「默认应用」页面，选择 Luma Browser 即可完成。'}
                      </p>
                    </div>
                    {defaultBrowser?.isDefault ? (
                      <span className="default-browser-badge"><Check size={14} />默认</span>
                    ) : (
                      <button
                        className="primary-button"
                        type="button"
                        disabled={defaultBrowserBusy || defaultBrowser?.canRegister === false}
                        title={defaultBrowser?.canRegister === false ? defaultBrowser.reason : undefined}
                        onClick={() => void makeDefaultBrowser()}
                      >
                        <Compass size={15} />{defaultBrowserBusy ? '正在注册…' : '设为默认浏览器'}
                      </button>
                    )}
                  </div>
                  {defaultBrowserMessage && <p className="setting-hint" role="status">{defaultBrowserMessage}</p>}
                  {defaultBrowser?.canRegister === false && defaultBrowser.reason && (
                    <p className="setting-hint is-muted">{defaultBrowser.reason}</p>
                  )}
                </div>

                <div className="settings-card">
                  <div className="settings-card__title"><SlidersHorizontal size={18} /><div><h3>浏览体验</h3><p>调整界面密度和动态效果。</p></div></div>
                  <div className="setting-row">
                    <div><strong>显示书签栏</strong><p>在地址栏下方显示常用书签和文件夹入口。</p></div>
                    <label className="switch"><input aria-label="显示书签栏" type="checkbox" checked={preferences.showBookmarksBar} onChange={(event) => onUpdate({ showBookmarksBar: event.target.checked })} /><span /></label>
                  </div>
                  <div className="setting-row">
                    <div><strong>减少动态效果</strong><p>关闭界面过渡和弹层动画，降低视觉干扰。</p></div>
                    <label className="switch"><input aria-label="减少动态效果" type="checkbox" checked={preferences.reduceMotion} onChange={(event) => onUpdate({ reduceMotion: event.target.checked })} /><span /></label>
                  </div>
                </div>

                <div className="settings-card">
                  <div className="settings-card__title"><Type size={18} /><div><h3>网页显示</h3><p>调整外部网页的字号、字体与缩放比例，对所有标签页生效。</p></div></div>
                  <div className="setting-row">
                    <div><strong>网页字号</strong><p>网页未指定字号时使用的基准大小。</p></div>
                    <select
                      className="settings-select"
                      aria-label="网页字号"
                      value={preferences.webFontSize}
                      onChange={(event) => onUpdate({ webFontSize: Number(event.target.value) })}
                    >
                      {WEB_FONT_SIZES.map((size) => <option value={size} key={size}>{size} px</option>)}
                    </select>
                  </div>
                  <div className="setting-row">
                    <div><strong>网页字体</strong><p>优先用于网页正文；网站指定了字体的部分仍可能保留自身样式。</p></div>
                    <select
                      className="settings-select settings-select--wide"
                      aria-label="网页字体"
                      value={preferences.webFontFamily}
                      onChange={(event) => onUpdate({ webFontFamily: event.target.value })}
                    >
                      {WEB_FONT_FAMILIES.map((font) => <option value={font.value} key={font.label}>{font.label}</option>)}
                    </select>
                  </div>
                  <div className="setting-row">
                    <div><strong>网页缩放</strong><p>按比例放大或缩小网页内容，不会影响浏览器界面。</p></div>
                    <div className="zoom-control">
                      <input
                        aria-label="网页缩放"
                        type="range"
                        min={50}
                        max={200}
                        step={5}
                        value={preferences.webZoom}
                        onChange={(event) => onUpdate({ webZoom: Number(event.target.value) })}
                      />
                      <strong>{preferences.webZoom}%</strong>
                      <button className="secondary-button" type="button" onClick={() => onUpdate({ webZoom: 100 })} disabled={preferences.webZoom === 100}>重置</button>
                    </div>
                  </div>
                </div>

                {desktop && (
                  <div className="settings-card">
                    <div className="settings-card__title"><Download size={18} /><div><h3>下载位置</h3><p>{preferences.downloadsAskWhere ? '下载时会询问保存位置，对话框默认打开下面的文件夹。' : '下载会直接保存到下面的文件夹，不再询问。'}</p></div></div>
                    <div className="setting-row">
                      <div><strong>默认下载文件夹</strong><p className="download-path" title={downloadDirectory?.directory}>{downloadDirectory?.directory ?? '正在读取…'}</p></div>
                      <div className="download-location-actions">
                        <button className="secondary-button" type="button" disabled={changingDirectory} onClick={() => void changeDownloadDirectory()}>
                          {changingDirectory ? '选择中…' : '更改位置'}
                        </button>
                        {downloadDirectory && !downloadDirectory.isDefault && (
                          <button className="secondary-button" type="button" disabled={changingDirectory} onClick={() => void restoreDownloadDirectory()}>恢复默认</button>
                        )}
                      </div>
                    </div>
                    <div className="setting-row">
                      <div><strong>下载前询问保存位置</strong><p>关闭后所有下载直接保存到上面的文件夹，适合批量下载。</p></div>
                      <label className="switch">
                        <input
                          aria-label="下载前询问保存位置"
                          type="checkbox"
                          checked={preferences.downloadsAskWhere}
                          onChange={(event) => onUpdate({ downloadsAskWhere: event.target.checked })}
                        />
                        <span />
                      </label>
                    </div>
                    <p className="home-url-hint">默认位置是浏览器程序目录下的 LumaDownload 文件夹。</p>
                  </div>
                )}

                <div className="settings-card">
                  <div className="settings-card__title"><Power size={18} /><div><h3>启动</h3><p>决定 Luma 打开时显示什么。上次的标签页始终保存在本地，选择“新标签页”时不会自动恢复。</p></div></div>
                  <div className="setting-row">
                    <div><strong>启动时</strong><p>恢复上次打开的标签页，或直接打开一个新标签页。</p></div>
                    <select
                      aria-label="启动时"
                      value={preferences.startupBehavior}
                      onChange={(event) => onUpdate({ startupBehavior: event.target.value as Preferences['startupBehavior'] })}
                    >
                      <option value="continue">继续上次的标签页</option>
                      <option value="new-tab">打开新标签页</option>
                    </select>
                  </div>
                </div>

                <div className="settings-card">
                  <div className="settings-card__title"><Home size={18} /><div><h3>主页</h3><p>点击地址栏的主页按钮时打开。新标签页始终显示独立的快捷页面。</p></div></div>
                  <div className="setting-row">
                    <div><strong>当前主页</strong><p>{builtInHome ? 'Luma 内置主页' : displayUrl(preferences.homePage)}</p></div>
                    <button className="secondary-button" type="button" onClick={restoreHome} disabled={builtInHome}><RotateCcw size={14} /> 恢复 Luma 主页</button>
                  </div>
                  <form className="home-url-form" onSubmit={submitHome}>
                    <label>
                      <span>自定义主页地址</span>
                      <input
                        aria-label="自定义主页地址"
                        value={homeInput}
                        onChange={(event) => { setHomeInput(event.target.value); setHomeError(''); }}
                        placeholder="https://example.com 或 example.com"
                        inputMode="url"
                        autoComplete="off"
                      />
                    </label>
                    <button className="primary-button" type="submit" disabled={!homeInput.trim()}>保存主页</button>
                  </form>
                  {homeError && <p className="form-error" role="alert">{homeError}</p>}
                  <p className="home-url-hint">支持 HTTP、HTTPS、file:// 本地文件与 luma:// 内置页面地址。留空并恢复默认即可回到 Luma 主页。</p>
                </div>

                <div className="settings-card">
                  <div className="settings-card__title"><Globe2 size={18} /><div><h3>翻译与隐私</h3><p>网页翻译会把提取出的页面文字发送给第三方翻译服务（DeepL / Google / MyMemory），不会上传 Cookie 或登录信息。</p></div></div>
                  <div className="setting-row">
                    <div><strong>翻译服务</strong><p>「自动」会依次尝试 DeepL、Google、MyMemory，某个服务不可用时自动换下一个，并记住上次成功的服务。</p></div>
                    <select
                      className="settings-select"
                      aria-label="翻译服务"
                      value={preferences.translationProvider}
                      onChange={(event) => onUpdate({ translationProvider: event.target.value as Preferences['translationProvider'] })}
                    >
                      <option value="auto">自动（推荐）</option>
                      <option value="deepl">DeepL（需要 API Key）</option>
                      <option value="google">Google 翻译</option>
                      <option value="mymemory">MyMemory</option>
                    </select>
                  </div>
                  <div className="setting-row">
                    <div><strong>DeepL API Key</strong><p>可选。免费版 Key 以 <code>:fx</code> 结尾，填好后「自动」会优先使用 DeepL；Key 只保存在本机。</p></div>
                    <input
                      className="settings-input settings-input--wide"
                      type="password"
                      aria-label="DeepL API Key"
                      placeholder="例如 1234abcd-…:fx"
                      value={preferences.translationApiKey}
                      onChange={(event) => onUpdate({ translationApiKey: event.target.value.trim().slice(0, 200) })}
                    />
                  </div>
                  <div className="setting-row">
                    <div><strong>允许发送页面文字用于翻译</strong><p>关闭后整页翻译不可用；随时可以重新开启。</p></div>
                    <label className="switch"><input aria-label="允许发送页面文字用于翻译" type="checkbox" checked={preferences.translationConsent} onChange={(event) => onUpdate({ translationConsent: event.target.checked })} /><span /></label>
                  </div>
                </div>

                <div className="settings-card settings-summary-card">
                  <div className="settings-card__title"><Sparkles size={18} /><div><h3>当前浏览概览</h3><p>这些数据只保存在你的设备上。</p></div></div>
                  <div className="settings-summary-grid">
                    <button type="button" onClick={() => setActiveSection('search')}>
                      <SearchEngineMark engine={currentEngine.id} customEngines={preferences.customSearchEngines} size="large" />
                      <span><small>默认搜索引擎</small><strong>{currentEngine.name}</strong></span>
                    </button>
                    <div><Bookmark size={20} /><span><small>书签</small><strong>{bookmarkCount}</strong></span></div>
                    <div><HardDrive size={20} /><span><small>历史记录</small><strong>{historyCount}</strong></span></div>
                  </div>
                </div>
              </div>
            )}

            {activeSection === 'tabs' && (
              <div className="settings-content">
                <div className="settings-card">
                  <div className="settings-card__title"><PanelsTopLeft size={18} /><div><h3>标签页操作</h3><p>选择关闭标签页时最顺手的操作方式。</p></div></div>
                  <div className="setting-row">
                    <div><strong>双击关闭标签页</strong><p>在标签页上快速双击即可关闭它。</p></div>
                    <label className="switch"><input aria-label="双击关闭标签页" type="checkbox" checked={preferences.doubleClickClosesTab} onChange={(event) => onUpdate({ doubleClickClosesTab: event.target.checked })} /><span /></label>
                  </div>
                  <div className="setting-row">
                    <div><strong>右键关闭标签页</strong><p>启用后右键单击标签页会直接关闭，替代标签页选项菜单。</p></div>
                    <label className="switch"><input aria-label="右键关闭标签页" type="checkbox" checked={preferences.rightClickClosesTab} onChange={(event) => onUpdate({ rightClickClosesTab: event.target.checked })} /><span /></label>
                  </div>
                </div>

                <div className="settings-card">
                  <div className="settings-card__title"><Timer size={18} /><div><h3>内存节省</h3><p>长时间未查看的后台标签页会自动休眠，释放 Chromium 渲染进程占用的内存。</p></div></div>
                  <div className="setting-row">
                    <div><strong>自动休眠后台标签页</strong><p>正在播放声音或仍在加载的标签页不会被休眠。</p></div>
                    <label className="switch"><input aria-label="自动休眠后台标签页" type="checkbox" checked={preferences.tabSleepEnabled} onChange={(event) => onUpdate({ tabSleepEnabled: event.target.checked })} /><span /></label>
                  </div>
                  <div className="setting-row">
                    <div><strong>休眠等待时间</strong><p>标签页在后台闲置多久后释放内存。</p></div>
                    <select
                      className="settings-select"
                      aria-label="休眠等待时间"
                      value={preferences.tabSleepDelayMinutes}
                      disabled={!preferences.tabSleepEnabled}
                      onChange={(event) => onUpdate({ tabSleepDelayMinutes: Number(event.target.value) })}
                    >
                      {[5, 15, 30, 60, 120].map((minutes) => (
                        <option value={minutes} key={minutes}>{minutes >= 60 ? `${minutes / 60} 小时` : `${minutes} 分钟`}</option>
                      ))}
                    </select>
                  </div>
                  <div className="setting-row">
                    <div><strong>最多常驻标签页</strong><p>超过上限后自动休眠最久未使用的后台标签页，避免内存持续增长。</p></div>
                    <select
                      className="settings-select"
                      aria-label="最多常驻标签页"
                      value={preferences.maxResidentTabs}
                      onChange={(event) => onUpdate({ maxResidentTabs: Number(event.target.value) })}
                    >
                      {[2, 4, 6, 8, 12, 0].map((count) => (
                        <option value={count} key={count}>{count === 0 ? '不限制' : `${count} 个`}</option>
                      ))}
                    </select>
                  </div>
                  <div className="setting-row">
                    <div><strong>立即释放内存</strong><p>手动休眠当前窗口中的所有后台标签页，点击标签页即可恢复。</p></div>
                    <button className="secondary-button" type="button" disabled={tabCount <= 1} onClick={onSleepBackgroundTabs}>
                      <Timer size={14} />立即休眠
                    </button>
                  </div>
                </div>

                <div className="settings-card">
                  <div className="settings-card__title"><SlidersHorizontal size={18} /><div><h3>预览与切换</h3><p>让标签页更容易被找到和切换。</p></div></div>
                  <div className="setting-row">
                    <div><strong>显示标签页悬浮预览</strong><p>鼠标停留在标签页上时显示网页缩略图。</p></div>
                    <label className="switch"><input aria-label="显示标签页悬浮预览" type="checkbox" checked={preferences.showTabPreviews} onChange={(event) => onUpdate({ showTabPreviews: event.target.checked })} /><span /></label>
                  </div>
                  <div className="setting-row">
                    <div><strong>在标签栏滚动鼠标切换标签页</strong><p>鼠标位于标签栏时，滚动滚轮可前后切换标签页。</p></div>
                    <label className="switch"><input aria-label="在标签栏滚动鼠标切换标签页" type="checkbox" checked={preferences.scrollTabsToSwitch} onChange={(event) => onUpdate({ scrollTabsToSwitch: event.target.checked })} /><span /></label>
                  </div>
                </div>

                <div className="settings-card">
                  <div className="settings-card__title"><Search size={18} /><div><h3>地址栏</h3><p>控制输入提示与右侧按钮的显示。</p></div></div>
                  <div className="setting-row">
                    <div><strong>显示输入历史</strong><p>在地址栏输入时，从最近浏览记录中推荐匹配的页面。</p></div>
                    <label className="switch"><input aria-label="显示输入历史" type="checkbox" checked={preferences.showAddressSuggestions} onChange={(event) => onUpdate({ showAddressSuggestions: event.target.checked })} /><span /></label>
                  </div>
                  {ADDRESS_BAR_BUTTONS.map((button) => (
                    <div className="setting-row" key={button.key}>
                      <div><strong>{button.label}</strong><p>{button.hint}</p></div>
                      <label className="switch">
                        <input
                          aria-label={`显示${button.label}按钮`}
                          type="checkbox"
                          checked={preferences.addressBarButtons[button.key] !== false}
                          onChange={(event) => onUpdate({
                            addressBarButtons: { ...preferences.addressBarButtons, [button.key]: event.target.checked },
                          })}
                        />
                        <span />
                      </label>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {activeSection === 'search' && (
              <div className="settings-content">
                <div className="settings-card">
                  <div className="settings-card__header">
                    <div><h3>默认搜索引擎</h3><p>地址栏输入非网址内容时使用。所有引擎都会在真实的浏览器 WebView 中打开。</p></div>
                    <button className="primary-button" type="button" onClick={openEngineDialog}><Plus size={16} /> 添加自定义</button>
                  </div>
                  <div className="settings-engine-list" role="radiogroup" aria-label="默认搜索引擎">
                    {engines.map((engine) => {
                      const selected = preferences.searchEngine === engine.id;
                      return (
                        <div className={`settings-engine-row ${selected ? 'is-selected' : ''}`} key={engine.id}>
                          <button type="button" role="radio" aria-checked={selected} onClick={() => onUpdate({ searchEngine: engine.id })}>
                            <SearchEngineMark engine={engine.id} customEngines={preferences.customSearchEngines} size="large" />
                            <span><strong>{engine.name}</strong><small>{engine.domain}{engine.isCustom ? ' · 自定义' : ' · 内置'}</small></span>
                            {selected && <em><Check size={13} /> 默认</em>}
                          </button>
                          {engine.isCustom && (
                            <button className="settings-engine-remove" type="button" aria-label={`删除 ${engine.name}`} title="删除自定义搜索引擎" onClick={() => onRemoveSearchEngine(engine.id)}>
                              <Trash2 size={15} />
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="settings-card settings-engine-help">
                  <Globe2 size={22} />
                  <div>
                    <h3>自定义搜索引擎</h3>
                    <p>在搜索地址中使用 <code>%s</code> 代表搜索关键词。例如：</p>
                    <code>https://search.example.com/?q=%s</code>
                    <p>添加后会立即设为默认引擎，你也可以随时切回内置搜索。</p>
                  </div>
                </div>
              </div>
            )}

            {activeSection === 'shortcuts' && (
              <div className="settings-content">
                <div className="shortcut-intro">
                  <Keyboard size={22} />
                  <div><strong>自定义快捷键</strong><p>点击右侧的按键组合后按下新的组合键，按 Esc 取消。快捷键在网页获得焦点时同样有效。</p></div>
                  <button className="secondary-button" type="button" onClick={resetShortcuts}><RotateCcw size={14} />恢复默认</button>
                </div>
                {shortcutError && <p className="form-error" role="alert">{shortcutError}</p>}
                {SHORTCUT_GROUPS.map((group) => (
                  <div className="settings-card shortcut-card" key={group.title}>
                    <div className="settings-card__header"><div><h3>{group.title}</h3><p>{group.description}</p></div></div>
                    <div className="shortcut-list shortcut-list--editable">
                      {group.items.map((item) => (
                        <div key={item.action}>
                          <span>{item.label}</span>
                          <button
                            type="button"
                            className={`shortcut-recorder ${recording === item.action ? 'is-recording' : ''}`}
                            aria-label={`更改${item.label}快捷键`}
                            onClick={() => {
                              setShortcutError('');
                              setRecording(recording === item.action ? null : item.action);
                            }}
                          >
                            {recording === item.action
                              ? '请按下组合键…'
                              : <kbd>{formatAccelerator(preferences.shortcuts[item.action] ?? '').map((key) => <span key={key}>{key}</span>)}</kbd>}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
                <div className="settings-card">
                  <div className="settings-card__title"><KeyRound size={18} /><div><h3>老板键</h3><p>在任意应用中按一次隐藏所有 Luma 窗口，再按一次恢复显示。</p></div></div>
                  <div className="setting-row">
                    <div><strong>全局隐藏 / 恢复</strong><p>{bossKeyError || '系统级快捷键，即使 Luma 不在前台也会生效。'}</p></div>
                    <button
                      type="button"
                      className={`shortcut-recorder ${recording === 'bossKey' ? 'is-recording' : ''}`}
                      aria-label="更改老板键"
                      onClick={() => {
                        setBossKeyError('');
                        setRecording(recording === 'bossKey' ? null : 'bossKey');
                      }}
                    >
                      {recording === 'bossKey'
                        ? '请按下组合键…'
                        : <kbd>{formatAccelerator(preferences.bossKey).map((key) => <span key={key}>{key}</span>)}</kbd>}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {activeSection === 'adblock' && (
              <div className="settings-content">
                {!desktop ? (
                  <div className="settings-card"><p className="permission-empty">广告与跟踪拦截仅在 Luma 桌面应用中可用。</p></div>
                ) : (
                  <>
                    <div className="settings-card">
                      <div className="settings-card__title"><ShieldCheck size={18} /><div><h3>广告与跟踪拦截</h3><p>基于 EasyList、EasyPrivacy、EasyList China 与 AdGuard 中文规则拦截广告和跟踪请求，规则每周自动更新，内置离线列表作为兜底。</p></div></div>
                      <div className="setting-row">
                        <div><strong>启用拦截</strong><p>关闭后所有网站都会正常加载第三方广告与跟踪请求。</p></div>
                        <label className="switch"><input aria-label="启用广告与跟踪拦截" type="checkbox" checked={Boolean(adblockState?.enabled)} disabled={!adblockState} onChange={(event) => void toggleAdblockGlobal(event.target.checked)} /><span /></label>
                      </div>
                      <div className="adblock-summary">
                        <div><small>累计拦截</small><strong>{adblockState ? adblockState.blockedTotal : '—'}</strong></div>
                        <div><small>规则数量</small><strong>{adblockState ? adblockState.ruleCount.toLocaleString('zh-CN') : '—'}</strong></div>
                        <div><small>规则引擎</small><strong>{adblockState?.engine === 'ghostery' ? 'Ghostery' : '内置离线'}</strong></div>
                      </div>
                      <div className="adblock-meta">
                        <span>最近更新：{adblockState?.lastUpdated ? `${formatHistoryDate(adblockState.lastUpdated)} ${formatTime(adblockState.lastUpdated)}` : '尚未更新'}</span>
                        <div className="adblock-meta__actions">
                          {adblockState?.sources?.map((source) => <em key={source.id}>{source.label}</em>)}
                          <button className="secondary-button" type="button" disabled={adblockState?.updating} onClick={() => void updateAdblockRules()}>
                            <RefreshCw size={14} className={adblockState?.updating ? 'is-spinning' : ''} />
                            {adblockState?.updating ? '正在更新…' : '更新规则'}
                          </button>
                        </div>
                      </div>
                      {adblockState?.error && <p className="form-error" role="alert">规则更新失败：{adblockState.error}。当前仍使用上一份规则或内置离线列表。</p>}
                      <p className="home-url-hint">在地址栏右侧的盾牌图标中，可以随时对当前网站单独暂停或恢复拦截；元素隐藏规则会自动清理常见广告位。</p>
                    </div>

                    <div className="settings-card">
                      <div className="settings-card__header">
                        <div><h3>已暂停拦截的网站</h3><p>这些网站会完整加载第三方广告与跟踪请求。移除后立即恢复拦截。</p></div>
                      </div>
                      <div className="permission-site-list">
                        {adblockState && adblockState.disabledSites.length === 0 && (
                          <p className="permission-empty">还没有暂停任何网站。使用地址栏盾牌图标即可按站点关闭拦截。</p>
                        )}
                        {adblockState?.disabledSites.map((host) => (
                          <div className="permission-site-row" key={host}>
                            <span className="permission-site-row__main"><strong>{host}</strong><small>拦截已暂停</small></span>
                            <span className="permission-site-row__actions">
                              <button className="secondary-button" type="button" onClick={() => void restoreAdblockSite(host)}>恢复拦截</button>
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}

            {activeSection === 'extensions' && (
              <div className="settings-content">
                {!desktop ? (
                  <div className="settings-card"><p className="permission-empty">扩展仅在 Luma 桌面应用中可用。</p></div>
                ) : (
                  <div className="settings-card">
                    <div className="settings-card__header">
                      <div>
                        <h3>已安装扩展</h3>
                        <p>扩展运行在浏览配置中，能够读取和修改你访问的网页，请只加载可信来源的扩展。</p>
                      </div>
                      <div className="update-actions">
                        <button className="secondary-button" type="button" onClick={() => void desktop?.openExtensionsFolder?.()}>
                          <FolderOpen size={15} /> 打开目录
                        </button>
                        <button
                          className="secondary-button"
                          type="button"
                          disabled={extensionBusy === 'crx'}
                          onClick={() => void installCrx()}
                        >
                          <PackageOpen size={15} /> {extensionBusy === 'crx' ? '正在安装…' : '安装 .crx'}
                        </button>
                        <button
                          className="primary-button"
                          type="button"
                          disabled={extensionBusy === 'install'}
                          onClick={() => void installExtension()}
                        >
                          <Plus size={16} /> {extensionBusy === 'install' ? '正在加载…' : '加载已解压扩展'}
                        </button>
                      </div>
                    </div>
                    {extensionError && <p className="form-error" role="alert">{extensionError}</p>}
                    {extensions.length === 0 ? (
                      <p className="extension-empty">
                        还没有扩展。可以安装 <code>.crx</code> 安装包，或选择一个包含 <code>manifest.json</code> 的目录。
                        Luma 会把扩展复制到 <code> Luma Browser\Extensions</code> 并在每次启动时自动加载。
                      </p>
                    ) : (
                      <div className="extension-list">
                        {extensions.map((extension) => (
                          <div className="extension-row" key={extension.id}>
                            <div className="extension-row__main">
                              <strong>
                                {extension.name}
                                <small>v{extension.version || '—'}</small>
                              </strong>
                              <p>{extension.description || '这个扩展没有提供描述。'}</p>
                              <div className="extension-row__meta">
                                <em>MV{extension.manifestVersion}</em>
                                {extension.hasBackground && <em>后台脚本</em>}
                                {extension.permissions.length > 0 && (
                                  <em title={extension.permissions.join('、')}>{extension.permissions.length} 项权限</em>
                                )}
                                {extension.matches.length > 0 && <em>{extension.matches.length} 条匹配规则</em>}
                                {!extension.loaded && extension.enabled && <em className="is-warning">未加载</em>}
                              </div>
                              {extension.error && <p className="form-error" role="alert">{extension.error}</p>}
                              {extension.loaded && extension.compat?.limited && (
                                <p className="extension-row__limit">
                                  <AlertTriangle size={12} />
                                  <span>
                                    内核缺少 {extension.compat.missing.slice(0, 4).join('、')}
                                    {extension.compat.missing.length > 4 ? ` 等 ${extension.compat.missing.length} 项` : ''}，
                                    该扩展可能加载成功但部分功能不会生效。
                                  </span>
                                </p>
                              )}
                              {extension.loaded && extension.compat?.notes?.length > 0 && (
                                <p className="extension-row__note">{extension.compat.notes[0]}</p>
                              )}                            </div>
                            <div className="extension-row__actions">
                              {extension.page && extension.loaded && (
                                <button
                                  className="secondary-button secondary-button--compact"
                                  type="button"
                                  onClick={() => void desktop?.openExtensionPage?.(extension.id, extension.page)}
                                  title="在一个独立窗口中打开扩展的选项/仪表盘页面"
                                >
                                  <SquareArrowOutUpRight size={13} /> 打开页面
                                </button>
                              )}
                              <label className="switch">
                                <input
                                  aria-label={`启用 ${extension.name}`}
                                  type="checkbox"
                                  checked={extension.enabled}
                                  onChange={(event) => void toggleExtension(extension, event.target.checked)}
                                />
                                <span />
                              </label>
                              <button
                                className="icon-button icon-button--small"
                                type="button"
                                aria-label={`重新加载 ${extension.name}`}
                                title="重新加载"
                                disabled={extensionBusy === extension.id}
                                onClick={() => void reloadExtension(extension)}
                              >
                                <RefreshCw size={13} />
                              </button>
                              <button
                                className={`icon-button icon-button--small ${confirmRemoveId === extension.id ? 'is-danger' : ''}`}
                                type="button"
                                aria-label={confirmRemoveId === extension.id ? `确认移除 ${extension.name}` : `移除 ${extension.name}`}
                                title={confirmRemoveId === extension.id ? '再次点击确认移除' : '移除'}
                                disabled={extensionBusy === extension.id}
                                onClick={() => void removeExtension(extension)}
                              >
                                {confirmRemoveId === extension.id ? <span className="confirm-remove">确认</span> : <Trash2 size={13} />}
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    <p className="update-hint">
                      带 <code>action</code> 的扩展会在标签栏右侧显示图标，点击即可打开它的弹窗（Esc 或点击别处关闭）。
                      扩展无法更新图标上的角标数字，依赖 declarativeNetRequest 的拦截类扩展也不受支持，
                      广告拦截请使用内置引擎；无痕窗口不会加载扩展。
                    </p>
                  </div>
                )}

                {desktop && (
                  <div className="settings-card">
                    <div className="settings-card__header">
                      <div>
                        <h3>用户脚本</h3>
                        <p>
                          直接运行 <code>.user.js</code>：脚本在页面主世界执行，支持 GM_setValue / GM_getValue、
                          GM_addStyle、GM_xmlhttpRequest 等常用能力。当前内核没有
                          <code>chrome.userScripts</code>，篡改猴（MV3）因此无法注入脚本，用这里替代即可。
                        </p>
                      </div>
                      <div className="update-actions">
                        <button className="secondary-button" type="button" onClick={() => void desktop.openUserscriptsFolder?.()}>
                          <FolderOpen size={15} /> 打开目录
                        </button>
                        <button
                          className="primary-button"
                          type="button"
                          disabled={userscriptBusy === 'install'}
                          onClick={() => void installUserscript()}
                        >
                          <Plus size={16} /> {userscriptBusy === 'install' ? '正在安装…' : '安装脚本'}
                        </button>
                      </div>
                    </div>
                    {userscriptError && <p className="form-error" role="alert">{userscriptError}</p>}
                    {userscripts.length === 0 ? (
                      <p className="extension-empty">
                        还没有用户脚本。可以点击「安装脚本」选择 <code>.user.js</code>，
                        也可以把脚本放进 <code>Luma Browser\Userscripts</code> 后重新加载。脚本在每次页面加载完成后注入。
                      </p>
                    ) : (
                      <div className="extension-list">
                        {userscripts.map((script) => (
                          <div className="extension-row" key={script.id}>
                            <div className="extension-row__main">
                              <strong>
                                {script.name}
                                <small>{script.version ? `v${script.version}` : '未标注版本'}</small>
                              </strong>
                              <p>{script.description || '这个脚本没有提供描述。'}</p>
                              <div className="extension-row__meta">
                                <em>{script.runAt}</em>
                                {(script.matches.length + script.includes.length) > 0 && (
                                  <em title={[...script.matches, ...script.includes].join('\n')}>
                                    {script.matches.length + script.includes.length} 条匹配规则
                                  </em>
                                )}
                                {script.grants.length > 0 && <em title={script.grants.join('、')}>{script.grants.length} 项 GM 授权</em>}
                                <em>{(script.size / 1024).toFixed(1)} KB</em>
                              </div>
                            </div>
                            <div className="extension-row__actions">
                              <label className="switch">
                                <input
                                  aria-label={`启用 ${script.name}`}
                                  type="checkbox"
                                  checked={script.enabled}
                                  onChange={(event) => void toggleUserscript(script, event.target.checked)}
                                />
                                <span />
                              </label>
                              <button
                                className={`icon-button icon-button--small ${userscriptBusy === `remove:${script.id}` ? 'is-danger' : ''}`}
                                type="button"
                                aria-label={userscriptBusy === `remove:${script.id}` ? `确认移除 ${script.name}` : `移除 ${script.name}`}
                                title={userscriptBusy === `remove:${script.id}` ? '再次点击确认移除' : '移除'}
                                onClick={() => void removeUserscript(script)}
                              >
                                {userscriptBusy === `remove:${script.id}` ? <span className="confirm-remove">确认</span> : <Trash2 size={13} />}
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {activeSection === 'passwords' && (
              <div className="settings-content">
                {!desktop ? (
                  <div className="settings-card"><p className="permission-empty">密码管理仅在 Luma 桌面应用中可用。</p></div>
                ) : (
                  <>
                    <div className="settings-card">
                      <div className="settings-card__title"><KeyRound size={18} /><div><h3>登录信息</h3><p>密码使用系统安全存储（Windows DPAPI / safeStorage）加密后保存在本机，Luma 不会上传。</p></div></div>
                      <div className="setting-row">
                        <div><strong>自动填充登录表单</strong><p>打开已保存登录信息的网站时，自动填写用户名和密码，不会自动提交。</p></div>
                        <label className="switch"><input aria-label="自动填充登录表单" type="checkbox" checked={preferences.autoFillEnabled} onChange={(event) => onUpdate({ autoFillEnabled: event.target.checked })} /><span /></label>
                      </div>
                      <div className="setting-row">
                        <div><strong>提交登录后询问保存</strong><p>检测到登录表单提交时，弹出保存确认。无痕窗口永远不会保存。</p></div>
                        <label className="switch"><input aria-label="提交登录后询问保存" type="checkbox" checked={preferences.passwordSavingEnabled} onChange={(event) => onUpdate({ passwordSavingEnabled: event.target.checked })} /><span /></label>
                      </div>
                      {passwordStatus && !passwordStatus.available && (
                        <p className="form-error" role="alert">系统安全存储当前不可用，Luma 不会保存任何密码。</p>
                      )}
                      {passwordStatus?.readOnly && (
                        <p className="form-error" role="alert">密码库文件无法读取或写入，已进入只读保护模式，不会用空数据覆盖原文件。请从备份恢复或联系支持。</p>
                      )}
                      {passwordStatus?.recovered && (
                        <p className="home-url-hint" role="status">已从 passwords.json.bak 备份恢复密码库，建议检查登录信息是否完整。</p>
                      )}
                      {passwordError && <p className="form-error" role="alert">{passwordError}</p>}
                    </div>

                    <div className="settings-card">
                      <div className="settings-card__header">
                        <div><h3>已保存的登录信息</h3><p>共 {savedPasswords.length} 条。显示密码需要主进程解密，仅在本机可见。</p></div>
                        <div className="site-data-actions">
                          <button className="secondary-button" type="button" onClick={() => void refreshPasswords()}><RefreshCw size={14} />刷新</button>
                          <button className="secondary-button danger-text" type="button" disabled={savedPasswords.length === 0} onClick={() => setConfirmClearPasswords(true)}><Trash2 size={14} />全部清除</button>
                        </div>
                      </div>
                      <div className="password-list">
                        {savedPasswords.length === 0 && (
                          <p className="permission-empty">还没有保存的登录信息。登录网站后，Luma 会询问是否加密保存。</p>
                        )}
                        {savedPasswords.map((entry) => (
                          <div className="password-row" key={entry.id}>
                            <span className="password-row__icon"><KeyRound size={16} /></span>
                            <span className="password-row__main">
                              <strong>{entry.host}</strong>
                              <small>{entry.username || '未保存用户名'} · 更新于 {formatHistoryDate(entry.updatedAt)} {formatTime(entry.updatedAt)}</small>
                              {revealedPassword?.id === entry.id && (
                                <code className="password-row__secret">{revealedPassword.password}</code>
                              )}
                            </span>
                            <span className="password-row__actions">
                              <button className="secondary-button" type="button" onClick={() => void toggleRevealPassword(entry)}>
                                {revealedPassword?.id === entry.id ? <><EyeOff size={14} />隐藏</> : <><Eye size={14} />显示</>}
                              </button>
                              <button className="secondary-button" type="button" onClick={() => void copySavedPassword(entry.id)}>复制</button>
                              <button className="secondary-button danger-text" type="button" aria-label={`删除 ${entry.host} 的登录信息`} onClick={() => void removeSavedPassword(entry.id)}><Trash2 size={14} /></button>
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}

            {activeSection === 'permissions' && (
              <div className="settings-content">
                {!desktop ? (
                  <div className="settings-card"><p className="permission-empty">权限管理仅在 Luma 桌面应用中可用。</p></div>
                ) : (
                  <>
                    <div className="settings-card">
                      <div className="settings-card__header">
                        <div><h3>默认权限</h3><p>网站请求这些能力时按默认策略处理。在权限弹窗中选择“始终允许”会为单个网站保存例外。</p></div>
                        {permissionsLoading && <span className="permission-loading">正在读取…</span>}
                      </div>
                      <div className="permission-default-list">
                        {PERMISSION_CATEGORIES.map((category) => {
                          const Icon = category.icon;
                          return (
                            <div className="permission-default-row" key={category.id}>
                              <span className="permission-default-row__icon"><Icon size={17} /></span>
                              <span className="permission-default-row__text"><strong>{category.label}</strong><small>{category.description}</small></span>
                              <select
                                className="settings-select"
                                aria-label={`${category.label}默认权限`}
                                value={permissionOverview?.defaults[category.id] ?? 'ask'}
                                disabled={!permissionOverview}
                                onChange={(event) => void changeDefaultPermission(category.id, event.target.value as PermissionPolicy)}
                              >
                                <option value="ask">每次询问</option>
                                <option value="allow">允许</option>
                                <option value="deny">拒绝</option>
                              </select>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    <div className="settings-card">
                      <div className="settings-card__header">
                        <div><h3>网站例外</h3><p>已为特定网站保存的权限决定。撤销后，该网站会重新遵循默认策略。</p></div>
                        <button
                          className="secondary-button danger-text"
                          type="button"
                          disabled={!permissionOverview || permissionOverview.sites.length === 0}
                          onClick={() => setConfirmClearPermissions(true)}
                        >
                          <Trash2 size={15} /> 撤销全部例外
                        </button>
                      </div>
                      <div className="permission-site-list">
                        {permissionOverview && permissionOverview.sites.length === 0 && (
                          <p className="permission-empty">还没有网站例外。在权限弹窗中选择“始终允许”后，网站会出现在这里。</p>
                        )}
                        {permissionOverview?.sites.map((site) => {
                          const entries = Object.entries(site.permissions) as [PermissionCategory, PermissionPolicy][];
                          return (
                            <div className="permission-site-row" key={site.origin}>
                              <span className="permission-site-row__main">
                                <strong>{permissionHost(site.origin)}</strong>
                                <small>{site.origin}</small>
                              </span>
                              <span className="permission-site-row__chips">
                                {entries.map(([category, policy]) => {
                                  const meta = PERMISSION_CATEGORIES.find((item) => item.id === category);
                                  if (!meta) return null;
                                  return <em className={`permission-chip permission-chip--${policy}`} key={category}>{meta.label} · {PERMISSION_POLICY_LABELS[policy]}</em>;
                                })}
                              </span>
                              <span className="permission-site-row__actions">
                                <button className="secondary-button" type="button" onClick={() => setPermissionSite(site.origin)}>管理</button>
                                <button className="secondary-button danger-text" type="button" onClick={() => void removeSitePermission(site.origin)}>撤销</button>
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}

            {activeSection === 'privacy' && (
              <div className="settings-content">
                <div className="privacy-hero">
                  <span><ShieldCheck size={28} /></span>
                  <div><h3>你的浏览数据属于你</h3><p>书签、历史、设置和网站登录状态全部保存在本机。Luma 不上传浏览记录，也不会出售或分析个人数据。</p></div>
                </div>
                <div className="settings-card">
                  <div className="settings-card__title"><Clock3 size={18} /><div><h3>浏览记忆</h3><p>关闭后不再记录新的访问历史，地址栏建议与「最近打开」也会随之减少；已存在的记录不会自动删除。</p></div></div>
                  <div className="setting-row">
                    <div><strong>记录浏览历史</strong><p>历史只保存在本机，可在「历史记录」页逐条删除或全部清除。</p></div>
                    <label className="switch">
                      <input
                        aria-label="记录浏览历史"
                        type="checkbox"
                        checked={preferences.rememberHistory}
                        onChange={(event) => onUpdate({ rememberHistory: event.target.checked })}
                      />
                      <span />
                    </label>
                  </div>
                </div>
                <div className="privacy-feature-grid">
                  <article><LockKeyhole /><div><strong>网站进程隔离</strong><p>每个外部网页运行在 Chromium 沙盒 WebView 中，已禁用 Node.js 能力。</p></div></article>
                  <article><Cookie /><div><strong>权限先询问</strong><p>摄像头、麦克风、位置和通知默认每次询问，可在权限管理中调整策略。</p></div></article>
                  <article><CloudOff /><div><strong>本地持久存储</strong><p>浏览会话保存在独立分区，网站看不到本地文件，也不会共享其他浏览器数据。</p></div></article>
                </div>
                <div className="settings-card site-data-card">
                  <div className="settings-card__header">
                    <div><h3>网站数据管理</h3><p>查看本机 Chromium 分区中的 Cookie、站点存储和缓存，并按网站单独清理。书签、历史和 Luma 设置不会被删除。</p></div>
                    <div className="site-data-actions">
                      <button className="secondary-button" type="button" onClick={() => void refreshSiteData()} disabled={siteDataLoading}><RefreshCw size={15} className={siteDataLoading ? 'is-spinning' : ''} /> 刷新</button>
                      <button className="secondary-button" type="button" onClick={() => void clearCache()}>清除缓存</button>
                      <button className="secondary-button danger-text" type="button" onClick={() => setConfirmClearData(true)}><Trash2 size={16} /> 清除全部</button>
                    </div>
                  </div>
                  <div className="site-data-summary">
                    <div><small>缓存占用</small><strong>{siteData ? formatBytes(siteData.cacheBytes) : '—'}</strong></div>
                    <div><small>Cookie 总数</small><strong>{siteData ? siteData.cookieCount : '—'}</strong></div>
                    <div><small>已发现网站</small><strong>{siteRows.length}</strong></div>
                  </div>
                  <div className="site-data-list">
                    {siteDataLoading && !siteData && <p className="site-data-empty">正在读取网站数据…</p>}
                    {!siteDataLoading && siteRows.length === 0 && (
                      <p className="site-data-empty">暂未发现网站数据。访问网页后，这里会列出保存了 Cookie 的网站。</p>
                    )}
                    {siteRows.map((site) => (
                      <div className="site-data-row" key={site.domain}>
                        <Globe2 size={16} />
                        <span className="site-data-row__main">
                          <strong>{site.domain}</strong>
                          <small>
                            {site.cookieCount > 0 ? `${site.cookieCount} 个 Cookie` : '本地存储'}
                            {site.lastVisited ? ` · 最近访问 ${formatHistoryDate(site.lastVisited)} ${formatTime(site.lastVisited)}` : ''}
                          </small>
                        </span>
                        <button
                          className="secondary-button site-data-row__clear"
                          type="button"
                          disabled={clearingDomain === site.domain}
                          onClick={() => void clearSiteForDomain(site.domain)}
                        >
                          {clearingDomain === site.domain ? '清理中…' : '清除'}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {activeSection === 'about' && (
              <div className="settings-content">
                <div className="settings-stat-grid">
                  {[
                    { label: '书签', value: bookmarkCount, icon: <Bookmark /> },
                    { label: '书签文件夹', value: folderCount, icon: <HardDrive /> },
                    { label: '历史记录', value: historyCount, icon: <Database /> },
                    { label: '打开的标签', value: tabCount, icon: <SlidersHorizontal /> },
                  ].map((stat) => (
                    <div className="settings-stat" key={stat.label}>
                      <span>{stat.icon}</span><strong>{stat.value}</strong><small>{stat.label}</small>
                    </div>
                  ))}
                </div>
                <div className="settings-about-card">
                  <Logo size={48} withWordmark />
                  <h3>Luma Browser</h3>
                  <p>一个专注、轻盈且注重隐私的独立桌面浏览器。基于 Electron、Chromium 与 React 构建。</p>
                  <div>
                    <span>版本 {appVersions?.app ?? '1.21.8'}</span>
                    <span>Chromium {appVersions?.chrome ?? '156.0.8078.80'}</span>
                    <span>Electron {appVersions?.electron ?? '45.2.3'}</span>
                    <span>{appVersions?.platform === 'darwin' ? 'macOS' : appVersions?.platform === 'linux' ? 'Linux' : 'Windows'} {appVersions?.arch ?? 'x64'}</span>
                  </div>
                </div>
                <div className="settings-card">
                  <div className="settings-card__title"><Laptop size={18} /><div><h3>运行时版本</h3><p>浏览器渲染内核与运行时组件版本，随安装包固定。</p></div></div>
                  <div className="version-grid">
                    <div><span>Chromium 内核</span><strong>{appVersions?.chrome ?? '读取中…'}</strong></div>
                    <div><span>Electron</span><strong>{appVersions?.electron ?? '读取中…'}</strong></div>
                    <div><span>Node.js</span><strong>{appVersions?.node ?? '读取中…'}</strong></div>
                    <div><span>V8</span><strong>{appVersions?.v8 ?? '读取中…'}</strong></div>
                  </div>
                </div>
                <div className="settings-card">
                  <div className="settings-card__title"><HardDrive size={18} /><div><h3>存储位置</h3><p>程序文件与用户数据分开存放：升级只替换程序目录，个人数据不会被动到。</p></div></div>
                  <div className="path-grid">
                    <div><span>程序目录</span><code>{appPaths?.install ?? '读取中…'}</code></div>
                    <div><span>用户数据</span><code>{appPaths?.userData ?? '读取中…'}</code></div>
                    <div><span>更新缓存与日志</span><code>{appPaths?.log ?? '读取中…'}</code></div>
                  </div>
                  {appPaths?.isolated && (
                    <p className="update-hint">当前以自定义 <code>--user-data-dir</code> 运行，用户数据指向该目录，不再使用默认的 Luma Browser\User Data。</p>
                  )}
                </div>
                <div className="settings-card">
                  <div className="settings-card__header">
                    <div>
                      <h3>软件更新</h3>
                      <p>
                        {updateStatusText(updateState, checkingUpdate)}
                        {updateState?.status === 'downloading' && updateState.total > 0
                          ? `（${formatBytes(updateState.transferred)} / ${formatBytes(updateState.total)}）`
                          : ''}
                      </p>
                    </div>
                    {updateState?.status === 'downloaded' ? (
                      <button
                        className="primary-button"
                        type="button"
                        onClick={() => void desktop?.installUpdate()}
                      >
                        <Download size={16} /> 重启并安装
                      </button>
                    ) : (updateState?.status === 'available'
                      || updateState?.status === 'downloading'
                      || (updateState?.status === 'error' && (updateState?.lines.length ?? 0) > 0)) ? (
                      <div className="update-actions">
                        <select
                          className="settings-select"
                          aria-label="下载线路"
                          value={updateLine}
                          disabled={updateState?.status === 'downloading'}
                          onChange={(event) => setUpdateLine(event.target.value)}
                        >
                          {(updateState?.lines ?? []).map((line) => (
                            <option key={line.id} value={line.id}>{line.label}</option>
                          ))}
                        </select>
                        <button
                          className="primary-button"
                          type="button"
                          disabled={updateState?.status === 'downloading'}
                          onClick={() => void downloadUpdate()}
                        >
                          <Download size={16} /> {updateState?.status === 'downloading' ? '正在下载…' : '下载更新'}
                        </button>
                      </div>
                    ) : (
                      <button
                        className="secondary-button"
                        type="button"
                        disabled={checkingUpdate}
                        onClick={() => void checkForUpdates()}
                      >
                        <RefreshCw size={16} /> {checkingUpdate ? '正在检查…' : '检查更新'}
                      </button>
                    )}
                  </div>
                  {updateState?.status === 'downloading' && (
                    <div className="update-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={updateState.percent}>
                      <span style={{ width: `${Math.max(2, updateState.percent)}%` }} />
                    </div>
                  )}
                  {updateLine === 'mirror'
                    && (updateState?.status === 'available'
                      || updateState?.status === 'downloading'
                      || (updateState?.status === 'error' && (updateState?.lines.length ?? 0) > 0)) && (
                    <p className="update-hint">
                      镜像线路由第三方加速服务提供，下载完成后会按 GitHub 公布的 SHA256 校验；校验不一致时文件会被删除。
                    </p>
                  )}
                  <div className="setting-row">
                    <div><strong>后台自动下载更新</strong><p>发现新版本后在后台下载安装包，不打断当前浏览；下载完成后由你决定何时安装。</p></div>
                    <label className="switch">
                      <input
                        aria-label="后台自动下载更新"
                        type="checkbox"
                        checked={updatePrefs.autoDownload}
                        onChange={(event) => void changeUpdatePrefs({ autoDownload: event.target.checked })}
                      />
                      <span />
                    </label>
                  </div>
                  <div className="setting-row">
                    <div><strong>退出时自动安装</strong><p>关闭最后一个窗口时静默安装已下载的版本，下次启动即为新版本，不会打断浏览。</p></div>
                    <label className="switch">
                      <input
                        aria-label="退出时自动安装"
                        type="checkbox"
                        checked={updatePrefs.applyOnQuit}
                        onChange={(event) => void changeUpdatePrefs({ applyOnQuit: event.target.checked })}
                      />
                      <span />
                    </label>
                  </div>
                </div>
                <div className="settings-card">
                  <div className="settings-card__header">
                    <div><h3>恢复默认状态</h3><p>清空书签、文件夹、历史记录、自定义搜索引擎和偏好设置，并重置当前标签页。此操作不可撤销。</p></div>
                    <button className="danger-button" type="button" onClick={() => setConfirmReset(true)}><RotateCcw size={16} /> 全部重置</button>
                  </div>
                </div>
              </div>
            )}
          </section>
        </div>
      </main>

      {confirmReset && (
        <Modal title="恢复默认状态？" description="书签、文件夹、历史、自定义搜索引擎和所有偏好设置都会被清除，且无法撤销。" onClose={() => setConfirmReset(false)} footer={<><button className="secondary-button" type="button" onClick={() => setConfirmReset(false)}>取消</button><button className="danger-button" type="button" onClick={() => { onReset(); setConfirmReset(false); }}>确认重置</button></>}>
          <div className="confirmation-illustration"><RotateCcw size={28} /></div>
        </Modal>
      )}

      {confirmClearData && (
        <Modal title="清除网站数据？" description="Cookie、网站存储和缓存将被清理，网站登录状态可能失效。书签与历史记录不受影响。" onClose={() => setConfirmClearData(false)} footer={<><button className="secondary-button" type="button" onClick={() => setConfirmClearData(false)}>取消</button><button className="danger-button" type="button" disabled={clearingData} onClick={() => void clearSiteData()}>{clearingData ? '正在清理…' : '清除网站数据'}</button></>}>
          <div className="confirmation-illustration"><Trash2 size={28} /></div>
        </Modal>
      )}

      {editingSite && (
        <Modal
          title={`管理 ${permissionHost(editingSite.origin)} 的权限`}
          description={editingSite.origin}
          onClose={() => setPermissionSite(null)}
          footer={<><button className="secondary-button danger-text" type="button" onClick={() => void removeSitePermission(editingSite.origin)}>撤销全部例外</button><button className="primary-button" type="button" onClick={() => setPermissionSite(null)}>完成</button></>}
        >
          <div className="permission-site-editor">
            {PERMISSION_CATEGORIES.map((category) => {
              const Icon = category.icon;
              const sitePolicy = editingSite.permissions[category.id] ?? null;
              return (
                <label key={category.id}>
                  <span className="permission-site-editor__icon"><Icon size={16} /></span>
                  <span className="permission-site-editor__text">
                    <strong>{category.label}</strong>
                    <small>{sitePolicy ? PERMISSION_POLICY_LABELS[sitePolicy] : `跟随默认（${PERMISSION_POLICY_LABELS[permissionOverview?.defaults[category.id] ?? 'ask']}）`}</small>
                  </span>
                  <select
                    className="settings-select"
                    aria-label={`${category.label}网站权限`}
                    value={sitePolicy ?? ''}
                    onChange={(event) => void changeSitePermission(
                      editingSite.origin,
                      category.id,
                      event.target.value === '' ? null : event.target.value as PermissionPolicy,
                    )}
                  >
                    <option value="">跟随默认</option>
                    <option value="allow">允许</option>
                    <option value="ask">每次询问</option>
                    <option value="deny">拒绝</option>
                  </select>
                </label>
              );
            })}
          </div>
        </Modal>
      )}

      {confirmClearPermissions && (
        <Modal
          title="撤销全部网站权限？"
          description="所有网站例外都会被删除，网站将重新遵循默认权限策略。Cookie 和浏览记录不受影响。"
          onClose={() => setConfirmClearPermissions(false)}
          footer={<><button className="secondary-button" type="button" onClick={() => setConfirmClearPermissions(false)}>取消</button><button className="danger-button" type="button" onClick={() => void clearAllPermissions()}>撤销全部</button></>}
        >
          <div className="confirmation-illustration"><LockKeyhole size={28} /></div>
        </Modal>
      )}

      {confirmClearPasswords && (
        <Modal
          title="清除全部已保存的密码？"
          description="所有网站的登录信息都会从本机删除，且无法恢复。已登录的网站不会被退出。"
          onClose={() => setConfirmClearPasswords(false)}
          footer={<><button className="secondary-button" type="button" onClick={() => setConfirmClearPasswords(false)}>取消</button><button className="danger-button" type="button" onClick={() => void clearSavedPasswords()}>全部清除</button></>}
        >
          <div className="confirmation-illustration"><KeyRound size={28} /></div>
        </Modal>
      )}

      {engineDialogOpen && (
        <Modal
          title="添加自定义搜索引擎"
          description="使用 %s 表示搜索关键词，搜索会通过当前网站引擎在独立标签页中打开。"
          onClose={() => setEngineDialogOpen(false)}
          footer={<><button className="secondary-button" type="button" onClick={() => setEngineDialogOpen(false)}>取消</button><button className="primary-button" type="submit" form="custom-engine-form" disabled={!engineName.trim() || !engineUrl.trim()}><Plus size={16} /> 添加并设为默认</button></>}
        >
          <form id="custom-engine-form" className="custom-engine-form" onSubmit={submitEngine}>
            <label><span>搜索引擎名称</span><input autoFocus value={engineName} onChange={(event) => { setEngineName(event.target.value); setEngineError(''); }} placeholder="例如：站内搜索" maxLength={30} /></label>
            <label><span>搜索地址 <b>*</b></span><input value={engineUrl} onChange={(event) => { setEngineUrl(event.target.value); setEngineError(''); }} placeholder="https://example.com/search?q=%s" inputMode="url" /></label>
            <p className="custom-engine-form__hint">关键词会被自动进行 URL 编码，仅支持 HTTP 与 HTTPS 地址。</p>
            {engineError && <p className="form-error" role="alert">{engineError}</p>}
          </form>
        </Modal>
      )}
    </div>
  );
}
