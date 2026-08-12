import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { dedupeText, findDuplicateCandidates, type RecipeLike } from "../../../../../src/lib/dedupe";
import { createSkillEmbedding, hasEmbeddingConfig, removeEmbeddingMetadata, type EmbeddingConfig } from "../../../../../src/lib/embeddings";
import { TYPOGRAPHY_SCHEMA_VERSION, typographyText } from "../../../../../src/lib/typography";
import { dataRoot, locateSkill, readSkills } from "../../../../../src/lib/library";
import { applyRetrievalProfile, retrievalProfileForRecipe, setActiveSkillVersion, skillIdentity } from "../../../../../src/lib/skill-governance";

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
    removeEmbeddingMetadata(stored);
    if (stored.status !== "needs_review") return NextResponse.json({ error: "Recipe is not awaiting review." }, { status: 409 });
    const identity = skillIdentity(stored);
    stored.skillId = identity.skillId; stored.versionId = identity.versionId; stored.version = identity.version;
    const { decision, embedding } = await request.json().catch(() => ({ decision: undefined, embedding: undefined })) as { decision?: "keep_independent"; embedding?: EmbeddingConfig };
    const allRecipes: RecipeLike[] = (await readSkills(dataDir, "all")).filter((item) => {
      if (item.id === id) return false;
      return skillIdentity(item as unknown as Record<string, unknown>).skillId !== identity.skillId;
    }) as unknown as RecipeLike[];
    const candidates = findDuplicateCandidates(stored.recipe, allRecipes);
    stored.dedupeText = dedupeText(stored.recipe);
    stored.duplicateCandidates = candidates;
    if (candidates.length && decision !== "keep_independent") {
      await writeFile(recipePath, JSON.stringify(stored, null, 2));
      return NextResponse.json({ error: "Potential duplicate skill requires a decision.", requiresDecision: true, candidates }, { status: 409 });
    }
    if (candidates.length) stored.duplicateDecision = "keep_independent";
    const recipe = applyRetrievalProfile(stored.recipe) as Record<string, unknown> & {
      metadata?: { title?: string; category?: string; medium?: string[]; useCases?: string[]; retrievalTags?: string[] };
      typographyAndGraphicLanguage?: Parameters<typeof typographyText>[0];
      coreVisualRelationships?: string[];
      reuseFormula?: string;
    };
    stored.recipe = recipe;
    const metadata = recipe.metadata || {};
    const typographySearchText = typographyText(recipe.typographyAndGraphicLanguage);
    const searchDocument: Record<string, unknown> = {
      id,
      skillId: identity.skillId,
      versionId: identity.versionId,
      version: identity.version,
      libraryType: stored.libraryType || located.library,
      title: metadata.title || "Untitled visual recipe",
      category: metadata.category || "Uncategorized",
      medium: metadata.medium || [],
      useCases: metadata.useCases || [],
      tags: metadata.retrievalTags || [],
      coreRelationships: recipe.coreVisualRelationships || [],
      reuseFormula: recipe.reuseFormula || "",
      retrievalProfile: retrievalProfileForRecipe(recipe),
      typographyText: typographySearchText,
      searchText: [metadata.title, metadata.category, ...(metadata.medium || []), ...(metadata.useCases || []), ...(metadata.retrievalTags || []), retrievalProfileForRecipe(recipe).description, ...retrievalProfileForRecipe(recipe).triggerTerms, ...(recipe.coreVisualRelationships || []), recipe.reuseFormula, typographySearchText].filter(Boolean).join(" · "),
      zhAliases: { title: metadata.title || "", useCases: [], tags: [], searchText: "" },
      qualityScore: 0.8,
      specificityScore: 0.8,
      approved: true,
      languages: ["en", "zh-CN"],
      typographyStatus: stored.typographyStatus || "missing",
      typographySchemaVersion: stored.typographySchemaVersion || TYPOGRAPHY_SCHEMA_VERSION,
      recipeSchemaVersion: "1.2",
      searchSchemaVersion: "1.2"
    };
    stored.recipeSchemaVersion = "1.2";
    stored.status = "approved";
    let embeddingWarning = "";
    let generatedEmbedding: Awaited<ReturnType<typeof createSkillEmbedding>> | undefined;
    if (hasEmbeddingConfig(embedding)) {
      try {
        generatedEmbedding = await createSkillEmbedding(identity.skillId, recipe, embedding, identity.versionId);
      } catch (error) {
        embeddingWarning = error instanceof Error ? error.message : "向量生成失败。";
      }
    }
    stored.approvedAt = new Date().toISOString();
    await mkdir(join(dataDir, "search-documents"), { recursive: true });
    const writes = [writeFile(recipePath, JSON.stringify(stored, null, 2)), writeFile(join(dataDir, "search-documents", `${id}.json`), JSON.stringify(searchDocument, null, 2))];
    if (generatedEmbedding) { await mkdir(join(dataDir, "embeddings"), { recursive: true }); writes.push(writeFile(join(dataDir, "embeddings", `${id}.json`), JSON.stringify(generatedEmbedding, null, 2))); }
    await Promise.all(writes);
    await setActiveSkillVersion(dataDir, identity.skillId, identity.versionId);
    const sameSkillVersions = (await readSkills(dataDir, "all")).filter((item) => {
      const other = skillIdentity(item as unknown as Record<string, unknown>);
      return other.skillId === identity.skillId && other.versionId !== identity.versionId && item.status === "approved";
    });
    const predecessors = [...sameSkillVersions.map((item) => ({ id: item.id })), ...(Array.isArray(stored.supersedes) ? stored.supersedes as Array<{ id?: string }> : [])];
    const handled = new Set<string>();
    for (const predecessor of predecessors) {
      if (!predecessor.id || handled.has(predecessor.id) || !/^[a-f0-9]{64}$/.test(predecessor.id)) continue;
      handled.add(predecessor.id);
      const oldLocated = await locateSkill(dataDir, predecessor.id);
      if (!oldLocated) continue;
      try {
        const oldStored = JSON.parse(await readFile(oldLocated.path, "utf8"));
        if (oldStored.status !== "approved") continue;
        oldStored.status = "superseded"; oldStored.supersededBy = id; oldStored.supersededAt = stored.approvedAt;
        await writeFile(oldLocated.path, JSON.stringify(oldStored, null, 2));
        await unlink(join(dataDir, "search-documents", `${predecessor.id}.json`)).catch(() => undefined);
      } catch { /* Keep the newly approved version even if historical cleanup fails. */ }
    }
    const embeddingStatus = generatedEmbedding ? "ready" : "missing";
    return NextResponse.json({ id, libraryType: stored.libraryType || located.library, status: "approved", embeddingStatus, warning: embeddingWarning || undefined });
  } catch { return NextResponse.json({ error: "Recipe not found." }, { status: 404 }); }
}
