import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { cosine, createQueryEmbedding, hasEmbeddingConfig, isCurrentEmbedding, type EmbeddingConfig, type SkillEmbedding } from "../../../../src/lib/embeddings";
import { locateSkill } from "../../../../src/lib/library";

export const runtime = "nodejs";

const readJson = async <T,>(path: string): Promise<T | undefined> => { try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return undefined; } };
const keywordScore = (query: string, content: string) => {
  const words = query.toLowerCase().split(/[\s,，。！？、]+/).filter((word) => word.length > 1);
  if (!words.length) return 0;
  const haystack = content.toLowerCase();
  return Math.min(1, words.reduce((total, word) => total + (haystack.split(word).length - 1), 0) / (words.length * 2));
};

export async function POST(request: Request) {
  const { query, embedding } = await request.json() as { query?: string; embedding?: EmbeddingConfig };
  if (!query?.trim()) return NextResponse.json({ results: [], retrievalMode: "keyword" });
  const root = process.env.TASTE_STUDIO_DATA_DIR || join(process.cwd(), "data");
  try {
    const cards = await Promise.all((await readdir(join(root, "search-documents"))).filter((file) => file.endsWith(".json")).map(async (file) => JSON.parse(await readFile(join(root, "search-documents", file), "utf8"))));
    let queryVector: number[] | undefined; let warning = "";
    const embeddingConfig = hasEmbeddingConfig(embedding) ? embedding : undefined;
    if (embeddingConfig) {
      try { queryVector = (await createQueryEmbedding(query, embeddingConfig)).vector; }
      catch (error) { warning = error instanceof Error ? `${error.message} 已降级为关键词检索。` : "语义检索不可用，已降级为关键词检索。"; }
    } else warning = "未配置 Embedding API，当前使用关键词检索。";
    const ranked = await Promise.all(cards.map(async (card) => {
      const keyword = keywordScore(query, card.searchText || "");
      let semantic = 0; let matchDimension = "关键词";
      if (queryVector && embeddingConfig && card.embeddingModel === embeddingConfig.model) {
        const located = await locateSkill(root, card.id, card.libraryType === "imported_skill" ? "imported_skill" : "photo");
        const [stored, vector] = await Promise.all([located ? readJson<Record<string, unknown>>(located.path) : undefined, readJson<SkillEmbedding>(join(root, "embeddings", `${card.id}.json`))]);
        if (stored?.recipe && vector && isCurrentEmbedding(vector, card.id, stored.recipe as Record<string, unknown>, embeddingConfig.model) && vector.dimensions === queryVector.length) {
          const intent = cosine(queryVector, vector.vectors.intent) || 0; const visual = cosine(queryVector, vector.vectors.visual) || 0; const adaptation = cosine(queryVector, vector.vectors.adaptation) || 0;
          semantic = intent * 0.45 + visual * 0.4 + adaptation * 0.15;
          matchDimension = ([{ name: "用途意图", score: intent }, { name: "视觉表现", score: visual }, { name: "适配约束", score: adaptation }].sort((a, b) => b.score - a.score)[0].name);
        }
      }
      const score = queryVector ? semantic * 0.85 + keyword * 0.15 : keyword;
      return { ...card, libraryType: card.libraryType || "photo", score: Number(score.toFixed(4)), semanticScore: Number(semantic.toFixed(4)), keywordScore: Number(keyword.toFixed(4)), matchDimension };
    }));
    const retrievalMode = queryVector && ranked.some((item) => item.semanticScore > 0) ? "hybrid" : "keyword";
    if (queryVector && retrievalMode === "keyword" && !warning) warning = "没有与当前 Embedding 模型兼容的向量，已降级为关键词检索。";
    const sorted = ranked.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
    const photoResults = sorted.filter((item) => item.libraryType === "photo").slice(0, 5);
    const importedSkillResults = sorted.filter((item) => item.libraryType === "imported_skill").slice(0, 5);
    return NextResponse.json({ photoResults, importedSkillResults, results: [...photoResults, ...importedSkillResults], retrievalMode, warning: warning || undefined });
  } catch { return NextResponse.json({ photoResults: [], importedSkillResults: [], results: [], retrievalMode: "keyword", warning: "无法读取本地搜索索引。" }); }
}
