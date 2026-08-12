import assert from "node:assert/strict";
import { test } from "node:test";
import { embeddingState, embeddingTexts, removeEmbeddingMetadata, textHashes, type SkillEmbedding } from "./embeddings";

const recipe = {
  metadata: { title: "Editorial portrait", category: "photography" },
  visualDefinition: "A quiet portrait with a restrained editorial hierarchy.",
  coreVisualRelationships: ["soft subject against structured negative space"],
  reuseFormula: "Combine a centered portrait with spare typography and muted contrast."
};

const vector = (createdAt: string): SkillEmbedding => ({
  schemaVersion: "1.0",
  skillId: "skill-1",
  versionId: "version-1",
  requestedModel: "embed-v1",
  actualModel: "embed-v1",
  dimensions: 2,
  createdAt,
  contentHashes: textHashes(embeddingTexts(recipe)),
  vectors: { intent: [1, 0], visual: [1, 0], adaptation: [1, 0] }
});

test("embedding readiness uses signatures rather than timestamps", () => {
  assert.equal(embeddingState(vector("2024-01-01T00:00:00.000Z"), "skill-1", recipe, "embed-v1", "version-1"), "ready");
  assert.equal(embeddingState(vector("2034-01-01T00:00:00.000Z"), "skill-1", recipe, "embed-v1", "version-1"), "ready");
  assert.equal(embeddingState(vector("2034-01-01T00:00:00.000Z"), "skill-1", recipe, "embed-v2", "version-1"), "stale");
  assert.equal(embeddingState(vector("2034-01-01T00:00:00.000Z"), "skill-1", { ...recipe, reuseFormula: "changed" }, "embed-v1", "version-1"), "stale");
  assert.equal(embeddingState({ ...vector("2034-01-01T00:00:00.000Z"), vectors: { intent: [], visual: [1, 0], adaptation: [1, 0] } }, "skill-1", recipe, "embed-v1", "version-1"), "stale");
  assert.equal(embeddingState(undefined, "skill-1", recipe, "embed-v1", "version-1"), "missing");
});

test("Git-managed Skill records discard local embedding metadata", () => {
  const stored = { title: "Skill", embeddingStatus: "ready", embeddingModel: "embed-v1", embeddingUpdatedAt: "now", embeddingError: "old", indexStatus: "hybrid_searchable" };
  assert.deepEqual(removeEmbeddingMetadata(stored), { title: "Skill" });
});
