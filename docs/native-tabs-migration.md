# 原生标签页迁移（WebContentsView）

## 目标

让标签拆分与 Chrome/Edge 一致：

- 拖动标签时页面视图跟随，松手后进入新窗口；
- 新窗口和原窗口的所有标签都保持运行，不重新加载；
- 标签栏、工具栏、菜单、阅读模式、页内查找、截图等现有功能不回退。

Electron 的 `<webview>` 无法把已加载的 guest 交给另一个窗口（guest 归属嵌入它的窗口）。
`WebContentsView` 可以：从窗口 A 的 `contentView` 移除，再挂到窗口 B，页面不重新加载。
迁移的核心就是把每个标签从 `<webview>` 换成主进程持有的 `WebContentsView`。

## 当前状态

迁移已完成（1.8.0）：渲染层、事件、浮层与拆分搬运全部切换到原生视图，`<webview>` 路径已移除。

- ✅ **第 1 阶段：页面视图层**
  - `electron/pageViews.cjs`：每个标签一个 `WebContentsView`，支持 create/attach/detach/bounds/visible/destroy、跨窗口移动。
  - 事件：start/stop/navigate/title/favicon/fail/ready/audio/find/context-menu/new-window/render-gone/password。
  - 命令：load/back/forward/reload/stop/focus/executeJavaScript/insertCSS/findInPage/zoom/audio。
  - IPC：`page-view:*`，preload 暴露 `window.lumaDesktop.pageView` 与 `onPageEvent`。
  - 验证：`npm run verify:pageviews` 在真实应用里加载 example.com，写入 `window.__marker`，
    把视图移到第二个窗口后读取，marker/URL/标题全部保留。
  - 界面走 `<webview>`，现有功能零改动、可随时回退。

- ✅ **第 2 阶段：渲染层页面宿主**
  - `src/components/browser/PageHostLayer.tsx` 只负责上报页面区域矩形，主进程据此摆放原生视图。
  - `src/app/pageHandle.ts` 把页面能力收敛为 `PageHandle`（缩放、字体、静音、查找、前进后退、编辑、截图）。
  - App 通过 `onPageEvent` 接收加载、标题、图标、失败、音频、查找、新窗口、密码等事件。

- ✅ **第 3 阶段：浮层**
  - 菜单、侧边面板、对话框、阅读模式、框选截图打开时：截取一帧作为占位并隐藏页面视图。
  - 页内查找：页面视图下移 52px 让出查找栏；内置开发者工具：页面视图右侧让出面板宽度。

- ✅ **第 4 阶段：拆分搬运**
  - 拆分时新窗口在落点创建，主进程把被拖出的页面 `attach` 到新窗口；原窗口保留其余页面。
  - 合并时把页面 `attach` 到目标窗口，再让目标窗口接管标签；两处都不发生重新加载。

## 后续阶段

### 第 2 阶段：渲染层页面宿主

- 新增 `PageHost`：页面区域只渲染占位 div，把 `getBoundingClientRect()` 同步给主进程；
  激活标签 `attach`，切走 `detach`（保留页面），关闭标签 `destroy`。
- 事件转发到现有回调（onStart/onStop/onNavigate/onTitle/onFavicon/onFail/onAudio/onFoundInPage）。
- 把 App 里 ~40 处 `webviews.current.get(id).xxx` 换成 `pageApi.xxx`（IPC 封装）。
- 保留一个 `nativePages` 开关，先在测试里跑通再切默认。

### 第 3 阶段：浮层

原生视图会盖住页面区域里的 HTML 浮层，需要逐类处理：

- 页面右键菜单、翻译授权、权限询问、密码提示、添加书签、标签总览：打开时隐藏页面视图，
  用最近一帧截图铺底，避免闪白。
- 页内查找：把页面视图底边缩让出查找栏高度，保持页面可见以便高亮。
- 阅读模式：隐藏页面视图（现有逻辑已如此）。
- 框选截图：隐藏视图 + 截图铺底，选区画在截图上。
- 地址栏/工具栏弹出的菜单：打开期间隐藏页面视图 + 截图铺底。
- 链接/文件拖放到页面：改由 guest 侧转发 drop，或在拖动期间临时显示一个 HTML 投放层。

### 第 4 阶段：拆分搬运

- 拆分时不再“移动窗口 + 新建其余标签”：新窗口创建后 `page-view:move` 把当前标签的视图挂过去，
  原窗口保留其余视图，两个窗口的页面都保持运行。
- 合并：目标窗口接管视图与标签状态。

### 第 5 阶段：清理与测试

- 移除 `<webview>` 渲染路径与 DesktopWebView；迁移 e2e 中 21 处 `webview` 断言到 `page-view:info`。
- 补齐：密码捕获（guest preload 需要同时支持 `sendToHost` 与主进程 IPC）、DevTools 嵌入、标签预览截图。

## 验证

```bash
npm run verify:pageviews   # 原生视图跨窗口搬运，页面不刷新
npm test                   # 39 项
npm run test:electron      # 40 项
```
