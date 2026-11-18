# 目录布局、文件命名与更新流程：主流浏览器的做法与本项目的落地

本文先记录对两套真实安装的实测结论，再提炼通用做法，最后给出 Luma Browser 的对照与改动。
Luma 的改动集中在三处：`electron/appPaths.cjs`（目录）、`electron/versioning.cjs` 与
`package.json`（命名）、`electron/updater.cjs`（更新流程）。

## 一、实测记录

### 1. Google Chrome 157.0.8103.50

```text
C:\Program Files\Google\Chrome\Application\
├─ chrome.exe                          4.1 MB   启动器，固定名字与位置
├─ chrome_proxy.exe                    2.6 MB
├─ chrome.VisualElementsManifest.xml   410 B    开始菜单磁贴，指向版本目录里的图标
├─ SetupMetrics\                                 安装与更新计数，空目录也存在
└─ 157.0.8103.50\                     435 MB   真实程序
   ├─ 157.0.8103.50.manifest          226 B    SxS 清单，绑定 chrome_elf.dll
   ├─ chrome.dll                       311 MB
   ├─ *.pak / icudtl.dat / Locales\ / WidevineCdm\ / Extensions\
   └─ Installer\setup.exe              8.1 MB   安装与卸载都由这里执行

%LOCALAPPDATA%\Google\Chrome\User Data\
├─ Local State            浏览器级状态
├─ Last Version           上次运行的版本号，用于判断是否需要迁移
├─ Default\               Cookie、历史、书签、密码
├─ Crashpad\              崩溃转储
└─ BrowserMetrics\        运行指标
```

要点：

- **程序目录只放程序，用户数据完全不在这里**，且落在 `LOCALAPPDATA`（漫游配置不参与同步）。
- 根目录的 `chrome.exe` 是稳定入口；真实二进制在版本号目录里。升级 = 写入新版本目录 + 切换指针，
  旧目录保留即可回滚，失败时不会出现"半新半旧"的程序。
- 版本目录自带 `.manifest`（Win32 程序集清单），把 `chrome_elf.dll` 这类组件的版本固定在自己目录内，
  避免 DLL 搜索顺序把新版本拖进旧版本的目录。
- 启动器无需知道版本号：`Last Version` 与注册表里的 `BLBeacon\version` 记录当前版本。

### 2. 搜狗浏览器 13.9.6121.400

```text
D:\Sogou\SogouExplorer\
├─ SogouExplorer.exe                   1.9 MB   启动器
├─ uninst.exe                          824 KB   卸载器与程序同目录
├─ TxBugReport.exe / app_sogou.ico
└─ 13.9.6121.400\                     336 MB
   ├─ 13.9.6121.400.manifest         231 B    外壳版本清单
   ├─ 1.116.493.400.manifest         226 B    内核版本清单（独立的 Chromium 版本线）
   ├─ SogouExplorer.exe                    真正的浏览器进程
   ├─ chrome.dll                     212 MB
   ├─ SogouExplorerLiveup.exe        2.0 MB   增量/热更新
   ├─ QBDelayUpdate.exe              1.8 MB   延迟更新：下次启动或退出时应用
   ├─ SogouExplorerFix.exe           937 KB   修复安装
   ├─ WidevineCdm\ / data\ / extensions\ / locales\
```

要点：

- 与 Chrome 同构：**根目录稳定启动器 + 版本目录**，卸载器放程序目录。
- 更新不是一个 exe 干完：`Liveup` 负责取包与打补丁，`QBDelayUpdate` 负责在合适时机应用，
  `Fix` 负责把损坏的安装修回来。更新是后台行为，用户几乎感觉不到。
- 外壳与内核**分开版本、分开清单、分开更新**，内核可以单独升级而不动外壳。
- 反面例子：`debug.log`（5.4 MB）直接写在程序目录里，长期运行后会混在安装目录中。

## 二、通用做法（8 条）

1. **入口稳定、实现可切**：根目录放固定名字的启动器，真实程序按版本分目录存放。
2. **程序与数据分离**：程序目录只读，用户数据放 `%LOCALAPPDATA%\<Vendor>\<Product>\User Data`。
3. **命名可预测**：可执行文件用产品名且**不含空格**（`chrome.exe`、`msedge.exe`、
   `SogouExplorer.exe`）；安装包带产品、版本、架构；缓存与日志用固定文件名。
4. **更新三段式**：检查（节流轮询）→ 后台下载（校验）→ 延迟应用（退出或下次启动），
   不打断用户的浏览。
5. **原子替换与回滚**：新版本完整落盘后再切换，保留上一版；失败不破坏当前可用版本。
6. **缓存与日志独立**：下载包、`update.log`、崩溃转储都不写在程序目录。
7. **多通道**：稳定版 / 测试版由清单文件（`latest.yml`、`update.json`）驱动，客户端只认清单。
8. **per-user 安装 + 卸载器同目录**：免管理员、可自选目录、快捷方式可选。

## 三、Luma Browser 改动前的问题

