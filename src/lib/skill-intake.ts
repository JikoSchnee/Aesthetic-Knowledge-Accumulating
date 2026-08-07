import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, posix } from "node:path";
import { dataRoot } from "./library";
import { isCurrentRecipe } from "./recipe-schema";

export const MAX_SKILL_FILES = 200;
export const MAX_SKILL_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_SKILL_TOTAL_BYTES = 20 * 1024 * 1024;
export const ALLOWED_SKILL_EXTENSIONS = new Set([".md", ".json", ".yaml", ".yml", ".txt"]);

const secretPattern = /(sk-[a-z0-9_-]{16,}|(?:api[_-]?key|authorization)\s*[:=]\s*["']?[a-z0-9_./+-]{16,})/i;

export type SkillDocument = { path: string; content: string };
export type GitHubRemoteSource = {
  provider: "github";
  originalUrl: string;
  owner: string;
  repo: string;
  skillRoot: string;
  inputRef: string;
  commitSha: string;
  commitUrl: string;
  fetchedAt: string;
  upstreamKey: string;
};
export type SkillCandidate = {
  id: string;
  title: string;
  native: boolean;
  originalSchema?: string;
  externalSkillId?: string;
  sourceRoot: string;
  documents: SkillDocument[];
  recipe?: Record<string, unknown>;
  remoteSource?: GitHubRemoteSource;
};
export type RejectedSkillDocument = { file: string; reason: string };

export function safeSkillPath(input: string) {
  const value = input.replaceAll("\\", "/").replace(/^\.\//, "");
  if (value.split("/").includes("..")) throw new Error(`Unsafe path traversal: ${input}`);
  const normal = posix.normalize(value);
  if (!normal || normal.startsWith("/") || normal === ".." || normal.startsWith("../") || normal.split("/").length > 9) throw new Error(`Unsafe path: ${input}`);
  return normal;
}

export function validateSkillDocument(rawPath: string, content: string) {
  const path = safeSkillPath(rawPath);
  const bytes = Buffer.byteLength(content);
  if (!ALLOWED_SKILL_EXTENSIONS.has(extname(path).toLowerCase())) return { rejected: { file: path, reason: "Unsupported or executable file type." } as RejectedSkillDocument };
  if (bytes > MAX_SKILL_FILE_BYTES) return { rejected: { file: path, reason: "Text file exceeds 2MB." } as RejectedSkillDocument };
  if (secretPattern.test(content)) return { rejected: { file: path, reason: "Possible credential detected; file was not stored." } as RejectedSkillDocument };
  return { document: { path, content } as SkillDocument, bytes };
}

function titleFrom(content: string, fallback: string) {
  const frontmatter = content.match(/^---[\s\S]*?\nname:\s*([^\n]+)[\s\S]*?---/i)?.[1];
  const heading = content.match(/^#\s+(.+)$/m)?.[1];
  return (frontmatter || heading || fallback).trim().slice(0, 160);
}

export function skillSourceHash(documents: SkillDocument[]) {
  const canonical = documents.slice().sort((a, b) => a.path.localeCompare(b.path)).map((item) => `${item.path}\0${item.content}`).join("\0\0");
  return createHash("sha256").update(canonical).digest("hex");
}

function nearestSkillRoot(path: string, roots: string[]) {
  return roots.filter((root) => !root || path === root || path.startsWith(`${root}/`)).sort((a, b) => b.length - a.length)[0];
}

export function buildSkillCandidates(documents: SkillDocument[]) {
  const byPath = new Map(documents.map((item) => [item.path, item.content]));
  const manifestEntry = documents.find((item) => basename(item.path) === "manifest.json");
  const candidates: SkillCandidate[] = [];
  if (manifestEntry) {
    try {
      const manifest = JSON.parse(manifestEntry.content) as { recipeSchemaVersion?: string; skills?: Array<{ id?: string; title?: string; directory?: string }> };
      const manifestBase = dirname(manifestEntry.path) === "." ? "" : dirname(manifestEntry.path);
      const inPackage = (path: string) => manifestBase ? `${manifestBase}/${path}` : path;
      for (const skill of manifest.skills || []) {
        if (!skill.directory) continue;
        const root = safeSkillPath(skill.directory); const fullRoot = inPackage(root); const recipeContent = byPath.get(`${fullRoot}/recipe.json`);
        if (!recipeContent) continue;
        const recipe = JSON.parse(recipeContent) as Record<string, unknown>;
        const selected = documents.filter((item) => item.path === inPackage("SKILL.md") || item.path.startsWith(`${inPackage("references")}/`) || item.path.startsWith(`${fullRoot}/`)).map((item) => ({ ...item, path: manifestBase ? item.path.slice(manifestBase.length + 1) : item.path }));
        const id = skillSourceHash(selected);
        candidates.push({ id, title: skill.title || String((recipe.metadata as Record<string, unknown> | undefined)?.title || "Imported visual Skill"), native: isCurrentRecipe(recipe), originalSchema: manifest.recipeSchemaVersion, externalSkillId: skill.id, sourceRoot: root, documents: selected, ...(isCurrentRecipe(recipe) ? { recipe } : {}) });
      }
    } catch { /* Fall through to generic discovery. */ }
  }
  if (candidates.length) return candidates;
  const skillFiles = documents.filter((item) => basename(item.path).toLowerCase() === "skill.md");
  const skillRoots = skillFiles.map((item) => dirname(item.path) === "." ? "" : dirname(item.path));
  for (const skillFile of skillFiles) {
    const root = dirname(skillFile.path) === "." ? "" : dirname(skillFile.path);
    const selected = documents.filter((item) => nearestSkillRoot(item.path, skillRoots) === root).map((item) => ({ ...item, path: root ? item.path.slice(root.length + 1) : item.path }));
    candidates.push({ id: skillSourceHash(selected), title: titleFrom(skillFile.content, basename(root) || "Imported visual Skill"), native: false, sourceRoot: root, documents: selected });
  }
  if (!candidates.length) {
    for (const document of documents.filter((item) => basename(item.path).toLowerCase() === "recipe.json")) {
      try {
        const recipe = JSON.parse(document.content) as Record<string, unknown>; const selected = [{ ...document, path: basename(document.path) }];
        candidates.push({ id: skillSourceHash(selected), title: String((recipe.metadata as Record<string, unknown> | undefined)?.title || "Imported visual Skill"), native: isCurrentRecipe(recipe), sourceRoot: dirname(document.path) === "." ? "" : dirname(document.path), documents: selected, ...(isCurrentRecipe(recipe) ? { recipe } : {}) });
      } catch { /* Invalid JSON will be reported as no candidate. */ }
    }
  }
  return candidates;
}

export async function stageSkillCandidates(discovered: SkillCandidate[], rejected: RejectedSkillDocument[] = []) {
  const root = dataRoot(); const batchId = randomUUID(); const candidates: SkillCandidate[] = []; const skipped: Array<{ id: string; title: string; reason: string }> = [];
  for (const candidate of discovered) {
    try { await access(join(root, "imported-skills", `${candidate.id}.json`)); skipped.push({ id: candidate.id, title: candidate.title, reason: "Exact external Skill content already exists." }); }
    catch { candidates.push(candidate); }
  }
  await mkdir(join(root, "import-staging"), { recursive: true });
  await writeFile(join(root, "import-staging", `${batchId}.json`), JSON.stringify({ batchId, createdAt: new Date().toISOString(), candidates }, null, 2));
  return { batchId, detected: discovered.length, ready: candidates.length, skipped, rejected, candidates: candidates.map(({ id, title, native, originalSchema, documents }) => ({ id, title, native, originalSchema, documentCount: documents.length })) };
}
