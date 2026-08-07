import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { dedupeText, findDuplicateCandidates, type RecipeLike } from "../../../../../src/lib/dedupe";
import { createSkillEmbedding, hasEmbeddingConfig, type EmbeddingConfig } from "../../../../../src/lib/embeddings";
import { TYPOGRAPHY_SCHEMA_VERSION, typographyText } from "../../../../../src/lib/typography";
import { dataRoot, locateSkill, readSkills } from "../../../../../src/lib/library";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[a-f0-9]{64}$/.test(id)) return NextResponse.json({ error: "Invalid recipe id." }, { status: 400 });
  const dataDir = dataRoot();
  try {
    const located = await locateSkill(dataDir, id);
    if (!located) return NextResponse.json({ error: "Recipe not found." }, { status: 404 });
    const recipePath = located.path;
    const stored = JSON.parse(await readFile(recipePath, "utf8"));
    if (stored.status !== "needs_review") return NextResponse.json({ error: "Recipe is not awaiting review." }, { status: 409 });
    const { decision, embedding } = await request.json().catch(() => ({ decision: undefined, embedding: undefined })) as { decision?: "keep_independent"; embedding?: EmbeddingConfig };
    const allRecipes: RecipeLike[] = (await readSkills(dataDir, "all")).filter((item) => item.id !== id) as unknown as RecipeLike[];
    const candidates = findDuplicateCandidates(stored.recipe, allRecipes);
    stored.dedupeText = dedupeText(stored.recipe);
    stored.duplicateCandidates = candidates;
    if (candidates.length && decision !== "keep_independent") {
      await writeFile(recipePath, JSON.stringify(stored, null, 2));
      return NextResponse.json({ error: "Potential duplicate skill requires a decision.", requiresDecision: true, candidates }, { status: 409 });
    }
    if (candidates.length) stored.duplicateDecision = "keep_independent";
    const recipe = stored.recipe;
    const metadata = recipe.metadata || {};
    const typographySearchText = typographyText(recipe.typographyAndGraphicLanguage);
    const searchDocument: Record<string, unknown> = {
      id,
      libraryType: stored.libraryType || located.library,
      title: metadata.title || "Untitled visual recipe",
      category: metadata.category || "Uncategorized",
      medium: metadata.medium || [],
      useCases: metadata.useCases || [],
      tags: metadata.retrievalTags || [],
      coreRelationships: recipe.coreVisualRelationships || [],
      reuseFormula: recipe.reuseFormula || "",
      typographyText: typographySearchText,
      searchText: [metadata.title, metadata.category, ...(metadata.medium || []), ...(metadata.useCases || []), ...(metadata.retrievalTags || []), ...(recipe.coreVisualRelationships || []), recipe.reuseFormula, typographySearchText].filter(Boolean).join(" · "),
      zhAliases: { title: metadata.title || "", useCases: [], tags: [], searchText: "" },
      qualityScore: 0.8,
      specificityScore: 0.8,
      approved: true,
      languages: ["en", "zh-CN"],
      typographyStatus: stored.typographyStatus || "missing",
      typographySchemaVersion: stored.typographySchemaVersion || TYPOGRAPHY_SCHEMA_VERSION,
      recipeSchemaVersion: stored.recipeSchemaVersion || "1.1",
      searchSchemaVersion: "1.1"
    };
    stored.status = "approved";
    let embeddingWarning = "";
    let generatedEmbedding: Awaited<ReturnType<typeof createSkillEmbedding>> | undefined;
    if (hasEmbeddingConfig(embedding)) {
      try {
        generatedEmbedding = await createSkillEmbedding(id, recipe, embedding);
        stored.embeddingStatus = "ready";
        stored.embeddingModel = embedding.model;
        stored.embeddingUpdatedAt = generatedEmbedding.createdAt;
        stored.indexStatus = "hybrid_searchable";
        searchDocument.embeddingStatus = "ready";
        searchDocument.embeddingModel = embedding.model;
        searchDocument.embeddingUpdatedAt = generatedEmbedding.createdAt;
      } catch (error) {
        embeddingWarning = error instanceof Error ? error.message : "向量生成失败。";
        stored.embeddingStatus = "failed";
        stored.embeddingModel = embedding.model;
        stored.embeddingError = embeddingWarning;
        stored.indexStatus = "keyword_only";
        searchDocument.embeddingStatus = "failed";
        searchDocument.embeddingModel = embedding.model;
      }
    } else {
      stored.embeddingStatus = "missing";
      stored.indexStatus = "keyword_only";
      searchDocument.embeddingStatus = "missing";
    }
    stored.approvedAt = new Date().toISOString();
    await mkdir(join(dataDir, "search-documents"), { recursive: true });
    const writes = [writeFile(recipePath, JSON.stringify(stored, null, 2)), writeFile(join(dataDir, "search-documents", `${id}.json`), JSON.stringify(searchDocument, null, 2))];
    if (generatedEmbedding) { await mkdir(join(dataDir, "embeddings"), { recursive: true }); writes.push(writeFile(join(dataDir, "embeddings", `${id}.json`), JSON.stringify(generatedEmbedding, null, 2))); }
    await Promise.all(writes);
    const predecessors = Array.isArray(stored.supersedes) ? stored.supersedes as Array<{ id?: string }> : [];
    for (const predecessor of predecessors) {
      if (!predecessor.id || !/^[a-f0-9]{64}$/.test(predecessor.id)) continue;
      const oldLocated = await locateSkill(dataDir, predecessor.id, "imported_skill");
      if (!oldLocated || oldLocated.library !== "imported_skill") continue;
      try {
        const oldStored = JSON.parse(await readFile(oldLocated.path, "utf8"));
        if (oldStored.status !== "approved") continue;
        oldStored.status = "superseded"; oldStored.supersededBy = id; oldStored.supersededAt = stored.approvedAt;
        await writeFile(oldLocated.path, JSON.stringify(oldStored, null, 2));
        await unlink(join(dataDir, "search-documents", `${predecessor.id}.json`)).catch(() => undefined);
      } catch { /* Keep the newly approved version even if historical cleanup fails. */ }
    }
    return NextResponse.json({ id, libraryType: stored.libraryType || located.library, status: "approved", indexStatus: stored.indexStatus, embeddingStatus: stored.embeddingStatus, warning: embeddingWarning || undefined });
  } catch { return NextResponse.json({ error: "Recipe not found." }, { status: 404 }); }
}
