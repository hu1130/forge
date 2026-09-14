import type { ForgeReleaseInfo } from "./desktop";

export const DEVELOPMENT_LEGAL_VERSION = "2026-09-14";
export type LegalDocumentKind = "terms" | "privacy";

function publisher(info: ForgeReleaseInfo) {
  return info.publisherName || "尚未配置的 Forge 发行主体";
}

function contact(info: ForgeReleaseInfo) {
  return info.privacyContact || "购买或下载渠道提供的联系方式";
}

export function LegalDocument({ kind, releaseInfo }: { kind: LegalDocumentKind; releaseInfo: ForgeReleaseInfo }) {
  if (kind === "terms") {
    return <article className="legal-document" aria-labelledby="forge-terms-title">
      <header><div><span>版本 {releaseInfo.legalVersion}</span><h4 id="forge-terms-title">Forge 用户协议</h4></div><em>{publisher(releaseInfo)}</em></header>
      <section><h5>1. 软件与许可</h5><p>Forge 是在用户电脑上运行的 AI 编程工作台。发行方向合法取得软件的用户提供有限、不可转让的使用许可；具体设备数量、期限、费用和退款规则以购买页面或书面订单为准。</p></section>
      <section><h5>2. 用户账户与模型服务</h5><p>用户应使用自己有权使用的模型 API 账户和密钥，并自行承担模型服务商产生的费用。Forge 不销售 DeepSeek 或其他模型额度，也不保证第三方服务持续可用。</p></section>
      <section><h5>3. 代码和命令操作</h5><p>Agent 可能读取工作区文件、修改代码和执行命令。Forge 提供工作区边界、审批和 Diff，但用户仍应在执行前审查高风险操作，并对源代码保留独立备份。</p></section>
      <section><h5>4. 合法使用</h5><p>用户不得利用 Forge 侵害他人权益、绕过访问控制、传播恶意代码或从事违反适用法律及第三方服务条款的活动。</p></section>
      <section><h5>5. 更新与第三方组件</h5><p>软件可能通过手动或自动方式提供更新。Forge 包含按各自许可证分发的第三方组件，完整许可和归属信息可在“关于 Forge”中查看。</p></section>
      <section><h5>6. 风险与支持</h5><p>生成式 AI 结果可能不准确、不完整或带来代码缺陷。用户应在提交、部署或交付前自行测试和审查。支持范围与责任限制以购买渠道公布的最终商业条款为准。</p></section>
      <footer>协议联系：{contact(releaseInfo)}</footer>
    </article>;
  }

  return <article className="legal-document" aria-labelledby="forge-privacy-title">
    <header><div><span>版本 {releaseInfo.legalVersion}</span><h4 id="forge-privacy-title">Forge 隐私说明</h4></div><em>{publisher(releaseInfo)}</em></header>
    <section><h5>1. 本机保存的数据</h5><p>工作区路径、任务记录、对话、命令输出、Diff、Skill 和 MCP 配置默认保存在用户电脑。DeepSeek API Key 与 MCP Token 通过当前 Windows 用户的安全存储加密。</p></section>
    <section><h5>2. 模型请求</h5><p>用户发送任务时，指令及完成任务所需的上下文会发送给用户选择的模型服务商，并受该服务商隐私政策约束。Forge 不会使用发行方的共享 API Key 代替用户账户。</p></section>
    <section><h5>3. 可选 Cloud 功能</h5><p>只有用户主动登录 Cloud 时，账户邮箱、会话、团队关系和安全目录元数据才会发送到 Cloud API。任务备份在本机加密后上传，服务端不接收备份口令或明文。</p></section>
    <section><h5>4. 诊断信息</h5><p>诊断文件仅在用户主动导出时生成，包含版本、系统、运行状态和脱敏生命周期记录，不包含 API Key、Token、账户身份、工作区路径、任务或对话内容。</p></section>
    <section><h5>5. 权限与删除</h5><p>用户可以删除本机任务、扩展和凭据；卸载软件不会默认删除用户数据，避免升级或误卸载造成资料丢失。正式 Cloud 服务的数据访问、导出和删除方式将在上线前单独公布。</p></section>
    <section><h5>6. 联系方式</h5><p>关于个人信息、更正、删除或安全问题，请通过 {contact(releaseInfo)} 联系发行方。</p></section>
  </article>;
}
