# 代码签名

当前状态：**未签名**。仓库里没有证书，`npm run dist` 产出的安装包会被 Windows SmartScreen 提示"未知发布者"。
本文说明为什么会这样、两条可行的签名路线，以及拿到证书后需要改哪里。

## 为什么需要签名

| 影响 | 未签名 | 已签名 |
| --- | --- | --- |
| 首次安装 | SmartScreen "未知发布者"，需要点"更多信息 → 仍要运行" | 显示发布者名称，直接可安装 |
| 下载信任 | 浏览器/杀软可能拦截 | 通常不拦截 |
| 更新链 | 我们靠 SHA256 校验完整性（见下） | 同样校验，但多了 Authenticode 身份 |
| 企业分发 | 多数域策略禁止 | 可加入白名单 |

需要说明的是：Luma 的自动更新**已经**在下载后校验 SHA256（镜像线路还会对照 GitHub 公布的 digest），
所以"更新包被篡改"这件事与签名无关；签名解决的是**安装那一刻的信任**。

## 路线 A：PFX 证书（一次性购买）

适合个人与小团队，成本低于 EV 证书。

1. 购买代码签名证书（Certum Open Source Code Signing、Sectigo、SSL.com 等），拿到 `.pfx` 与密码。
2. 本地打包前设置环境变量（不要提交到仓库）：

```bash
export WIN_CSC_LINK="C:/secure/luma-codesign.pfx"
export WIN_CSC_KEY_PASSWORD="••••••"
npm run dist
```

`CSC_LINK` / `CSC_KEY_PASSWORD` 同样有效，electron-builder 会自动签名 exe 与卸载器。

3. 验证：

```powershell
Get-AuthenticodeSignature .\release\<version>\Luma-Browser-Setup-<version>-x64.exe | Format-List
signtool verify /pa /v .\release\<version>\Luma-Browser-Setup-<version>-x64.exe
```

签完后 `npm run dist` 末尾会打印：

```text
[signing] Will sign with pfx (certificate file from WIN_CSC_LINK)
[signing] Luma-Browser-Setup-….exe: Valid
```

## 路线 B：Azure Trusted Signing（按月的云签名）

不需要保管私钥，适合团队与 CI。要求 Azure 订阅与组织验证。

1. 在 Azure 创建 Trusted Signing 账户与证书配置文件，记录 endpoint、账户名、配置文件名。
2. 在 `package.json` 的 `build.win` 中加入：

```json
"azureSignOptions": {
  "publisherName": "Your Publisher Name",
  "endpoint": "https://eus.codesigning.azure.net/",
  "codeSigningAccountName": "your-account",
  "certificateProfileName": "your-profile"
}
```

3. 设置 `AZURE_TENANT_ID`、`AZURE_CLIENT_ID`、`AZURE_CLIENT_SECRET`，然后 `npm run dist`。
4. `scripts/signing-status.mjs` 会识别到这三项并打印 `azure-trusted-signing`。

## 本仓库已经做好的部分

- `scripts/signing-status.mjs`：构建结束后检查签名状态；有凭据但产物未签名时以非零码退出，
  避免"以为签了其实没签"。
- `npm run signing:check [exe路径]`：随时查询当前环境的签名配置与实际签名状态。
- `scripts/package.mjs`：`npm run dist` 结束自动调用上面的检查。
- 文档（本文）：两条路线的环境变量与验证命令。

## 还需要你做的

1. 申请证书（路线 A 或 B）。这一步需要实名与付费，我无法代办。
2. 把凭据放进环境变量或 CI Secret，不要写进仓库。
3. 重新执行 `npm run dist`，确认 `[signing] … Valid`。

在此之前，发布页会明确标注"未配置代码签名，SmartScreen 可能提示未知发布者"，避免用户以为是安装包损坏。
