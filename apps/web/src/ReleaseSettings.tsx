import { useState } from "react";
import { Check, Download, ExternalLink, FileText, Info, LoaderCircle, RefreshCw, ShieldAlert } from "lucide-react";
import type { ForgeReleaseInfo, ForgeUpdateResult } from "./desktop";
import { LegalDocument, type LegalDocumentKind } from "./LegalDocuments";

export default function ReleaseSettings({ releaseInfo }: { releaseInfo: ForgeReleaseInfo }) {
  const [documentKind, setDocumentKind] = useState<LegalDocumentKind>("terms");
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateResult, setUpdateResult] = useState<ForgeUpdateResult | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const checkUpdates = async () => {
    if (!window.forgeDesktop?.checkForUpdates) {
      setError("检查更新仅在 Forge 桌面版中可用。");
      return;
    }
    setUpdateBusy(true);
    setMessage("");
    setError("");
    try {
      const result = await window.forgeDesktop.checkForUpdates();
      setUpdateResult(result);
      setMessage(result.status === "unconfigured" ? "发行版尚未配置更新服务。" : result.status === "upToDate" ? "当前已经是最新版本。" : `发现 Forge ${result.version}。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setUpdateBusy(false);
    }
  };

  const openUpdate = async () => {
    setError("");
    try { await window.forgeDesktop?.openAvailableUpdate(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const openLicenses = async () => {
    setError("");
    try {
      if (!window.forgeDesktop?.openThirdPartyLicenses) throw new Error("第三方许可证目录仅在 Forge 桌面版中可用。");
      await window.forgeDesktop.openThirdPartyLicenses();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  return <>
    <div className="settings-intro"><h4>关于 Forge</h4><p>查看版本、发行信息、更新状态和随软件分发的法律文档。</p></div>
    <div className="release-summary-grid">
      <section><Info size={18} /><span><small>当前版本</small><strong>{releaseInfo.version}</strong></span><em><Check size={12} />本机版</em></section>
      <section className={releaseInfo.publisherName && releaseInfo.privacyContact ? "" : "release-warning"}><ShieldAlert size={18} /><span><small>发行主体</small><strong>{releaseInfo.publisherName || "尚未配置"}</strong></span><em>{releaseInfo.privacyContact || "缺少联系方式"}</em></section>
    </div>

    <section className="release-update" aria-labelledby="release-update-title">
      <div><h4 id="release-update-title">软件更新</h4><p>{releaseInfo.updateConfigured ? "从发行方配置的 HTTPS 清单检查新版本，不会自动下载安装。" : "当前构建没有更新清单地址，检查时会明确返回未配置。"}</p></div>
      <button type="button" disabled={updateBusy} onClick={() => void checkUpdates()}>{updateBusy ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}{updateBusy ? "正在检查…" : "检查更新"}</button>
      {(message || error) && <p className={error ? "release-error" : "release-success"} role={error ? "alert" : "status"}>{error || message}</p>}
      {updateResult?.status === "available" && <div className="release-available"><span><strong>Forge {updateResult.version}</strong><small>{updateResult.releaseNotes || "发行方未提供版本说明。"}</small><code>SHA-256 {updateResult.sha256}</code></span><button className="primary-small" type="button" onClick={() => void openUpdate()}><Download size={14} />打开下载页</button></div>}
    </section>

    <section className="release-legal" aria-labelledby="release-legal-title">
      <div className="release-section-heading"><div><h4 id="release-legal-title">协议与隐私</h4><p>当前接受版本：{releaseInfo.legalVersion}</p></div><div className="legal-document-tabs" role="tablist" aria-label="关于页面法律文档"><button type="button" role="tab" aria-selected={documentKind === "terms"} className={documentKind === "terms" ? "active" : ""} onClick={() => setDocumentKind("terms")}>用户协议</button><button type="button" role="tab" aria-selected={documentKind === "privacy"} className={documentKind === "privacy" ? "active" : ""} onClick={() => setDocumentKind("privacy")}>隐私说明</button></div></div>
      <LegalDocument kind={documentKind} releaseInfo={releaseInfo} />
    </section>

    <section className="release-licenses"><FileText size={18} /><div><strong>第三方许可证</strong><p>查看 Codex、Electron 及随安装包分发组件的许可与归属信息。</p></div><button type="button" onClick={() => void openLicenses()}><ExternalLink size={14} />打开许可证目录</button></section>
  </>;
}
