import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createSkillEmbedding, hasEmbeddingConfig, isCurrentEmbedding, type EmbeddingConfig, type SkillEmbedding } from "../../../../src/lib/embeddings";
import { NextResponse } from "next/server";
import { dataRoot, readSkills, recipeDirectory } from "../../../../src/lib/library";
import { skillIdentity } from "../../../../src/lib/skill-governance";

export const runtime = "nodejs";
export const maxDuration = 300;

const readJson = async <T,>(path: string): Promise<T | undefined> => { try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return undefined; } };

export async function GET() {
  const root = dataRoot(); const embeddingDir = join(root, "embeddings");
  try {
    const approved = (await readSkills(root, "all")).filter((recipe) => recipe.status === "approved");
    const stats = { total: approved.length, ready: 0, pending: 0, failed: 0, stale: 0 };
    for (const recipe of approved) {
      const embedding = await readJson<SkillEmbedding>(join(embeddingDir, `${recipe.id}.json`));
      const identity = skillIdentity(recipe as unknown as Record<string, unknown>);
      if (embedding && recipe.embeddingModel && isCurrentEmbedding(embedding, identity.skillId, recipe.recipe, recipe.embeddingModel, identity.versionId)) stats.ready += 1;
      else if (recipe.embeddingStatus === "failed") stats.failed += 1;
      else if (embedding) stats.stale += 1;
      else stats.pending += 1;
    }
    return NextResponse.json(stats);
  } catch { return NextResponse.json({ total: 0, ready: 0, pending: 0, failed: 0, stale: 0 }); }
}

export async function POST(request: Request) {
  const { embedding } = await request.json() as { embedding?: EmbeddingConfig };
  if (!hasEmbeddingConfig(embedding)) return NextResponse.json({ error: "请先填写 Embedding Base URL、模型 ID 和 API Key。" }, { status: 400 });
  const root = dataRoot(); const embeddingsDir = join(root, "embeddings"); const searchDir = join(root, "search-documents");
  await mkdir(embeddingsDir, { recursive: true });
  const approved = (await readSkills(root, "all")).filter((recipe) => recipe.status === "approved");
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (payload: Record<string, unknown>) => controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
      let succeeded = 0; let skipped = 0; const failed: Array<{ id: string; title: string; reason: string }> = [];
      emit({ type: "start", total: approved.length });
      for (let index = 0; index < approved.length; index += 1) {
        const stored = approved[index]; const title = stored.recipe?.metadata?.title || stored.id;
        try {
          const identity = skillIdentity(stored as unknown as Record<string, unknown>);
          const existing = await readJson<SkillEmbedding>(join(embeddingsDir, `${stored.id}.json`));
          if (isCurrentEmbedding(existing, identity.skillId, stored.recipe, embedding.model, identity.versionId)) {
            stored.embeddingStatus = "ready"; stored.embeddingModel = embedding.model; stored.embeddingUpdatedAt = existing?.createdAt; stored.indexStatus = "hybrid_searchable";
            const searchPath = join(searchDir, `${stored.id}.json`); const search = await readJson<Record<string, unknown>>(searchPath);
            if (search) { search.embeddingStatus = "ready"; search.embeddingModel = embedding.model; search.embeddingUpdatedAt = existing?.createdAt; await writeFile(searchPath, JSON.stringify(search, null, 2)); }
            await writeFile(join(recipeDirectory(root, stored.libraryType || "photo"), `${stored.id}.json`), JSON.stringify(stored, null, 2)); skipped += 1;
          }
          else {
            const generated = await createSkillEmbedding(identity.skillId, stored.recipe, embedding, identity.versionId);
            stored.embeddingStatus = "ready"; stored.embeddingModel = embedding.model; stored.embeddingUpdatedAt = generated.createdAt; stored.indexStatus = "hybrid_searchable";
            await writeFile(join(embeddingsDir, `${stored.id}.json`), JSON.stringify(generated, null, 2));
            const searchPath = join(searchDir, `${stored.id}.json`); const search = await readJson<Record<string, unknown>>(searchPath);
            if (search) { search.embeddingStatus = "ready"; search.embeddingModel = embedding.model; search.embeddingUpdatedAt = generated.createdAt; await writeFile(searchPath, JSON.stringify(search, null, 2)); }
            await writeFile(join(recipeDirectory(root, stored.libraryType || "photo"), `${stored.id}.json`), JSON.stringify(stored, null, 2)); succeeded += 1;
          }
        } catch (error) {
          stored.embeddingStatus = "failed"; stored.embeddingModel = embedding.model; stored.embeddingError = error instanceof Error ? error.message : "Embedding failed."; stored.indexStatus = "keyword_only";
          await writeFile(join(recipeDirectory(root, stored.libraryType || "photo"), `${stored.id}.json`), JSON.stringify(stored, null, 2));
          const searchPath = join(searchDir, `${stored.id}.json`); const search = await readJson<Record<string, unknown>>(searchPath);
          if (search) { search.embeddingStatus = "failed"; search.embeddingModel = embedding.model; await writeFile(searchPath, JSON.stringify(search, null, 2)); }
          failed.push({ id: stored.id, title, reason: stored.embeddingError });
        }
        emit({ type: "progress", completed: index + 1, total: approved.length, succeeded, skipped, failed: failed.length, title });
      }
      emit({ type: "complete", total: approved.length, succeeded, skipped, failed }); controller.close();
    }
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
}
