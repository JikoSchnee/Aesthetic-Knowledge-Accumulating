import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type SkillStatus = "needs_review" | "approved" | "rejected" | "superseded" | string;
export type RetrievalProfile = {
  description: string;
  triggerTerms: string[];
  excludeWhen: string[];
  reviewStatus: "generated" | "reviewed";
};

export type SkillIdentity = {
  skillId: string;
  versionId: string;
  version: number;
  status: SkillStatus;
};

export type ActiveSkillVersions = {
  schemaVersion: "1.0";
  updatedAt: string;
  skills: Record<string, string>;
};

const text = (value: unknown) => typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
const strings = (value: unknown) => Array.isArray(value) ? [...new Set(value.map(text).filter(Boolean))] : [];
const object = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function skillIdentity(record: Record<string, unknown>): SkillIdentity {
  const legacyId = text(record.id);
  return {
    skillId: text(record.skillId) || legacyId,
    versionId: text(record.versionId) || legacyId,
    version: Number.isFinite(Number(record.version)) && Number(record.version) > 0 ? Math.round(Number(record.version)) : 1,
    status: text(record.status) || "needs_review"
  };
}

export function stableSkillId(key?: string) {
  if (!key?.trim()) return randomUUID();
  return createHash("sha256").update(`taste-skill:${key.trim().toLowerCase()}`).digest("hex");
}

export function retrievalProfileForRecipe(recipe: Record<string, unknown>, reviewStatus: RetrievalProfile["reviewStatus"] = "generated"): RetrievalProfile {
  const existing = object(recipe.retrievalProfile);
  const metadata = object(recipe.metadata);
  const floor = object(recipe.aestheticFloor);
  const category = text(metadata.category);
  const useCases = strings(metadata.useCases);
  const tags = strings(metadata.retrievalTags);
  const relationships = strings(recipe.coreVisualRelationships);
  const definition = text(recipe.visualDefinition);
  const formula = text(recipe.reuseFormula);
  const description = text(existing.description) || [
    category ? `${category} visual system` : "Reusable visual system",
    useCases.length ? `for ${useCases.slice(0, 3).join(", ")}` : "",
    definition || relationships.slice(0, 2).join("; ") || formula
  ].filter(Boolean).join(": ").slice(0, 800);
  return {
    description,
    triggerTerms: strings(existing.triggerTerms).length ? strings(existing.triggerTerms) : [...new Set([...useCases, ...tags])].slice(0, 30),
    excludeWhen: strings(existing.excludeWhen).length ? strings(existing.excludeWhen) : strings(floor.avoid).slice(0, 20),
    reviewStatus: existing.reviewStatus === "reviewed" ? "reviewed" : reviewStatus
  };
}

export function validateRetrievalProfile(value: unknown): RetrievalProfile {
  const input = object(value);
  const description = text(input.description);
  const triggerTerms = strings(input.triggerTerms);
  const excludeWhen = strings(input.excludeWhen);
  if (description.length < 10 || description.length > 800) throw new Error("Retrieval description 必须为 10–800 个字符。");
  if (!triggerTerms.length || triggerTerms.length > 30) throw new Error("Trigger terms 必须包含 1–30 项。");
  if (!excludeWhen.length || excludeWhen.length > 20) throw new Error("Exclude when 必须包含 1–20 项。");
  return { description, triggerTerms, excludeWhen, reviewStatus: "reviewed" };
}

export function applyRetrievalProfile(recipe: Record<string, unknown>, reviewStatus: RetrievalProfile["reviewStatus"] = "generated"): Record<string, unknown> & { retrievalProfile: RetrievalProfile } {
  return { ...recipe, retrievalProfile: retrievalProfileForRecipe(recipe, reviewStatus) };
}

export function activeVersionsPath(root: string) { return join(root, "active-skill-versions.json"); }

export async function readActiveSkillVersions(root: string): Promise<ActiveSkillVersions> {
  try {
    const parsed = JSON.parse(await readFile(activeVersionsPath(root), "utf8")) as ActiveSkillVersions;
    return { schemaVersion: "1.0", updatedAt: parsed.updatedAt || new Date(0).toISOString(), skills: parsed.skills || {} };
  } catch {
    return { schemaVersion: "1.0", updatedAt: new Date(0).toISOString(), skills: {} };
  }
}

export async function writeActiveSkillVersions(root: string, skills: Record<string, string>) {
  await mkdir(root, { recursive: true });
  const path = activeVersionsPath(root);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const value: ActiveSkillVersions = { schemaVersion: "1.0", updatedAt: new Date().toISOString(), skills };
  await writeFile(temporary, JSON.stringify(value, null, 2));
  await rename(temporary, path);
  return value;
}

let activeVersionWrite = Promise.resolve<unknown>(undefined);
export function setActiveSkillVersion(root: string, skillId: string, versionId: string) {
  const update = activeVersionWrite.then(async () => {
    const current = await readActiveSkillVersions(root);
    return writeActiveSkillVersions(root, { ...current.skills, [skillId]: versionId });
  });
  activeVersionWrite = update.catch(() => undefined);
  return update;
}
