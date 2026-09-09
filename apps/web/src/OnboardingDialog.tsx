import { useEffect, useRef } from "react";
import { Check, FolderOpen, KeyRound, LoaderCircle, ShieldCheck, Sparkles, X } from "lucide-react";

interface OnboardingDialogProps {
  workspacePath: string;
  apiKeyDraft: string;
  apiKeySaving: boolean;
  apiKeyTesting: boolean;
  apiKeyMessage: string;
  apiKeyTone: "neutral" | "success" | "error";
  encryptedStorageAvailable: boolean | null;
  onApiKeyDraftChange: (value: string) => void;
  onChooseWorkspace: () => void;
  onTestApiKey: () => void;
  onSaveApiKey: () => void;
  onSkip: () => void;
}

export default function OnboardingDialog(props: OnboardingDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        props.onSkip();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
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
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [props.onSkip]);

  const busy = props.apiKeySaving || props.apiKeyTesting;

  return <div className="onboarding-backdrop">
    <section ref={dialogRef} className="onboarding-dialog" role="dialog" aria-modal="true" aria-labelledby="onboarding-title" aria-describedby="onboarding-description">
      <header>
        <div className="onboarding-mark"><Sparkles size={21} /></div>
        <div><span>首次使用</span><h2 id="onboarding-title">三步开始使用 Forge</h2><p id="onboarding-description">选择代码目录并连接 DeepSeek，之后直接用自然语言描述开发任务。</p></div>
        <button ref={closeRef} className="icon-button" type="button" aria-label="稍后配置" onClick={props.onSkip}><X size={17} /></button>
      </header>

      <ol className="onboarding-steps">
        <li className="step-complete"><span><Check size={14} /></span><div><strong>本机运行时已就绪</strong><small>Daemon、Codex CLI 与安全会话均在本机运行。</small></div></li>
        <li><span>2</span><div><strong>选择工作区</strong><small title={props.workspacePath}>{props.workspacePath}</small></div><button type="button" onClick={props.onChooseWorkspace}><FolderOpen size={15} />选择文件夹</button></li>
        <li className="onboarding-key-step"><span>3</span><div><strong>连接 DeepSeek</strong><small>密钥只使用当前 Windows 用户凭据加密保存。</small></div>
          <div className="onboarding-key-form">
            <label htmlFor="onboarding-deepseek-key">DeepSeek API Key</label>
            <input id="onboarding-deepseek-key" type="password" autoComplete="off" value={props.apiKeyDraft} onChange={(event) => props.onApiKeyDraftChange(event.target.value)} placeholder="sk-…" aria-describedby="onboarding-key-status" />
            <div className="onboarding-key-actions">
              <button type="button" disabled={busy || props.encryptedStorageAvailable === false} onClick={props.onTestApiKey}>{props.apiKeyTesting ? <LoaderCircle className="spin" size={14} /> : <ShieldCheck size={14} />}{props.apiKeyTesting ? "测试中…" : "测试连接"}</button>
              <button className="onboarding-primary" type="button" disabled={busy || props.encryptedStorageAvailable === false || !props.apiKeyDraft.trim()} onClick={props.onSaveApiKey}>{props.apiKeySaving ? <LoaderCircle className="spin" size={14} /> : <KeyRound size={14} />}{props.apiKeySaving ? "保存中…" : "保存并开始"}</button>
            </div>
            <p id="onboarding-key-status" className={`onboarding-feedback feedback-${props.apiKeyTone}`} role={props.apiKeyTone === "error" ? "alert" : "status"}>{props.apiKeyMessage || (props.encryptedStorageAvailable === false ? "Windows 加密存储不可用，暂时无法保存密钥。" : "测试连接不会发起模型对话，也不会消耗输出 Token。")}</p>
          </div>
        </li>
      </ol>

      <footer><p>暂时没有 API Key？可以先检查界面和事件流。</p><button type="button" onClick={props.onSkip}>先使用演示模式</button></footer>
    </section>
  </div>;
}
