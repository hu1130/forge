import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ForgeIdentityContext, McpApprovalMode, McpServerInfo, McpTransport, SkillInfo, SkillScope } from "@forge/contracts";
import { tenantStorageKey } from "./task-store.js";

interface StoredSkill extends Omit<SkillInfo, "status" | "error"> {
  installRoot: string;
  skillPath: string;
}

export interface StoredMcpServer {
  name: string;
  tenantId: string;
  userId: string;
  transport: McpTransport;
  command?: string;
  args: string[];
  envVars: string[];
  url?: string;
  enabled: boolean;
  approvalMode: McpApprovalMode;
  useBearerToken: boolean;
  createdAt: string;
  marketplaceId?: string;
  marketplaceVersion?: string;
}

export interface MarketMcpInput {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  envVars?: string[];
  url?: string;
  approvalMode?: McpApprovalMode;
  useBearerToken?: boolean;
  marketplaceId: string;
  marketplaceVersion: string;
}

interface PersistedExtensions {
  schemaVersion: 2;
  tenantId: string;
  userId: string;
  skills: StoredSkill[];
  mcpServers: StoredMcpServer[];
}

const now = () => new Date().toISOString();
const skippedImportFolders = new Set([".git", "node_modules"]);

const localIdentity: ForgeIdentityContext = { tenantId: "local", userId: "local", mode: "local" };

function initialState(identity: ForgeIdentityContext): PersistedExtensions {
  return { schemaVersion: 2, tenantId: identity.tenantId, userId: identity.userId, skills: [], mcpServers: [] };
}

function unquote(value: string) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try { return JSON.parse(trimmed) as string; } catch { return trimmed.slice(1, -1); }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replaceAll("''", "'");
  return trimmed;
}

function frontmatterField(frontmatter: string, field: string) {
  const lines = frontmatter.split(/\r?\n/);
  const index = lines.findIndex((line) => new RegExp(`^${field}:\\s*`).test(line));
  if (index < 0) return "";
  const raw = lines[index].replace(new RegExp(`^${field}:\\s*`), "");
  if (raw !== ">" && raw !== "|") return unquote(raw);
  const values: string[] = [];
  for (const line of lines.slice(index + 1)) {
    if (!/^\s+/.test(line)) break;
    values.push(line.trim());
  }
  return values.join(raw === ">" ? " " : "\n").trim();
}

async function readSkillMetadata(sourcePath: string) {
  const info = await lstat(sourcePath);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("请选择真实的 Skill 文件夹");
  const content = await readFile(path.join(sourcePath, "SKILL.md"), "utf8").catch(() => "");
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!match) throw new Error("所选文件夹缺少有效的 SKILL.md frontmatter");
  const name = frontmatterField(match[1], "name");
  const description = frontmatterField(match[1], "description");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) throw new Error("Skill name 只能包含字母、数字、连字符和下划线");
  if (!description) throw new Error("SKILL.md 必须提供 description");
  return { name, description: description.slice(0, 800) };
}

async function validateImportTree(root: string) {
  let fileCount = 0;
  let totalBytes = 0;
  const visit = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (skippedImportFolders.has(entry.name)) continue;
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Skill 文件夹不能包含符号链接");
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) {
        const info = await lstat(target);
        fileCount += 1;
        totalBytes += info.size;
        if (fileCount > 1000 || totalBytes > 25 * 1024 * 1024) throw new Error("Skill 超过 1000 个文件或 25 MB 限制");
      }
    }
  };
  await visit(root);
}

async function copySkillTree(sourcePath: string, installRoot: string) {
  const skillPath = path.join(installRoot, "skill");
  await mkdir(installRoot, { recursive: true });
  try {
    await cp(sourcePath, skillPath, {
      recursive: true,
      errorOnExist: true,
      force: false,
      filter: (source) => !path.relative(sourcePath, source).split(path.sep).some((part) => skippedImportFolders.has(part)),
    });
    return skillPath;
  } catch (error) {
    await rm(installRoot, { recursive: true, force: true });
    throw error;
  }
}

