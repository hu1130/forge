import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import yauzl from "yauzl";
import type {
  ExtensionPayload, MarketplaceCategory, MarketplaceItem, MarketplacePayload,
  McpApprovalMode, McpTransport, SkillScope,
} from "@forge/contracts";

type CatalogSkillSource =
  | { kind: "bundled"; path: string }
  | { kind: "archive"; url: string; sha256: string; root?: string };

export interface CatalogItem extends Omit<MarketplaceItem, "installation"> {
  source?: CatalogSkillSource;
}

interface Catalog {
  schemaVersion: 1;
  label: string;
  items: CatalogItem[];
}

interface CachedCatalog {
  url: string;
  refreshedAt: string;
  catalog: Catalog;
}

const MAX_CATALOG_BYTES = 1024 * 1024;
const MAX_SKILL_BYTES = 25 * 1024 * 1024;
const MAX_SKILL_FILES = 1000;
const allowedDownloadHosts = new Set(["github.com", "codeload.github.com", "raw.githubusercontent.com"]);
const categories = new Set<MarketplaceCategory>(["开发", "知识", "数据", "效率", "其他"]);
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown, field: string, maxLength: number) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) throw new Error(`市场目录字段 ${field} 无效`);
  return value.trim();
}

function optionalHttps(value: unknown, field: string) {
  if (value === undefined) return undefined;
  const text = requiredText(value, field, 2048);
  let target: URL;
  try { target = new URL(text); } catch { throw new Error(`市场目录字段 ${field} 不是有效网址`); }
  if (target.protocol !== "https:") throw new Error(`市场目录字段 ${field} 只允许 HTTPS`);
  return target.toString();
}

function stringArray(value: unknown, field: string, maxItems: number) {
  if (!Array.isArray(value) || value.length > maxItems || value.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > 100)) {
    throw new Error(`市场目录字段 ${field} 无效`);
  }
  return value.map((entry) => (entry as string).trim());
}

function validateCatalog(raw: unknown, allowBundledSources: boolean): Catalog {
  if (!isRecord(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.items) || raw.items.length > 200) throw new Error("市场目录格式无效");
  const label = requiredText(raw.label, "label", 80);
  const seen = new Set<string>();
  const items = raw.items.map((candidate, index): CatalogItem => {
    if (!isRecord(candidate)) throw new Error(`市场目录第 ${index + 1} 项无效`);
    const id = requiredText(candidate.id, "id", 80);
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(id) || seen.has(id)) throw new Error(`市场目录项目 ID 无效或重复：${id}`);
    seen.add(id);
    const kind = candidate.kind;
    if (kind !== "skill" && kind !== "mcp") throw new Error(`市场目录项目类型无效：${id}`);
    const category = candidate.category;
    if (typeof category !== "string" || !categories.has(category as MarketplaceCategory)) throw new Error(`市场目录项目分类无效：${id}`);
    const base = {
      id,
      kind: kind as "skill" | "mcp",
      name: requiredText(candidate.name, "name", 80),
      description: requiredText(candidate.description, "description", 240),
      details: requiredText(candidate.details, "details", 1200),
      publisher: requiredText(candidate.publisher, "publisher", 80),
      version: requiredText(candidate.version, "version", 40),
      category: category as MarketplaceCategory,
      tags: stringArray(candidate.tags, "tags", 8),
      featured: candidate.featured === true,
      homepage: optionalHttps(candidate.homepage, "homepage"),
      verified: candidate.verified === true,
    };

    if (kind === "skill") {
      if (!isRecord(candidate.source)) throw new Error(`Skill ${id} 缺少安装来源`);
      if (candidate.source.kind === "bundled") {
        if (!allowBundledSources) throw new Error(`远程市场不能引用内置路径：${id}`);
        return { ...base, source: { kind: "bundled", path: requiredText(candidate.source.path, "source.path", 260) } };
      }
      if (candidate.source.kind !== "archive") throw new Error(`Skill ${id} 的安装来源无效`);
      const sha256 = requiredText(candidate.source.sha256, "source.sha256", 64).toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`Skill ${id} 的 SHA-256 无效`);
      const root = candidate.source.root === undefined ? undefined : requiredText(candidate.source.root, "source.root", 260);
      return { ...base, source: { kind: "archive", url: optionalHttps(candidate.source.url, "source.url")!, sha256, root } };
    }

    if (!isRecord(candidate.mcp)) throw new Error(`MCP ${id} 缺少连接配置`);
    const transport = candidate.mcp.transport;
    if (transport !== "stdio" && transport !== "http") throw new Error(`MCP ${id} 的连接方式无效`);
    const approvalMode = candidate.mcp.approvalMode;
    if (approvalMode !== "auto" && approvalMode !== "prompt" && approvalMode !== "writes") throw new Error(`MCP ${id} 的审批模式无效`);
    const command = candidate.mcp.command === undefined ? undefined : requiredText(candidate.mcp.command, "mcp.command", 260);
    const url = candidate.mcp.url === undefined ? undefined : requiredText(candidate.mcp.url, "mcp.url", 2048);
    if (transport === "stdio" && !command) throw new Error(`MCP ${id} 缺少启动命令`);
    if (transport === "http") optionalHttps(url, "mcp.url");
    return {
      ...base,
      mcp: {
        name: requiredText(candidate.mcp.name, "mcp.name", 40),
        transport: transport as McpTransport,
        command,
        args: stringArray(candidate.mcp.args, "mcp.args", 32),
        envVars: stringArray(candidate.mcp.envVars, "mcp.envVars", 20),
        url,
        approvalMode: approvalMode as McpApprovalMode,
        useBearerToken: candidate.mcp.useBearerToken === true,
        bearerTokenRequired: candidate.mcp.bearerTokenRequired === true,
      },
    };
  });
  return { schemaVersion: 1, label, items };
}

