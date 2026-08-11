import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { cosine, createQueryEmbedding, hasEmbeddingConfig, isCurrentEmbedding, type EmbeddingConfig, type SkillEmbedding } from "./embeddings";
import { dataRoot, locateSkill, type LibraryType } from "./library";

export type SearchCard = {
  id: string;
  libraryType?: LibraryType;
  title: string;
  category?: string;
  tags?: string[];
  coreRelationships?: string[];
  reuseFormula?: string;
  searchText?: string;
  [key: string]: unknown;
};

export type RankedSearchCard = SearchCard & {
  libraryType: LibraryType;
  score: number;
  semanticScore: number;
  keywordScore: number;
  matchDimension: string;
  matchReason: string;
};

export type RetrievalOptions = {
  query: string;
  embedding?: EmbeddingConfig;
  library?: LibraryType | "all";
  topK?: number;
  excludeIds?: string[];
  root?: string;
};

const readJson = async <T,>(path: string): Promise<T | undefined> => {
  try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return undefined; }
};

export function keywordScore(query: string, content: string) {
  const words = query.toLowerCase().split(/[\s,，。！？、]+/).filter((word) => word.length > 1);
  if (!words.length) return 0;
  const haystack = content.toLowerCase();
  return Math.min(1, words.reduce((total, word) => total + (haystack.split(word).length - 1), 0) / (words.length * 2));
}

export async function retrieveSkills(options: RetrievalOptions) {
  const root = options.root || dataRoot();
  const query = options.query.trim();
  const topK = Math.max(1, Math.min(100, Math.round(options.topK || 5)));
  const library = options.library || "all";
  const excluded = new Set(options.excludeIds || []);
  if (!query) return { results: [] as RankedSearchCard[], retrievalMode: "keyword", warning: undefined as string | undefined };

  let cards: SearchCard[] = [];
  try {
    cards = await Promise.all((await readdir(join(root, "search-documents")))
      .filter((file) => file.endsWith(".json"))
      .map(async (file) => JSON.parse(await readFile(join(root, "search-documents", file), "utf8")) as SearchCard));
  } catch {
    return { results: [] as RankedSearchCard[], retrievalMode: "keyword", warning: "无法读取本地搜索索引。" };
  }
  cards = cards.filter((card) => !excluded.has(card.id) && (library === "all" || (card.libraryType || "photo") === library));

  let queryVector: number[] | undefined;
  let warning = "";
  const embeddingConfig = hasEmbeddingConfig(options.embedding) ? options.embedding : undefined;
  if (embeddingConfig) {
    try { queryVector = (await createQueryEmbedding(query, embeddingConfig)).vector; }
    catch (error) { warning = error instanceof Error ? `${error.message} 已降级为关键词检索。` : "语义检索不可用，已降级为关键词检索。"; }
  } else warning = "未配置 Embedding API，当前使用关键词检索。";

  const ranked = await Promise.all(cards.map(async (card): Promise<RankedSearchCard> => {
    const keyword = keywordScore(query, card.searchText || "");
    let semantic = 0;
    let matchDimension = "关键词";
    const libraryType = card.libraryType === "imported_skill" ? "imported_skill" : "photo";
    if (queryVector && embeddingConfig) {
      const located = await locateSkill(root, card.id, libraryType);
      const [stored, vector] = await Promise.all([
        located ? readJson<Record<string, unknown>>(located.path) : undefined,
        readJson<SkillEmbedding>(join(root, "embeddings", `${card.id}.json`))
      ]);
      if (stored?.recipe && vector && isCurrentEmbedding(vector, card.id, stored.recipe as Record<string, unknown>, embeddingConfig.model) && vector.dimensions === queryVector.length) {
        const intent = cosine(queryVector, vector.vectors.intent) || 0;
        const visual = cosine(queryVector, vector.vectors.visual) || 0;
        const adaptation = cosine(queryVector, vector.vectors.adaptation) || 0;
        semantic = intent * 0.45 + visual * 0.4 + adaptation * 0.15;
        matchDimension = ([{ name: "用途意图", score: intent }, { name: "视觉表现", score: visual }, { name: "适配约束", score: adaptation }].sort((a, b) => b.score - a.score)[0].name);
      }
    }
    const score = queryVector ? semantic * 0.85 + keyword * 0.15 : keyword;
    const roundedSemantic = Number(semantic.toFixed(4));
    const roundedKeyword = Number(keyword.toFixed(4));
    return {
      ...card,
      libraryType,
      score: Number(score.toFixed(4)),
      semanticScore: roundedSemantic,
      keywordScore: roundedKeyword,
      matchDimension,
      matchReason: `${matchDimension}命中 · 语义 ${Math.round(roundedSemantic * 100)} · 关键词 ${Math.round(roundedKeyword * 100)}`
    };
  }));

  const retrievalMode = queryVector && ranked.some((item) => item.semanticScore > 0) ? "hybrid" : "keyword";
  if (queryVector && retrievalMode === "keyword" && !warning) warning = "没有与当前 Embedding 模型兼容的向量，已降级为关键词检索。";
  return {
    results: ranked.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, topK),
    retrievalMode,
    warning: warning || undefined
  };
}
