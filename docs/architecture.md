# 架构与关键机制

本文记录 Luma Browser 1.15 的模块划分、关键机制，以及这次向主流浏览器（Chrome / Edge / 搜狗）对齐时做了哪些调整、还剩哪些差距。目录与更新流程的实测对照见
[browser-layout-and-updates.md](browser-layout-and-updates.md)。

## 一、进程与模块地图

```text
┌──────────────────────────── main process ────────────────────────────┐
│ electron/main.cjs            装配层：窗口、标签、IPC、生命周期         │
│                                                                       │
│ electron/main/settings.cjs       设置读取与去抖写入                    │
│ electron/main/shortcuts.cjs      快捷键解析、老板键                    │
│ electron/main/sessionPolicy.cjs  每个 profile 的请求/权限管线           │
│ electron/main/translate.cjs      网页翻译（Google → MyMemory 兜底）     │
│ electron/main/windowState.cjs    窗口几何持久化与多屏校验               │
│                                                                       │
│ electron/pageViews.cjs       每个标签一个 WebContentsView              │
│ electron/adblock.cjs         EasyList 引擎与元素隐藏                    │
│ electron/passwords.cjs       safeStorage 密码库                        │
│ electron/overlaySurface.cjs  浮层镜像（菜单盖在原生页之上）              │
│ electron/updater.cjs         检查 → 后台下载 → 延迟安装                 │
│ electron/extensions.cjs      已解压扩展的校验、安装与加载                │
│ electron/appPaths.cjs        User Data / Update 目录与旧数据迁移        │
│ electron/versioning.cjs      版本比较与产物命名                         │
└───────────────────────────────────────────────────────────────────────┘
        │ preload（contextBridge，按窗口类型分开）
        ├─ electron/preload.cjs            浏览器界面 ↔ 主进程
        ├─ electron/guest-preload.cjs      网页隔离世界（密码填充）
        └─ electron/overlay-preload.cjs    浮层镜像的点击回放
        │
┌─────────────────────── renderer（React）──────────────────────────────┐
│ src/app/App.tsx            组合层：把 hook、组件、桌面桥接起来          │
│ src/app/useBrowser.ts      标签/历史/书签/下载的客户端状态机            │
│ src/components/browser/*   标签栏、地址栏、页面宿主、菜单、浮层         │
│ src/pages/*                新标签页、设置、书签、历史、下载             │
└───────────────────────────────────────────────────────────────────────┘
```

划分原则：

- **主进程只做“系统能力”**：窗口、原生视图、会话、文件、网络、更新。渲染层不接触 Node。
- **一个模块一个职责，依赖通过参数注入**：`main/settings.cjs` 不知道 `app`，只接收文件路径与默认值；
  `main/windowState.cjs` 只接收矩形与上限。这样单元测试不需要启动 Electron。
- **装配层保持薄**：`main.cjs` 负责“按什么顺序调用”，不负责“具体怎么写文件”。

## 二、关键机制

### 1. 请求处理：每个 profile 一条声明式管线

`configureSession(session, hooks)` 固定了顺序，普通与无痕 profile 走同一套代码：

```text
1. 身份      去掉 UA 里的 Electron/Luma 产品标记
2. 权限      摄像头/麦克风/定位/通知一律先问用户
3. 网络      webRequest → 广告与跟踪拦截（beforeRequest），被拦的请求不会继续
4. 下载      will-download → 保存目录、断点续传记录
```

之前这段逻辑散落在 `whenReady` 的循环里，加规则要改多处，也容易漏掉无痕 profile。现在顺序在代码里是显式的，
新增规则只需在 `sessionPolicy` 里插一层，并对两个 profile 同时生效。

### 2. 缓存：磁盘配额有上限

Chromium 的 HTTP 缓存默认不设上限，Electron 应用久而久之会把 profile 涨到几个 GB。
主进程启动时加上 `--disk-cache-size=256 MB`，与 Chrome 同量级（其默认约 320 MB）：
既能缓存住常用站点，又不会无限增长。用户数据目录本身已从漫游 AppData 迁到 `%LOCALAPPDATA%`（见上篇文档）。

### 3. 安全：进程沙箱 + 页面隔离

| 措施 | 状态 |
| --- | --- |
| `app.enableSandbox()`：所有渲染进程（含界面自身）运行在 Chromium 沙箱 | 1.15 新增 |
| 每个标签独立 `WebContentsView`，独立渲染进程 | 已有 |
| `contextIsolation: true`、`nodeIntegration: false`、`webSecurity: true` | 已有 |
| 只允许 http(s)/file/空白页导航，其余外部打开 | 已有 |
| 权限请求逐站点询问，并有站点级策略持久化 | 已有 |
| 内置页面 CSP（Vite 注入 meta，生产环境去掉 `unsafe-inline` 的脚本权限） | 已有 |
| 代码签名 | 未做，SmartScreen 会提示未知发布者 |

