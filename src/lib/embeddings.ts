import { createHash } from "node:crypto";
import { flattenText } from "./typography";

export type EmbeddingConfig = { endpoint?: string; model?: string; apiKey?: string };
export type RecipeForEmbedding = Record<string, unknown> & { metadata?: Record<string, unknown> };
export type EmbeddingTexts = { intent: string; visual: string; adaptation: string };
export type SkillEmbedding = {
  schemaVersion: "1.0";
  skillId: string;
  versionId?: string;
  requestedModel: string;
  actualModel: string;
  dimensions: number;
  createdAt: string;
  contentHashes: Record<keyof EmbeddingTexts, string>;
  vectors: Record<keyof EmbeddingTexts, number[]>;
};
export type EmbeddingState = "ready" | "stale" | "missing";

const embeddingMetadataFields = ["embeddingStatus", "embeddingModel", "embeddingUpdatedAt", "embeddingError", "indexStatus"] as const;

export function removeEmbeddingMetadata<T extends Record<string, unknown>>(record: T) {
  for (const field of embeddingMetadataFields) delete record[field];
  return record;
}

const object = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const join = (parts: unknown[]) => parts.flatMap(flattenText).join(" · ");

export function embeddingTexts(recipe: RecipeForEmbedding): EmbeddingTexts {
  const metadata = object(recipe.metadata);
  const composition = object(recipe.compositionAndHierarchy);
  const space = object(recipe.spaceAndOverlap);
  const color = object(recipe.colorSystem);
  const light = object(recipe.lightAndAtmosphere);
  const material = object(recipe.materialAndProcess);
  const typography = object(recipe.typographyAndGraphicLanguage);
  const floor = object(recipe.aestheticFloor);
  const retrieval = object(recipe.retrievalProfile);
  return {
    intent: join([metadata.title, metadata.category, metadata.medium, metadata.useCases, metadata.retrievalTags, retrieval.description, retrieval.triggerTerms, recipe.visualDefinition]),
    visual: join([recipe.visualDefinition, recipe.coreVisualRelationships, recipe.coreInvariants, ...Object.values(composition), ...Object.values(space), ...Object.values(color), ...Object.values(light), ...Object.values(material), ...Object.values(typography)]),
    adaptation: join([recipe.reuseFormula, recipe.adjustableVariables, recipe.mustRedesign, ...Object.values(floor), recipe.postGenerationChecks])
  };
}

export function hashText(value: string) { return createHash("sha256").update(value).digest("hex"); }
export function textHashes(texts: EmbeddingTexts) { return { intent: hashText(texts.intent), visual: hashText(texts.visual), adaptation: hashText(texts.adaptation) }; }

export function hasEmbeddingConfig(config?: EmbeddingConfig): config is Required<EmbeddingConfig> {
  return Boolean(config?.endpoint?.trim() && config.model?.trim() && config.apiKey?.trim());
}

export async function createSkillEmbedding(skillId: string, recipe: RecipeForEmbedding, config: Required<EmbeddingConfig>, versionId = skillId): Promise<SkillEmbedding> {
  const texts = embeddingTexts(recipe);
  if (!texts.intent || !texts.visual || !texts.adaptation) throw new Error("Recipe lacks enough text to create retrieval vectors.");
  const response = await fetch(`${config.endpoint.replace(/\/$/, "")}/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({ model: config.model, input: [texts.intent, texts.visual, texts.adaptation], encoding_format: "float" })
  });
  if (!response.ok) throw new Error(`向量请求失败（HTTP ${response.status}）。`);
  const payload = await response.json() as { model?: string; data?: Array<{ index?: number; embedding?: number[] }> };
  const ordered = (payload.data || []).sort((a, b) => (a.index || 0) - (b.index || 0)).map((item) => item.embedding || []);
  if (ordered.length !== 3 || ordered.some((vector) => !vector.length) || new Set(ordered.map((vector) => vector.length)).size !== 1) throw new Error("向量服务返回了无效的向量组。");
  return { schemaVersion: "1.0", skillId, versionId, requestedModel: config.model, actualModel: payload.model || config.model, dimensions: ordered[0].length, createdAt: new Date().toISOString(), contentHashes: textHashes(texts), vectors: { intent: ordered[0], visual: ordered[1], adaptation: ordered[2] } };
}

export async function createQueryEmbedding(query: string, config: Required<EmbeddingConfig>) {
  const response = await fetch(`${config.endpoint.replace(/\/$/, "")}/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({ model: config.model, input: query, encoding_format: "float" })
  });
  if (!response.ok) throw new Error(`向量请求失败（HTTP ${response.status}）。`);
  const payload = await response.json() as { model?: string; data?: Array<{ embedding?: number[] }> };
  const vector = payload.data?.[0]?.embedding;
  if (!vector?.length) throw new Error("向量服务未返回查询向量。");
  return { vector, model: payload.model || config.model };
}

export function isCurrentEmbedding(embedding: SkillEmbedding | undefined, skillId: string, recipe: RecipeForEmbedding, model: string, versionId = skillId) {
  if (!embedding || embedding.skillId !== skillId || (embedding.versionId || embedding.skillId) !== versionId || embedding.requestedModel !== model) return false;
  if (!Number.isSafeInteger(embedding.dimensions) || embedding.dimensions <= 0 || (Object.keys(embedding.vectors || {}) as Array<keyof EmbeddingTexts>).length !== 3 || (Object.keys(embeddingTexts(recipe)) as Array<keyof EmbeddingTexts>).some((key) => !Array.isArray(embedding.vectors[key]) || embedding.vectors[key].length !== embedding.dimensions)) return false;
  const hashes = textHashes(embeddingTexts(recipe));
  return (Object.keys(hashes) as Array<keyof EmbeddingTexts>).every((key) => hashes[key] === embedding.contentHashes[key]);
}

export function embeddingState(embedding: SkillEmbedding | undefined, skillId: string, recipe: RecipeForEmbedding, model?: string, versionId = skillId): EmbeddingState {
  if (!embedding) return "missing";
  return isCurrentEmbedding(embedding, skillId, recipe, model?.trim() || embedding.requestedModel, versionId) ? "ready" : "stale";
}

export function cosine(a: number[], b: number[]) {
  if (a.length !== b.length || !a.length) return null;
  let dot = 0; let left = 0; let right = 0;
  for (let index = 0; index < a.length; index += 1) { dot += a[index] * b[index]; left += a[index] * a[index]; right += b[index] * b[index]; }
  return left && right ? dot / Math.sqrt(left * right) : null;
}
