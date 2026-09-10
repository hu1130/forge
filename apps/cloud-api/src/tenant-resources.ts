import type { CloudTenantResource, CloudTenantResourceKind } from "@forge/contracts";

export interface TenantPrincipal {
  tenantId: string;
  userId: string;
}

export interface TenantResourceStore {
  listResources(principal: TenantPrincipal, kind?: CloudTenantResourceKind): Promise<CloudTenantResource[]>;
  upsertResource(principal: TenantPrincipal, input: { kind: CloudTenantResourceKind; key: string; payload: Record<string, unknown> }): Promise<CloudTenantResource>;
  deleteResource(principal: TenantPrincipal, kind: CloudTenantResourceKind, key: string): Promise<boolean>;
}

export class TenantAccessError extends Error {}

const allowedFields: Record<CloudTenantResourceKind, Set<string>> = {
  project: new Set(["name", "branch", "repositoryKey", "archived"]),
  task: new Set(["projectKey", "title", "subtitle", "state", "pinned", "archived", "updatedAt"]),
  skill: new Set(["name", "description", "scope", "projectKey", "enabled", "marketplaceId", "marketplaceVersion"]),
  mcp: new Set(["name", "transport", "enabled", "approvalMode", "useBearerToken", "marketplaceId", "marketplaceVersion"]),
};

export function tenantResourceKind(value: string): CloudTenantResourceKind | undefined {
  return value === "project" || value === "task" || value === "skill" || value === "mcp" ? value : undefined;
}

export function tenantResourceKey(value: string) {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)) throw new Error("租户资源标识无效");
  return normalized;
}

export function tenantResourcePayload(kind: CloudTenantResourceKind, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("租户资源内容无效");
  const payload = value as Record<string, unknown>;
  const unexpected = Object.keys(payload).find((key) => !allowedFields[kind].has(key));
  if (unexpected) throw new Error(`租户资源包含不允许同步的字段：${unexpected}`);
  const hasInvalidValue = Object.values(payload).some((field) => field !== null && !["string", "number", "boolean"].includes(typeof field));
  if (hasInvalidValue) throw new Error("租户资源只允许同步简单元数据");
  if (Object.values(payload).some((field) => typeof field === "string" && field.length > 2048)) throw new Error("租户资源字段过长");
  const serialized = JSON.stringify(payload);
  if (serialized.length > 32 * 1024) throw new Error("租户资源内容超过 32KB 限制");
  return JSON.parse(serialized) as Record<string, unknown>;
}
