import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { dataRoot } from "./library";

export type LocalTransferSection = "embeddings" | "uploads" | "evals";
export type LocalTransferFile = { section: LocalTransferSection; path: string; absolutePath: string; size: number; sha256: string };
export type LocalTransferManifest = {
  schemaVersion: "1.0";
  createdAt: string;
  excludes: string[];
  embeddingConfig?: { endpoint: string; model: string };
  files: Array<Omit<LocalTransferFile, "absolutePath">>;
};

export const LOCAL_TRANSFER_MAX_FILES = 12_000;
export const LOCAL_TRANSFER_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const LOCAL_TRANSFER_MAX_FILE_BYTES = 256 * 1024 * 1024;

const allowedExtensions: Record<LocalTransferSection, Set<string>> = {
  embeddings: new Set([".json"]),
  uploads: new Set([".jpg", ".jpeg", ".png", ".webp"]),
  evals: new Set([".json", ".jpg", ".jpeg", ".png", ".webp"])
};

const roots = (projectRoot = process.cwd(), libraryRoot = dataRoot()) => ({
  embeddings: { absolute: join(libraryRoot, "embeddings"), archive: "data/embeddings" },
  uploads: { absolute: join(libraryRoot, "uploads"), archive: "data/uploads" },
  evals: { absolute: join(projectRoot, "eval-cases"), archive: "eval-cases" }
});

const portablePath = (value: string) => value.split(sep).join("/");

export function safeTransferPath(value: string) {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0") || normalized.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("迁移包包含不安全的文件路径。");
  return normalized;
}

export function transferSectionForPath(path: string): LocalTransferSection {
  const safe = safeTransferPath(path);
  if (safe.startsWith("data/embeddings/")) return "embeddings";
  if (safe.startsWith("data/uploads/")) return "uploads";
  if (safe.startsWith("eval-cases/")) return "evals";
  throw new Error(`迁移包不允许写入 ${safe}。`);
}

function validateTransferFilename(section: LocalTransferSection, path: string) {
  const extension = extname(path).toLowerCase();
  if (!allowedExtensions[section].has(extension)) throw new Error(`${path} 的文件类型不允许迁移。`);
  if (section === "embeddings" && !/^data\/embeddings\/[a-f0-9]{64}\.json$/i.test(path)) throw new Error(`${path} 不是有效的 Embedding 文件。`);
}

export function resolveTransferTarget(path: string, projectRoot = process.cwd(), libraryRoot = dataRoot()) {
  const safe = safeTransferPath(path);
  const section = transferSectionForPath(safe);
  validateTransferFilename(section, safe);
  const definitions = roots(projectRoot, libraryRoot);
  const definition = definitions[section];
  const suffix = safe.slice(definition.archive.length + 1);
  const target = resolve(definition.absolute, suffix);
  const root = resolve(definition.absolute);
  if (!target.startsWith(`${root}${sep}`)) throw new Error("迁移包目标路径越界。");
  return { section, target };
}

async function hashFile(path: string) {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

async function walk(section: LocalTransferSection, absoluteRoot: string, archiveRoot: string, includeHashes = true) {
  const output: LocalTransferFile[] = [];
  const visit = async (directory: string) => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name.endsWith(".tmp")) continue;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) { await visit(absolutePath); continue; }
      if (!entry.isFile()) continue;
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) continue;
      const path = `${archiveRoot}/${portablePath(relative(absoluteRoot, absolutePath))}`;
      validateTransferFilename(section, path);
      if (info.size > LOCAL_TRANSFER_MAX_FILE_BYTES) throw new Error(`${path} 超过单文件迁移上限。`);
      output.push({ section, path, absolutePath, size: info.size, sha256: includeHashes ? await hashFile(absolutePath) : "" });
    }
  };
  await visit(absoluteRoot);
  return output;
}

export async function collectLocalTransferFiles(sections: LocalTransferSection[], projectRoot = process.cwd(), libraryRoot = dataRoot()) {
  const definitions = roots(projectRoot, libraryRoot);
  const unique = [...new Set(sections)];
  const files = (await Promise.all(unique.map((section) => walk(section, definitions[section].absolute, definitions[section].archive)))).flat().sort((a, b) => a.path.localeCompare(b.path));
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  if (files.length > LOCAL_TRANSFER_MAX_FILES) throw new Error(`迁移文件超过 ${LOCAL_TRANSFER_MAX_FILES} 个。`);
  if (totalBytes > LOCAL_TRANSFER_MAX_BYTES) throw new Error("迁移内容超过 2GB，请减少选择范围。");
  return { files, totalBytes };
}

export async function localTransferStats(projectRoot = process.cwd(), libraryRoot = dataRoot()) {
  const definitions = roots(projectRoot, libraryRoot);
  const sections = await Promise.all((["embeddings", "uploads", "evals"] as LocalTransferSection[]).map(async (section) => {
    const files = await walk(section, definitions[section].absolute, definitions[section].archive, false);
    const totalBytes = files.reduce((total, file) => total + file.size, 0);
    return [section, { files: files.length, bytes: totalBytes }] as const;
  }));
  return Object.fromEntries(sections) as Record<LocalTransferSection, { files: number; bytes: number }>;
}

export function validateTransferManifest(value: unknown) {
  if (!value || typeof value !== "object") throw new Error("迁移包缺少有效清单。");
  const manifest = value as Partial<LocalTransferManifest>;
  if (manifest.schemaVersion !== "1.0" || !Array.isArray(manifest.files)) throw new Error("不支持此迁移包版本。");
  if (manifest.files.length > LOCAL_TRANSFER_MAX_FILES) throw new Error("迁移包文件数量超限。");
  const seen = new Set<string>(); let totalBytes = 0;
  for (const file of manifest.files) {
    const path = safeTransferPath(file.path);
    const section = transferSectionForPath(path);
    validateTransferFilename(section, path);
    if (file.section !== section || seen.has(path)) throw new Error("迁移包清单包含重复或错误的文件分类。");
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > LOCAL_TRANSFER_MAX_FILE_BYTES || !/^[a-f0-9]{64}$/i.test(file.sha256)) throw new Error(`${path} 的清单信息无效。`);
    seen.add(path); totalBytes += file.size;
  }
  if (totalBytes > LOCAL_TRANSFER_MAX_BYTES) throw new Error("迁移包解压后超过 2GB 上限。");
  let embeddingConfig: LocalTransferManifest["embeddingConfig"];
  if (manifest.embeddingConfig !== undefined) {
    const config = manifest.embeddingConfig as Partial<NonNullable<LocalTransferManifest["embeddingConfig"]>>;
    if (!config || typeof config.endpoint !== "string" || typeof config.model !== "string") throw new Error("迁移包中的 Embedding 配置无效。");
    const endpoint = config.endpoint.trim(); const model = config.model.trim();
    if (!endpoint || endpoint.length > 500 || !model || model.length > 200) throw new Error("迁移包中的 Embedding 配置无效。");
    embeddingConfig = { endpoint, model };
  }
  return { ...manifest, ...(embeddingConfig ? { embeddingConfig } : {}) } as LocalTransferManifest;
}