function assertMcpName(name: string) {
  if (!/^[a-z0-9](?:[a-z0-9_-]{0,38}[a-z0-9])?$/.test(name)) {
    throw new Error("MCP 名称需为 1–40 位小写字母、数字、连字符或下划线");
  }
}

export function mcpTokenEnvVar(name: string) {
  return `FORGE_MCP_TOKEN_${name.toUpperCase().replaceAll("-", "_")}`;
}

export function mcpAppServerArgs(servers: StoredMcpServer[]) {
  const result: string[] = [];
  const setting = (key: string, value: unknown) => result.push("-c", `${key}=${JSON.stringify(value)}`);
  for (const server of servers) {
    const prefix = `mcp_servers.${server.name}`;
    if (server.transport === "stdio") {
      setting(`${prefix}.command`, server.command || "");
      if (server.args.length) setting(`${prefix}.args`, server.args);
      if (server.envVars.length) setting(`${prefix}.env_vars`, server.envVars);
    } else {
      setting(`${prefix}.url`, server.url || "");
      if (server.useBearerToken) setting(`${prefix}.bearer_token_env_var`, mcpTokenEnvVar(server.name));
    }
    setting(`${prefix}.enabled`, server.enabled);
    setting(`${prefix}.required`, false);
    setting(`${prefix}.default_tools_approval_mode`, server.approvalMode);
  }
  return result;
}

export class ExtensionStore {
  private state: PersistedExtensions;
  private readonly filePath: string;
  private readonly skillsRoot: string;

  constructor(private readonly identity: ForgeIdentityContext = localIdentity) {
    this.state = initialState(identity);
    const dataDir = process.env.FORGE_DATA_DIR || path.join(os.homedir(), ".forge");
    const tenantRoot = identity.mode === "local" ? dataDir : path.join(dataDir, "tenants", tenantStorageKey(identity.tenantId));
    this.filePath = path.join(tenantRoot, "extensions.json");
    this.skillsRoot = path.join(tenantRoot, "skills");
  }

  async load() {
    await mkdir(this.skillsRoot, { recursive: true });
    try {
      const loaded = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<PersistedExtensions>;
      this.state = {
        schemaVersion: 2,
        tenantId: this.identity.tenantId,
        userId: this.identity.userId,
        skills: Array.isArray(loaded.skills) ? loaded.skills.map((skill) => ({
          ...skill,
          tenantId: this.identity.tenantId,
          userId: loaded.schemaVersion === 2 && skill.tenantId === this.identity.tenantId && skill.userId ? skill.userId : this.identity.userId,
        })) : [],
        mcpServers: Array.isArray(loaded.mcpServers) ? loaded.mcpServers.map((server) => ({
          ...server,
          tenantId: this.identity.tenantId,
          userId: loaded.schemaVersion === 2 && server.tenantId === this.identity.tenantId && server.userId ? server.userId : this.identity.userId,
        })) : [],
      };
    } catch {
      this.state = initialState(this.identity);
    }
    await this.persist();
  }

