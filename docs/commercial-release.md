# Forge 本机商业版发布清单

这份清单用于本机 BYOK 版本。Forge 只销售软件使用权，用户使用自己的模型 API 账户；Cloud SaaS、订阅计费和激活服务器不在 0.23 范围内。

## 1. 填写真实发行信息

编辑 `apps/desktop/release-profile.json`：

```json
{
  "schemaVersion": 1,
  "legalVersion": "2026-09-14",
  "publisherName": "真实个人或企业名称",
  "privacyContact": "support@example.com",
  "supportUrl": "https://example.com/support",
  "updateManifestUrl": "https://example.com/forge/stable.json"
}
```

不得使用虚构公司名称、联系方式或域名。协议正文是产品技术边界草案；公开销售前应由实际发行方根据销售地区、退款承诺和主体身份完成法律审阅。修改协议后同步更新 `legalVersion`，已安装客户端会要求用户重新确认。

## 2. 发布更新清单

`updateManifestUrl` 返回不超过 64KB 的 JSON：

```json
{
  "version": "0.23.0",
  "downloadUrl": "https://example.com/downloads/Forge-Setup-0.23.0.exe",
  "sha256": "安装包的六十四位十六进制 SHA-256",
  "releaseNotes": "本次版本的简短说明"
}
```

正式地址必须使用 HTTPS。先上传并签名安装包，计算最终 SHA-256，再更新清单；不要让清单指向会被原地替换但版本号不变的文件。

## 3. 构建和发布检查

```powershell
pnpm test
pnpm typecheck
pnpm test:ui
pnpm dist:win
pnpm release:verify:commercial
```

商业检查要求各应用版本一致、资源和许可证完整、发行资料齐全、安装包版本正确且 Authenticode 状态为 `Valid`。

## 4. 干净 Windows 虚拟机升级验收

脚本会真实安装和卸载 Forge，只能在可随时还原的干净 Windows 虚拟机运行：

```powershell
$env:FORGE_CLEAN_VM = "1"
pnpm release:test-upgrade -- `
  -PreviousInstaller "C:\Release\Forge-Setup-0.22.1.exe" `
  -CurrentInstaller "C:\Release\Forge-Setup-0.23.0.exe"
```

内部未签名构建可临时附加 `-AllowUnsigned`，但该结果不能作为商业验收。脚本使用 `%LOCALAPPDATA%\ForgeUpgradeVerification` 和 `%LOCALAPPDATA%\ForgeUpgradeVerificationData`，验证完成后只清理这两个精确目录。

至少分别在干净 Windows 10 和 Windows 11 快照中执行一次，并人工检查开始菜单、桌面快捷方式、卸载列表、SmartScreen/发布者名称和协议确认界面。
