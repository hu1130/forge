import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

const usage = `Forge MySQL maintenance

Backup:
  FORGE_CLOUD_BACKUP_DATABASE_URL=mysql://... FORGE_CLOUD_BACKUP_DIR=... pnpm cloud:backup

Restore:
  FORGE_CLOUD_RESTORE_DATABASE_URL=mysql://... pnpm cloud:restore -- <backup.sql.gz> --confirm=<database>
`;

function databaseConnection(name, value) {
  if (!value) throw new Error(`${name} 未配置`);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} 不是有效 URL`);
  }
  if (url.protocol !== "mysql:" || !url.hostname || !url.username || !url.password || url.pathname === "/") {
    throw new Error(`${name} 必须是包含地址、账号、密码和数据库名的 mysql:// URL`);
  }
  const decoded = {
    host: decodeURIComponent(url.hostname),
    port: url.port || "3306",
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
  };
  if (Object.values(decoded).some((value) => /[\0\r\n]/.test(value))) throw new Error(`${name} 包含不安全字符`);
  return decoded;
}

function optionValue(value) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

async function credentialFile(connection) {
  const directory = await mkdtemp(path.join(tmpdir(), "forge-mysql-maintenance-"));
  const file = path.join(directory, "client.cnf");
  await writeFile(file, [
    "[client]",
    `host=${optionValue(connection.host)}`,
    `port=${connection.port}`,
    `user=${optionValue(connection.user)}`,
    `password=${optionValue(connection.password)}`,
    "protocol=TCP",
    "default-character-set=utf8mb4",
    "",
  ].join("\n"), { encoding: "utf8", mode: 0o600 });
  return { directory, file };
}

function waitForProcess(child, label) {
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-8_000); });
  return new Promise((resolve, reject) => {
    child.once("error", (error) => reject(new Error(`${label} 启动失败：${error.message}`)));
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`${label} 失败（退出码 ${code}）：${stderr.trim()}`)));
  });
}

async function backup() {
  const connection = databaseConnection("FORGE_CLOUD_BACKUP_DATABASE_URL", process.env.FORGE_CLOUD_BACKUP_DATABASE_URL);
  const backupDirectory = process.env.FORGE_CLOUD_BACKUP_DIR?.trim();
  if (!backupDirectory) throw new Error("FORGE_CLOUD_BACKUP_DIR 未配置");
  const resolvedDirectory = path.resolve(backupDirectory);
  await mkdir(resolvedDirectory, { recursive: true });
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const finalPath = path.join(resolvedDirectory, `forge-${connection.database}-${timestamp}.sql.gz`);
  const partialPath = `${finalPath}.partial`;
  const credentials = await credentialFile(connection);
  try {
    const child = spawn(process.env.FORGE_MYSQLDUMP_BIN || "mysqldump", [
      `--defaults-extra-file=${credentials.file}`,
      "--single-transaction", "--quick", "--routines", "--events", "--triggers", "--hex-blob", "--no-tablespaces",
      "--set-gtid-purged=OFF", connection.database,
    ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const output = pipeline(child.stdout, createGzip({ level: 9 }), createWriteStream(partialPath, { flags: "wx", mode: 0o600 }))
      .catch((error) => { child.kill(); throw error; });
    const operations = await Promise.allSettled([
      output,
      waitForProcess(child, "mysqldump"),
    ]);
    const failure = operations.find((operation) => operation.status === "rejected");
    if (failure) throw failure.reason;
    await rename(partialPath, finalPath);
    const result = await stat(finalPath);
    if (!result.isFile() || result.size === 0) throw new Error("备份文件为空");
    console.log(JSON.stringify({ ok: true, action: "backup", path: finalPath, bytes: result.size }));
  } finally {
    await rm(partialPath, { force: true }).catch(() => undefined);
    await rm(credentials.directory, { recursive: true, force: true });
  }
}

async function restore() {
  const connection = databaseConnection("FORGE_CLOUD_RESTORE_DATABASE_URL", process.env.FORGE_CLOUD_RESTORE_DATABASE_URL);
  const restoreArguments = process.argv.slice(3).filter((argument) => argument !== "--");
  const backupArgument = restoreArguments.find((argument) => !argument.startsWith("--"));
  const backupPath = backupArgument ? path.resolve(backupArgument) : "";
  const confirmation = restoreArguments.find((argument) => argument.startsWith("--confirm="))?.slice("--confirm=".length);
  if (!backupPath) throw new Error("缺少要恢复的备份文件路径");
  if (confirmation !== connection.database) throw new Error(`恢复会覆盖数据，必须传入 --confirm=${connection.database}`);
  if (!backupPath.endsWith(".sql") && !backupPath.endsWith(".sql.gz")) throw new Error("恢复文件必须以 .sql 或 .sql.gz 结尾");
  await access(backupPath);
  const credentials = await credentialFile(connection);
  try {
    const child = spawn(process.env.FORGE_MYSQL_BIN || "mysql", [
      `--defaults-extra-file=${credentials.file}`,
      "--database", connection.database,
    ], { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    const source = createReadStream(backupPath);
    const input = (backupPath.endsWith(".gz") ? pipeline(source, createGunzip(), child.stdin) : pipeline(source, child.stdin))
      .catch((error) => { child.kill(); throw error; });
    const operations = await Promise.allSettled([
      input,
      waitForProcess(child, "mysql restore"),
    ]);
    const failure = operations.find((operation) => operation.status === "rejected");
    if (failure) throw failure.reason;
    console.log(JSON.stringify({ ok: true, action: "restore", database: connection.database, path: backupPath }));
  } finally {
    await rm(credentials.directory, { recursive: true, force: true });
  }
}

const action = process.argv[2];
try {
  if (action === "--help" || action === "-h") console.log(usage);
  else if (action === "backup") await backup();
  else if (action === "restore") await restore();
  else throw new Error(usage);
} catch (error) {
  console.error(error instanceof Error ? error.message : "MySQL 维护操作失败");
  process.exitCode = 1;
}
