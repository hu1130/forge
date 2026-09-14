import { randomUUID } from "node:crypto";

export interface EmailDelivery {
  sendEmailVerification(email: string, verificationUrl: string): Promise<void>;
  sendPasswordReset(email: string, resetUrl: string): Promise<void>;
  sendTenantInvitation(email: string, teamName: string, inviterName: string, invitationUrl: string): Promise<void>;
}

interface ResendEmailDeliveryOptions {
  apiKey: string;
  from: string;
  endpoint?: string;
}

export class ResendEmailDelivery implements EmailDelivery {
  private readonly endpoint: string;

  constructor(private readonly options: ResendEmailDeliveryOptions) {
    if (!options.apiKey.trim()) throw new Error("Resend API Key 不能为空");
    if (!options.from.trim()) throw new Error("邮件发件人不能为空");
    this.endpoint = options.endpoint || "https://api.resend.com/emails";
  }

  private async send(to: string, subject: string, text: string) {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
        "user-agent": "Forge-Cloud/0.19.0",
      },
      body: JSON.stringify({ from: this.options.from, to: [to], subject, text }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error(`邮件服务返回 ${response.status}`);
  }

  async sendEmailVerification(email: string, verificationUrl: string) {
    await this.send(email, "验证你的 Forge 邮箱", `请在 24 小时内打开下面的链接完成邮箱验证：\n\n${verificationUrl}\n\n如果不是你创建的账户，可以忽略这封邮件。`);
  }

  async sendPasswordReset(email: string, resetUrl: string) {
    await this.send(email, "重置你的 Forge 密码", `请在 30 分钟内打开下面的链接设置新密码：\n\n${resetUrl}\n\n如果不是你发起的操作，可以忽略这封邮件。`);
  }

  async sendTenantInvitation(email: string, teamName: string, inviterName: string, invitationUrl: string) {
    await this.send(email, `加入 ${teamName}`, `${inviterName} 邀请你加入 Forge 团队“${teamName}”。请在 7 天内登录并接受邀请：\n\n${invitationUrl}\n\n只有与 ${email} 匹配且已验证的账户可以接受。`);
  }
}

export class ConsoleEmailDelivery implements EmailDelivery {
  async sendEmailVerification(email: string, verificationUrl: string) {
    console.log(`[Forge Cloud development email] verify ${email}: ${verificationUrl}`);
  }

  async sendPasswordReset(email: string, resetUrl: string) {
    console.log(`[Forge Cloud development email] reset ${email}: ${resetUrl}`);
  }

  async sendTenantInvitation(email: string, teamName: string, inviterName: string, invitationUrl: string) {
    console.log(`[Forge Cloud development email] invite ${email} to ${teamName} by ${inviterName}: ${invitationUrl}`);
  }
}
