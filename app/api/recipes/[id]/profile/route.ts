import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { removeEmbeddingMetadata } from "../../../../../src/lib/embeddings";
import { dataRoot, locateSkill } from "../../../../../src/lib/library";
import { validateRetrievalProfile } from "../../../../../src/lib/skill-governance";

export const runtime = "nodejs";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[a-f0-9]{64}$/.test(id)) return NextResponse.json({ error: "Invalid recipe id." }, { status: 400 });
  try {
    const root = dataRoot(); const located = await locateSkill(root, id);
    if (!located) return NextResponse.json({ error: "Recipe not found." }, { status: 404 });
    const stored = JSON.parse(await readFile(located.path, "utf8")) as Record<string, unknown> & { status?: string; recipe?: Record<string, unknown> };
    if (["rejected", "superseded"].includes(stored.status || "")) return NextResponse.json({ error: "该版本不可再编辑检索 Profile。" }, { status: 409 });
    const profile = validateRetrievalProfile((await request.json()).retrievalProfile);
    stored.recipe = { ...(stored.recipe || {}), retrievalProfile: profile };
    if (stored.status === "approved") {
      const searchPath = join(root, "search-documents", `${id}.json`);
      const search = JSON.parse(await readFile(searchPath, "utf8")) as Record<string, unknown>;
      const positive = [search.title, search.category, ...(Array.isArray(search.medium) ? search.medium : []), ...(Array.isArray(search.useCases) ? search.useCases : []), ...(Array.isArray(search.tags) ? search.tags : []), profile.description, ...profile.triggerTerms, ...(Array.isArray(search.coreRelationships) ? search.coreRelationships : []), search.reuseFormula, search.typographyText].filter(Boolean).join(" · ");
      search.retrievalProfile = profile; search.searchText = positive; removeEmbeddingMetadata(search);
      await writeFile(searchPath, JSON.stringify(search, null, 2));
    }
    removeEmbeddingMetadata(stored);
    await writeFile(located.path, JSON.stringify(stored, null, 2));
    return NextResponse.json({ id, retrievalProfile: profile });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "无法保存 Retrieval Profile。" }, { status: 400 }); }
}