function assertAllowedRemote(url: string) {
  const target = new URL(url);
  if (target.protocol !== "https:" || !allowedDownloadHosts.has(target.hostname.toLocaleLowerCase())) {
    throw new Error("市场下载只允许 GitHub HTTPS 地址");
  }
  return target;
}

async function fetchLimited(url: string, maxBytes: number, redirects = 0): Promise<{ data: Buffer; finalUrl: string }> {
  if (redirects > 3) throw new Error("市场下载重定向次数过多");
  const target = assertAllowedRemote(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(target, { redirect: "manual", signal: controller.signal, headers: { "user-agent": "Forge-Marketplace/1" } });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("市场下载重定向缺少目标地址");
      return fetchLimited(new URL(location, target).toString(), maxBytes, redirects + 1);
    }
    if (!response.ok || !response.body) throw new Error(`市场下载失败（HTTP ${response.status}）`);
    const declaredSize = Number(response.headers.get("content-length") || 0);
    if (declaredSize > maxBytes) throw new Error("市场下载内容超过大小限制");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("市场下载内容超过大小限制");
      }
      chunks.push(value);
    }
    return { data: Buffer.concat(chunks), finalUrl: response.url || target.toString() };
  } finally {
    clearTimeout(timer);
  }
}

function safeRelativePath(value: string) {
  const normalized = value.replaceAll("\\", "/");
  if (!normalized || normalized.includes("\0") || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) throw new Error("Skill 压缩包包含无效路径");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) throw new Error("Skill 压缩包包含越界路径");
  return parts.join(path.sep);
}

async function extractSkillArchive(data: Buffer, root?: string) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "forge-market-"));
  try {
    const zip = await yauzl.fromBufferPromise(data, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: true });
    if (!zip.entryCount || zip.entryCount > MAX_SKILL_FILES) throw new Error("Skill 压缩包文件数量无效");
    let totalBytes = 0;
    try {
      for await (const entry of zip.eachEntry()) {
        const relative = safeRelativePath(entry.fileName);
        const unixType = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (unixType === 0o120000) throw new Error("Skill 压缩包不能包含符号链接");
        if (entry.fileName.endsWith("/")) {
          await mkdir(path.join(temporaryRoot, relative), { recursive: true });
          continue;
        }
        totalBytes += entry.uncompressedSize;
        if (totalBytes > MAX_SKILL_BYTES) throw new Error("Skill 解压后超过 25 MB 限制");
        const target = path.join(temporaryRoot, relative);
        await mkdir(path.dirname(target), { recursive: true });
        const stream = await zip.openReadStreamPromise(entry);
        await pipeline(stream, createWriteStream(target, { flags: "wx", mode: 0o600 }));
      }
    } finally {
      zip.close();
    }
    const skillRoot = root ? path.resolve(temporaryRoot, safeRelativePath(root)) : temporaryRoot;
    if (!skillRoot.startsWith(`${path.resolve(temporaryRoot)}${path.sep}`) && skillRoot !== path.resolve(temporaryRoot)) throw new Error("Skill 根目录越界");
    await access(path.join(skillRoot, "SKILL.md"));
    return { skillRoot, cleanup: () => rm(temporaryRoot, { recursive: true, force: true }) };
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

async function locateResources() {
  const candidates = [path.join(moduleDir, "resources"), path.join(moduleDir, "..", "resources")];
  for (const candidate of candidates) {
    try {
      await access(path.join(candidate, "marketplace.json"));
      return candidate;
    } catch { /* Try the next packaging layout. */ }
  }
  throw new Error("Forge 市场资源不存在");
}

export class MarketplaceStore {
  private catalog!: Catalog;
  private source!: MarketplacePayload["source"];
  private readonly dataDir: string;
  private readonly cachePath: string;
  private readonly remoteUrl?: string;
  private resourcesRoot = "";

