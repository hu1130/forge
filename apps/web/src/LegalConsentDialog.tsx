import { useEffect, useRef, useState } from "react";
import { FileCheck2, LoaderCircle, ShieldCheck } from "lucide-react";
import type { ForgeReleaseInfo } from "./desktop";
import { LegalDocument, type LegalDocumentKind } from "./LegalDocuments";

export default function LegalConsentDialog({ releaseInfo, onAccept }: {
  releaseInfo: ForgeReleaseInfo;
  onAccept: () => Promise<void>;
}) {
  const [documentKind, setDocumentKind] = useState<LegalDocumentKind>("terms");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLElement>(null);
  const firstTabRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    firstTabRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      )].filter((element) => element.offsetParent !== null);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const accept = async () => {
    if (!confirmed || busy) return;
    setBusy(true);
    setError("");
    try { await onAccept(); } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };

  return <div className="legal-consent-backdrop">
    <section ref={dialogRef} className="legal-consent-dialog" role="dialog" aria-modal="true" aria-labelledby="legal-consent-title" aria-describedby="legal-consent-description">
      <header><div className="legal-consent-mark"><FileCheck2 size={20} /></div><div><span>首次使用确认</span><h2 id="legal-consent-title">使用 Forge 前，请阅读协议</h2><p id="legal-consent-description">协议记录只保存在当前电脑；版本变化后会再次提示。</p></div></header>
      {!releaseInfo.publisherName && <div className="legal-draft-warning" role="note"><ShieldCheck size={16} /><span><strong>当前是预发布协议</strong><small>发行主体与联系方式尚未配置，不可作为公开销售版本。</small></span></div>}
      <div className="legal-document-tabs" role="tablist" aria-label="协议文档">
        <button ref={firstTabRef} type="button" role="tab" aria-selected={documentKind === "terms"} className={documentKind === "terms" ? "active" : ""} onClick={() => setDocumentKind("terms")}>用户协议</button>
        <button type="button" role="tab" aria-selected={documentKind === "privacy"} className={documentKind === "privacy" ? "active" : ""} onClick={() => setDocumentKind("privacy")}>隐私说明</button>
      </div>
      <div className="legal-consent-scroll"><LegalDocument kind={documentKind} releaseInfo={releaseInfo} /></div>
      <footer>
        <label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>我已阅读并接受《Forge 用户协议》和《Forge 隐私说明》</span></label>
        {error && <p role="alert">{error}</p>}
        <button type="button" disabled={!confirmed || busy} onClick={() => void accept()}>{busy ? <LoaderCircle className="spin" size={15} /> : <FileCheck2 size={15} />}{busy ? "正在保存…" : "同意并继续"}</button>
      </footer>
    </section>
  </div>;
}
