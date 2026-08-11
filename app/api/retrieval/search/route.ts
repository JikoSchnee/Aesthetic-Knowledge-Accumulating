import { NextResponse } from "next/server";
import type { EmbeddingConfig } from "../../../../src/lib/embeddings";
import { retrieveSkills } from "../../../../src/lib/retrieval";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const { query, embedding, topK, library, excludeIds } = await request.json() as { query?: string; embedding?: EmbeddingConfig; topK?: number; library?: "photo" | "imported_skill" | "all"; excludeIds?: string[] };
  if (!query?.trim()) return NextResponse.json({ results: [], retrievalMode: "keyword" });
  try {
    const global = await retrieveSkills({ query, embedding, topK: 100, library: library || "all", excludeIds });
    const sorted = global.results;
    const photoResults = sorted.filter((item) => item.libraryType === "photo").slice(0, 5);
    const importedSkillResults = sorted.filter((item) => item.libraryType === "imported_skill").slice(0, 5);
    const results = typeof topK === "number" ? sorted.slice(0, Math.max(1, Math.min(10, topK))) : [...photoResults, ...importedSkillResults];
    return NextResponse.json({ photoResults, importedSkillResults, results, retrievalMode: global.retrievalMode, warning: global.warning });
  } catch { return NextResponse.json({ photoResults: [], importedSkillResults: [], results: [], retrievalMode: "keyword", warning: "无法读取本地搜索索引。" }); }
}