  constructor() {
    this.dataDir = process.env.FORGE_DATA_DIR || path.join(os.homedir(), ".forge");
    this.cachePath = path.join(this.dataDir, "marketplace-cache.json");
    this.remoteUrl = process.env.FORGE_MARKETPLACE_URL?.trim();
  }

  async load() {
    this.resourcesRoot = await locateResources();
    this.catalog = validateCatalog(JSON.parse(await readFile(path.join(this.resourcesRoot, "marketplace.json"), "utf8")), true);
    this.source = { kind: "builtIn", label: this.catalog.label, refreshedAt: new Date().toISOString() };
    if (!this.remoteUrl) return;
    try {
      const cached = JSON.parse(await readFile(this.cachePath, "utf8")) as CachedCatalog;
      if (cached.url === this.remoteUrl) {
        this.catalog = validateCatalog(cached.catalog, false);
        this.source = { kind: "cache", label: this.catalog.label, url: this.remoteUrl, refreshedAt: cached.refreshedAt };
      }
    } catch { /* The bundled catalog remains available. */ }
  }

  async refresh() {
    if (!this.remoteUrl) {
      this.catalog = validateCatalog(JSON.parse(await readFile(path.join(this.resourcesRoot, "marketplace.json"), "utf8")), true);
      this.source = { kind: "builtIn", label: this.catalog.label, refreshedAt: new Date().toISOString(), warning: "尚未配置远程市场地址，当前使用安装包内置目录。" };
      return;
    }
    try {
      const { data } = await fetchLimited(this.remoteUrl, MAX_CATALOG_BYTES);
      const catalog = validateCatalog(JSON.parse(data.toString("utf8")), false);
      const refreshedAt = new Date().toISOString();
      await mkdir(this.dataDir, { recursive: true });
      await writeFile(this.cachePath, JSON.stringify({ url: this.remoteUrl, refreshedAt, catalog } satisfies CachedCatalog, null, 2), "utf8");
      this.catalog = catalog;
      this.source = { kind: "remote", label: catalog.label, url: this.remoteUrl, refreshedAt };
    } catch (error) {
      this.source = { ...this.source, warning: `在线目录刷新失败，继续使用${this.source.kind === "cache" ? "缓存" : "内置"}目录：${error instanceof Error ? error.message : String(error)}` };
      throw error;
    }
  }

  item(id: string) {
    return this.catalog.items.find((item) => item.id === id);
  }

  payload(extensions: ExtensionPayload, scope: SkillScope): MarketplacePayload {
    return {
      source: { ...this.source },
      items: this.catalog.items.map(({ source: _source, ...item }): MarketplaceItem => {
        const installed = item.kind === "skill"
          ? extensions.skills.find((skill) => skill.marketplaceId === item.id && skill.scope === scope)
          : extensions.mcpServers.find((server) => server.marketplaceId === item.id);
        const installedVersion = installed?.marketplaceVersion;
        return {
          ...item,
          installation: {
            status: !installed ? "notInstalled" : installedVersion === item.version ? "installed" : "updateAvailable",
            installedVersion,
            installedId: item.kind === "skill" && installed ? (installed as { id: string }).id : undefined,
            installedName: item.kind === "mcp" && installed ? (installed as { name: string }).name : undefined,
          },
        };
      }),
    };
  }

  materializeMcp(item: CatalogItem, workspacePath: string) {
    if (item.kind !== "mcp" || !item.mcp) throw new Error("该市场项目不是 MCP 服务");
    const expand = (value: string) => value.replaceAll("{{workspacePath}}", workspacePath);
    return {
      ...item.mcp,
      command: item.mcp.command ? expand(item.mcp.command) : undefined,
      args: item.mcp.args.map(expand),
      url: item.mcp.url ? expand(item.mcp.url) : undefined,
      marketplaceId: item.id,
      marketplaceVersion: item.version,
    };
  }

  async materializeSkill(item: CatalogItem) {
    if (item.kind !== "skill" || !item.source) throw new Error("该市场项目不是 Skill");
    if (item.source.kind === "bundled") {
      const skillRoot = path.resolve(this.resourcesRoot, item.source.path);
      const resourceRoot = path.resolve(this.resourcesRoot);
      if (!skillRoot.startsWith(`${resourceRoot}${path.sep}`)) throw new Error("内置 Skill 路径越界");
      await access(path.join(skillRoot, "SKILL.md"));
      return { skillRoot, cleanup: async () => undefined };
    }
    const { data } = await fetchLimited(item.source.url, MAX_SKILL_BYTES);
    const digest = createHash("sha256").update(data).digest("hex");
    if (digest !== item.source.sha256) throw new Error("Skill 下载包 SHA-256 校验失败，已阻止安装");
    return extractSkillArchive(data, item.source.root);
  }
}