| 维度 | 主流做法 | 1.13 现状 | 结论 |
| --- | --- | --- | --- |
| 入口命名 | `chrome.exe`、`SogouExplorer.exe`，无空格 | `Luma Browser.exe` | 改名 |
| 用户数据 | `%LOCALAPPDATA%\...\User Data` | `%APPDATA%\Luma Browser`（漫游） | 迁移 |
| 更新包落盘 | 固定更新目录，可复用 | `%TEMP%`，重启后可能被清理 | 改目录 |
| 更新触发 | 后台轮询 + 自动下载 | 启动 8 秒检查一次，必须手动下载 | 补轮询与预下载 |
| 应用时机 | 退出/下次启动静默安装 | 只能点"重启并安装" | 增加延迟安装 |
| 回滚 | 保留上一版本 | 新包直接覆盖下载 | 保留上一版 |
| 排障 | `update.log` | 无日志 | 增加 |
| 安装包命名 | 产品-版本-架构 | `Luma-Browser-Setup-1.13.0.exe` | 加架构后缀 |

## 四、本次落地

### 1. 目录（`electron/appPaths.cjs`）

```text
<安装目录>\                      LumaBrowser.exe、resources\app.asar、locales\
%LOCALAPPDATA%\Luma Browser\
├─ User Data\                    配置、Cookie、书签、密码（与 Chrome 同名）
│  └─ layout.json                迁移标记，避免重复迁移
└─ Update\
   ├─ update.json                上次检查时间、偏好、待安装包、上一版包
   ├─ update.log                 更新日志（超过 512 KB 轮转为 update.log.1）
   └─ packages\
      ├─ Luma-Browser-Setup-1.14.0-x64.exe
      └─ previous\               上一版安装包，回滚用
```

- 首次启动把 `%APPDATA%\Luma Browser` **移动**到新位置（同盘 rename，瞬间完成）；
  跨盘或文件被占用时退化为"复制状态文件、跳过缓存目录"，原目录保持不动。
- 显式传入 `--user-data-dir`（测试、便携运行、`LUMA_USER_DATA_DIR`）时完全遵循环调用方，
  不会触碰默认目录。
- 单实例锁在 `userData` 内，路径必须在 `requestSingleInstanceLock()` 之前确定。

### 2. 命名

| 对象 | 规则 | 示例 |
| --- | --- | --- |
| 主程序 | 产品名、PascalCase、无空格 | `LumaBrowser.exe` |
| 安装包 | `Luma-Browser-Setup-<version>-<arch>.exe` | `Luma-Browser-Setup-1.14.0-x64.exe` |
| 更新清单 | `latest.yml`（electron-builder 生成） | — |
| 校验清单 | `checksums.txt`，SHA256 大写 | 随 `npm run dist` 生成 |
| 更新状态 | `update.json` | 检查时间、偏好、pending、previous |
| 更新日志 | `update.log` | 滚动保留一份旧日志 |
| 桌面快捷方式 | 仍显示产品名 | `Luma Browser` |

旧版本（≤1.13）的安装包名 `Luma-Browser-Setup-1.13.0.exe` 仍可被识别：
更新器会依次探测新名、旧名，再退到 GitHub API 的资产列表。

### 3. 更新流程（`electron/updater.cjs`）

```text
启动 8 秒 ──▶ 检查（HTML 发布页 → REST API 兜底）
              │
              ├─ 无新版本 ──▶ not-available，记录 lastCheckedAt
              └─ 有新版本 ──▶ available
                               │
        每 4 小时轮询 ─────────┤ autoDownload=true 时后台下载到 Update\packages
                               ▼
                            downloaded（写入 update.json 的 pending）
                               │
             ┌─────────────────┴──────────────────┐
     用户点"重启并安装"                     关闭最后一个窗口
   /S --force-run，装完自动重启          /S 静默安装（QBDelayUpdate 等价）
                               ▼
                     下次启动：reconcile() 清理已应用/已过期的包
```

- **校验**：直连记录下载内容的 SHA256；镜像线路必须与 GitHub 公布的 `digest` 一致，否则删包报错。
- **回滚**：新包落盘时把上一个 `pending` 移到 `packages\previous\`，出问题可手工装回。
- **幂等**：`reconcile()` 在构造时执行；`pending` 版本 ≤ 当前版本、或文件丢失，都会清理，
  避免"反复安装同一个版本"。
- **不重复安装**：立即安装已经拉起安装器后，`will-quit` 里的延迟安装会被跳过。

### 4. 可观察性

设置 → 数据与关于新增"存储位置"，显示程序目录 / 用户数据 / 更新日志三处路径；
软件更新卡片新增两个开关（后台自动下载、退出时自动安装）与"已下载待安装"的明确提示。

## 五、仍未对齐的部分

- **版本目录切换**：Chrome/搜狗用 `Application\<version>\` 目录做原子切换。Electron 的 NSIS 安装器
  是覆盖式安装，做版本目录需要独立的原生启动器（stub）解析版本指针。当前以"保留上一版安装包"
  达到等价的可回滚目标，代码量小得多；若将来要做多版本共存，再引入启动器。
- **独立更新进程**：Chrome 有常驻的 omaha 更新服务，搜狗有独立的 Liveup 进程。Luma 的更新在主进程内，
  应用不运行时不检查更新。
- **代码签名**：三者都签名，Luma 尚未配置证书，SmartScreen 会提示"未知发布者"。