  listSkills(workspacePath: string): SkillInfo[] {
    return this.state.skills
      .filter((skill) => skill.scope === "global" || skill.workspacePath === workspacePath)
      .map(({ installRoot: _installRoot, skillPath: _skillPath, ...skill }): SkillInfo => ({
        ...skill,
        status: skill.enabled ? "ready" : "disabled",
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  enabledSkillRoots(workspacePath: string) {
    return this.state.skills
      .filter((skill) => skill.enabled && (skill.scope === "global" || skill.workspacePath === workspacePath))
      .map((skill) => skill.installRoot);
  }

  skillPaths(workspacePath: string) {
    return new Map(this.state.skills
      .filter((skill) => skill.scope === "global" || skill.workspacePath === workspacePath)
      .map((skill) => [skill.id, skill.skillPath]));
  }

  async importSkill(sourcePath: string, scope: SkillScope, workspacePath: string) {
    const resolvedSource = path.resolve(sourcePath);
    const metadata = await readSkillMetadata(resolvedSource);
    await validateImportTree(resolvedSource);
    const duplicate = this.state.skills.find((skill) => skill.name === metadata.name && skill.scope === scope && (scope === "global" || skill.workspacePath === workspacePath));
    if (duplicate) throw new Error(`Skill “${metadata.name}” 已经安装`);

    const id = randomUUID();
    const installRoot = path.join(this.skillsRoot, id);
    const skillPath = await copySkillTree(resolvedSource, installRoot);

    const record: StoredSkill = {
      id,
      tenantId: this.identity.tenantId,
      userId: this.identity.userId,
      ...metadata,
      scope,
      workspacePath: scope === "project" ? workspacePath : undefined,
      sourcePath: resolvedSource,
      enabled: true,
      installedAt: now(),
      installRoot,
      skillPath,
    };
    this.state.skills.push(record);
    await this.persist();
    return record;
  }

  async installMarketSkill(sourcePath: string, scope: SkillScope, workspacePath: string, marketplaceId: string, marketplaceVersion: string) {
    const resolvedSource = path.resolve(sourcePath);
    const metadata = await readSkillMetadata(resolvedSource);
    await validateImportTree(resolvedSource);
    const scoped = (skill: StoredSkill) => skill.scope === scope && (scope === "global" || skill.workspacePath === workspacePath);
    const existing = this.state.skills.find((skill) => skill.marketplaceId === marketplaceId && scoped(skill));
    const conflicting = this.state.skills.find((skill) => skill !== existing && skill.name === metadata.name && scoped(skill));
    if (conflicting) throw new Error(`Skill “${metadata.name}” 已由其他来源安装`);

    if (!existing) {
      const id = randomUUID();
      const installRoot = path.join(this.skillsRoot, id);
      const skillPath = await copySkillTree(resolvedSource, installRoot);
      const record: StoredSkill = {
        id,
        tenantId: this.identity.tenantId,
        userId: this.identity.userId,
        ...metadata,
        scope,
        workspacePath: scope === "project" ? workspacePath : undefined,
        sourcePath: `marketplace:${marketplaceId}`,
        enabled: true,
        installedAt: now(),
        marketplaceId,
        marketplaceVersion,
        installRoot,
        skillPath,
      };
      this.state.skills.push(record);
      await this.persist();
      return record;
    }

    const temporaryRoot = path.join(this.skillsRoot, `.update-${randomUUID()}`);
    const backupRoot = path.join(this.skillsRoot, `.backup-${randomUUID()}`);
    const skillPath = await copySkillTree(resolvedSource, temporaryRoot);
    await rename(existing.installRoot, backupRoot);
    try {
      await rename(temporaryRoot, existing.installRoot);
    } catch (error) {
      await rename(backupRoot, existing.installRoot).catch(() => undefined);
      await rm(temporaryRoot, { recursive: true, force: true });
      throw error;
    }
    Object.assign(existing, {
      ...metadata,
      sourcePath: `marketplace:${marketplaceId}`,
      marketplaceVersion,
      skillPath: path.join(existing.installRoot, path.relative(temporaryRoot, skillPath)),
    });
    await this.persist();
    await rm(backupRoot, { recursive: true, force: true });
    return existing;
  }

  async setSkillEnabled(id: string, enabled: boolean) {
    const skill = this.state.skills.find((item) => item.id === id);
    if (!skill) return false;
    skill.enabled = enabled;
    await this.persist();
    return true;
  }

  async deleteSkill(id: string) {
    const index = this.state.skills.findIndex((item) => item.id === id);
    if (index < 0) return false;
    const [skill] = this.state.skills.splice(index, 1);
    const target = path.resolve(skill.installRoot);
    const root = path.resolve(this.skillsRoot);
    if (!target.startsWith(`${root}${path.sep}`)) throw new Error("拒绝删除 Forge Skills 目录之外的文件");
    await rm(target, { recursive: true, force: true });
    await this.persist();
    return true;
  }

  mcpConfigs() {
    return this.state.mcpServers.map((server) => ({ ...server, args: [...server.args], envVars: [...server.envVars] }));
  }

  listMcpServers(): McpServerInfo[] {
    return this.state.mcpServers.map((server) => ({
      ...server,
      tokenConfigured: server.useBearerToken && Boolean(process.env[mcpTokenEnvVar(server.name)]),
      status: server.enabled ? "notStarted" : "disabled",
      tools: [],
    }));
  }

  async addMcpServer(input: {
    name: string;
    transport: McpTransport;
    command?: string;
    args?: string[];
    envVars?: string[];
    url?: string;
    approvalMode?: McpApprovalMode;
    useBearerToken?: boolean;
    marketplaceId?: string;
    marketplaceVersion?: string;
  }) {
    const name = input.name.trim();
    assertMcpName(name);
    if (this.state.mcpServers.some((server) => server.name === name)) throw new Error(`MCP 服务 “${name}” 已存在`);
    const args = (input.args || []).map((value) => value.trim()).filter(Boolean);
    const envVars = [...new Set((input.envVars || []).map((value) => value.trim()).filter(Boolean))];
    if (args.length > 32 || args.some((value) => value.length > 2000)) throw new Error("MCP 参数数量或长度超出限制");
    if (envVars.length > 20 || envVars.some((value) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))) throw new Error("环境变量名无效");
    if (input.transport === "stdio" && !input.command?.trim()) throw new Error("STDIO MCP 必须提供启动命令");
    if (input.transport === "http") {
      let target: URL;
      try { target = new URL(input.url?.trim() || ""); } catch { throw new Error("请输入有效的 MCP HTTP 地址"); }
      if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error("MCP 地址只支持 HTTP 或 HTTPS");
    }
    const approvalMode = input.approvalMode || "writes";
    if (!(["auto", "prompt", "writes"] as const).includes(approvalMode)) throw new Error("MCP 审批模式无效");
    const record: StoredMcpServer = {
      name,
      tenantId: this.identity.tenantId,
      userId: this.identity.userId,
      transport: input.transport,
      command: input.transport === "stdio" ? input.command?.trim() : undefined,
      args: input.transport === "stdio" ? args : [],
      envVars: input.transport === "stdio" ? envVars : [],
      url: input.transport === "http" ? input.url?.trim() : undefined,
      enabled: true,
      approvalMode,
      useBearerToken: input.transport === "http" && Boolean(input.useBearerToken),
      createdAt: now(),
      marketplaceId: input.marketplaceId,
      marketplaceVersion: input.marketplaceVersion,
    };
    this.state.mcpServers.push(record);
    await this.persist();
    return record;
  }

  async installMarketMcp(input: MarketMcpInput) {
    const index = this.state.mcpServers.findIndex((server) => server.marketplaceId === input.marketplaceId);
    const previous = index >= 0 ? { ...this.state.mcpServers[index], args: [...this.state.mcpServers[index].args], envVars: [...this.state.mcpServers[index].envVars] } : undefined;
    if (index >= 0) this.state.mcpServers.splice(index, 1);
    try {
      const record = await this.addMcpServer(input);
      return { record, previous };
    } catch (error) {
      const partialIndex = this.state.mcpServers.findIndex((server) => server.marketplaceId === input.marketplaceId);
      if (partialIndex >= 0) this.state.mcpServers.splice(partialIndex, 1);
      if (previous) this.state.mcpServers.splice(index, 0, previous);
      throw error;
    }
  }

  async rollbackMarketMcp(name: string, previous?: StoredMcpServer) {
    const index = this.state.mcpServers.findIndex((server) => server.name === name);
    if (index >= 0) this.state.mcpServers.splice(index, 1);
    if (previous) this.state.mcpServers.push(previous);
    await this.persist();
  }

  async setMcpEnabled(name: string, enabled: boolean) {
    const server = this.state.mcpServers.find((item) => item.name === name);
    if (!server) return false;
    server.enabled = enabled;
    await this.persist();
    return true;
  }

  async deleteMcpServer(name: string) {
    const index = this.state.mcpServers.findIndex((item) => item.name === name);
    if (index < 0) return false;
    this.state.mcpServers.splice(index, 1);
    await this.persist();
    return true;
  }

  private async persist() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, JSON.stringify(this.state, null, 2), "utf8");
    await rename(temporary, this.filePath);
  }
}