沙箱是这次真正补上的一块：页面视图此前单独开了 `sandbox: true`，但界面自身的渲染进程没有全局约束，
现在由 `app.enableSandbox()` 统一开启，preload 全部是 CommonJS，无需额外改动。

### 4. 多进程与内存：低内存时回收后台标签

每个标签一个渲染进程是 Chrome 的做法，代价是内存。1.15 增加了主进程侧的**内存采样**：

```text
每 60 秒 process.getSystemMemoryInfo()
  可用内存 / 总内存 ≤ 12% 且距上次触发 ≥ 5 分钟
    → 向所有窗口发 app:memory-pressure
      → 渲染层（拥有标签表与用户偏好）调用 sleepBackgroundTabs()
        → 释放后台标签的页面进程，切回时重新加载
```

判定与回收分在两层：主进程只提供系统信号，渲染层才知道哪些标签可以丢、用户是否开启了自动休眠。
这对应 Chrome 的 Memory Saver，以及它“只在内存紧张时出手”的策略。

### 5. 更新：检查 / 下载 / 应用三段解耦

详见 [browser-layout-and-updates.md](browser-layout-and-updates.md)。要点：4 小时轮询、后台预下载、
关闭最后窗口时静默安装、`update.log` 与 `packages/previous` 回滚包。

### 6. 扩展：受限但可用

Electron 暴露的是 Chrome 扩展平台的一个子集，Luma 只做"已解压扩展"这一种形态：

```text
用户选择目录 → manifest 校验（MV2/MV3、name/version、至少一项能力）
             → 复制到 …\Luma Browser\Extensions\<id>（临时目录 + 改名）
             → session.loadExtension(dir, { allowFileAccess: true })
             → 每次启动重新加载（Electron 要求每次 boot 都调用）
```

实测可用的能力：内容脚本注入（原生 `WebContentsView` 页面同样生效）、后台 Service Worker、
`chrome.runtime` 双向消息、`chrome.storage.local`。不可用的能力：工具栏按钮与 `chrome.action` 弹窗、
`declarativeNetRequest`、Web Store 一键安装、`chrome.identity` / `sidePanel` / `commands`。
因此扩展管理器在界面上直接标注这些边界，避免用户装了密码管理器却找不到入口。

## 三、界面

| 维度 | 本次调整 |
| --- | --- |
| 布局 | 标签栏空白区域双击新建标签页（Chrome/搜狗一致），不再需要精确点中 `+` |
| 交互 | `Ctrl+Tab` / `Ctrl+Shift+Tab`（以及 `Ctrl+PageDown/PageUp`）循环切换标签，属于浏览器固定快捷键，不进入可配置表 |
| 交互 | 内存紧张时自动休眠后台标签并给出提示，而不是让系统整体卡顿 |
| 视觉 | 沿用既有设计令牌（色板、阴影、焦点环、`prefers-reduced-motion` 降级），不引入新的视觉语言；新交互复用相同的过渡时长与焦点样式 |

视觉上刻意没有大改：现有界面已经有完整的浅/深色令牌、`focus-visible` 焦点环和动效降级，
贸然换视觉语言会让用户重新学习界面。真正缺的是 Chrome 的“标签固定 / 标签组”，见下节。

## 四、与主流的差距（明确定位）

| 能力 | Chrome / Edge | Luma 现状 | 判断 |
| --- | --- | --- | --- |
| 站点隔离 | 每站点独立进程 | 每标签独立进程（Chromium 默认站点隔离） | 够用 |
| 标签固定/标签组 | 有 | 无 | 下一步候选 |
| 标签页搜索面板 | 有（Ctrl+Shift+A） | 有“全部标签页”总览 | 够用 |
| 阅读清单/侧边栏 | 有 | 无 | 非核心 |
| 密码/自动填充 | 系统钥匙串 + 同步 | safeStorage 本地库 + 隔离世界填充 | 够用，缺同步 |
| 后台更新服务 | 常驻 omaha | 应用运行时才检查 | 可接受 |
| 多版本并存与回滚 | 版本目录 + 指针 | 覆盖安装 + 保留上一版安装包 | 已等价 |

## 五、验证

- 单元/界面测试 61 项（新增 9 项：会话管线、设置校验、版本命名、路径迁移）
- Electron 端到端 44 项（新增 1 项：`Ctrl+Tab` 循环与空白区双击新建）
- Web 预览层 5 项
- 打包冒烟：安装包启动后能加载真实网页
