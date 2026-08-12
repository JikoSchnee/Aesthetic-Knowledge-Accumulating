import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { cosine, createQueryEmbedding, hasEmbeddingConfig, isCurrentEmbedding, type EmbeddingConfig, type SkillEmbedding } from "./embeddings";
import { dataRoot, readSkills, type LibraryType, type StoredSkill } from "./library";
import { readActiveSkillVersions, skillIdentity, type RetrievalProfile } from "./skill-governance";

export type SearchCard = {
  id: string;
  skillId?: string;
  versionId?: string;
  version?: number;
  libraryType?: LibraryType;
  title: string;
  category?: string;
  tags?: string[];
  coreRelationships?: string[];
  reuseFormula?: string;
  searchText?: string;
  retrievalProfile?: RetrievalProfile;
  approved?: boolean;
  [key: string]: unknown;
};

export type RankedSearchCard = SearchCard & {
  skillId: string;
  versionId: string;
  version: number;
  libraryType: LibraryType;
  score: number;
  semanticScore: number;
  keywordScore: number;
  dimensionScores: { intent: number; visual: number; adaptation: number };
  matchDimension: string;
  matchReason: string;
};

export type RetrievalRejectionReason = "pending" | "rejected" | "superseded" | "missing_record" | "version_mismatch" | "library_mismatch" | "excluded" | "invalid_index";
export type RetrievalDiagnostics = {
  indexed: number;
  approved: number;
  eligible: number;
  returned: number;
  rejected: Array<{ skillId?: string; versionId?: string; title?: string; reason: RetrievalRejectionReason }>;
};

export type RetrievalCandidateSnapshot = {
  card: SearchCard & { skillId: string; versionId: string; version: number; libraryType: LibraryType };
  recipe: Record<string, unknown>;
  embedding?: SkillEmbedding;
};

export type RetrievalPool = { candidates: RetrievalCandidateSnapshot[]; diagnostics: RetrievalDiagnostics };

export type RetrievalOptions = {
  query: string;
  embedding?: EmbeddingConfig;
  library?: LibraryType | "all";
  topK?: number;
  excludeIds?: string[];
  root?: string;
  pool?: RetrievalPool;
};

const readJson = async <T,>(path: string): Promise<T | undefined> => {
  try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return undefined; }
};

const libraryOf = (value: unknown): LibraryType => value === "imported_skill" ? "imported_skill" : "photo";
const statusReason = (status: string): RetrievalRejectionReason => status === "rejected" ? "rejected" : status === "superseded" ? "superseded" : "pending";

export function keywordScore(query: string, content: string) {
  const words = query.toLowerCase().split(/[\s,，。！？、]+/).filter((word) => word.length > 1);
  if (!words.length) return 0;
  const haystack = content.toLowerCase();
  return Math.min(1, words.reduce((total, word) => total + (haystack.split(word).length - 1), 0) / (words.length * 2));
}

function derivedActiveVersions(records: StoredSkill[], explicit: Record<string, string>) {
  const active = { ...explicit };
  const approved = records.filter((record) => record.status === "approved").sort((left, right) => {
    const a = skillIdentity(left as unknown as Record<string, unknown>); const b = skillIdentity(right as unknown as Record<string, unknown>);
    return b.version - a.version || String((right as Record<string, unknown>).approvedAt || right.createdAt).localeCompare(String((left as Record<string, unknown>).approvedAt || left.createdAt));
  });
  for (const record of approved) {
    const identity = skillIdentity(record as unknown as Record<string, unknown>);
    active[identity.skillId] ||= identity.versionId;
  }
  return active;
}

export async function buildEligibleSkillPool(options: Omit<RetrievalOptions, "query" | "topK" | "embedding" | "pool"> = {}): Promise<RetrievalPool> {
  const root = options.root || dataRoot();
  const library = options.library || "all";
  const excluded = new Set(options.excludeIds || []);
  const records = await readSkills(root, "all");
  const recordsByVersion = new Map(records.map((record) => [skillIdentity(record as unknown as Record<string, unknown>).versionId, record]));
  const explicit = await readActiveSkillVersions(root);
  const active = derivedActiveVersions(records, explicit.skills);
  const rejected: RetrievalDiagnostics["rejected"] = [];
  const cards: SearchCard[] = [];
  let indexed = 0;
  try {
    const files = (await readdir(join(root, "search-documents"))).filter((file) => file.endsWith(".json"));
    indexed = files.length;
    for (const file of files) {
      const card = await readJson<SearchCard>(join(root, "search-documents", file));
      if (!card) { rejected.push({ versionId: file.slice(0, -5), reason: "invalid_index" }); continue; }
      cards.push(card);
    }
  } catch { /* An empty index produces an empty eligible pool with diagnostics. */ }

  const candidates: RetrievalCandidateSnapshot[] = [];
  const seenVersions = new Set<string>();
  let approved = 0;
  for (const card of cards) {
    const versionId = card.versionId || card.id;
    const record = recordsByVersion.get(versionId);
    if (!record) { rejected.push({ skillId: card.skillId, versionId, title: card.title, reason: "missing_record" }); continue; }
    const identity = skillIdentity(record as unknown as Record<string, unknown>);
    const recordLibrary = libraryOf(record.libraryType);
    seenVersions.add(identity.versionId);
    if (identity.status === "approved") approved += 1;
    if (library !== "all" && recordLibrary !== library) { rejected.push({ skillId: identity.skillId, versionId: identity.versionId, title: card.title, reason: "library_mismatch" }); continue; }
    if (excluded.has(identity.skillId) || excluded.has(identity.versionId) || excluded.has(card.id)) { rejected.push({ skillId: identity.skillId, versionId: identity.versionId, title: card.title, reason: "excluded" }); continue; }
    if (identity.status !== "approved") { rejected.push({ skillId: identity.skillId, versionId: identity.versionId, title: card.title, reason: statusReason(identity.status) }); continue; }
    if (active[identity.skillId] !== identity.versionId) { rejected.push({ skillId: identity.skillId, versionId: identity.versionId, title: card.title, reason: "version_mismatch" }); continue; }
    if ((card.skillId && card.skillId !== identity.skillId) || (card.versionId && card.versionId !== identity.versionId) || card.id !== identity.versionId || card.approved === false) {
      rejected.push({ skillId: identity.skillId, versionId: identity.versionId, title: card.title, reason: "invalid_index" }); continue;
    }
    const embedding = await readJson<SkillEmbedding>(join(root, "embeddings", `${identity.versionId}.json`));
    candidates.push({
      card: { ...card, id: identity.versionId, skillId: identity.skillId, versionId: identity.versionId, version: identity.version, libraryType: recordLibrary },
      recipe: record.recipe || {},
      embedding
    });
  }

  for (const record of records) {
    const identity = skillIdentity(record as unknown as Record<string, unknown>);
    if (seenVersions.has(identity.versionId)) continue;
    const recordLibrary = libraryOf(record.libraryType);
    if (library !== "all" && recordLibrary !== library) continue;
    if (excluded.has(identity.skillId) || excluded.has(identity.versionId)) { rejected.push({ skillId: identity.skillId, versionId: identity.versionId, title: record.recipe?.metadata?.title, reason: "excluded" }); continue; }
    if (identity.status !== "approved") rejected.push({ skillId: identity.skillId, versionId: identity.versionId, title: record.recipe?.metadata?.title, reason: statusReason(identity.status) });
    else { approved += 1; rejected.push({ skillId: identity.skillId, versionId: identity.versionId, title: record.recipe?.metadata?.title, reason: "invalid_index" }); }
  }

  return { candidates, diagnostics: { indexed, approved, eligible: candidates.length, returned: 0, rejected } };
}

export async function rankSkillPool(options: Pick<RetrievalOptions, "query" | "embedding" | "topK"> & { pool: RetrievalPool }) {
  const query = options.query.trim();
  const topK = Math.max(1, Math.min(100, Math.round(options.topK || 5)));
  const diagnostics = { ...options.pool.diagnostics, rejected: [...options.pool.diagnostics.rejected], returned: 0 };
  if (!query) return { results: [] as RankedSearchCard[], retrievalMode: "keyword", warning: undefined as string | undefined, diagnostics, queryVector: undefined as number[] | undefined };

  let queryVector: number[] | undefined;
  let warning = "";
  const embeddingConfig = hasEmbeddingConfig(options.embedding) ? options.embedding : undefined;
  if (embeddingConfig) {
    try { queryVector = (await createQueryEmbedding(query, embeddingConfig)).vector; }
    catch (error) { warning = error instanceof Error ? `${error.message} 已降级为关键词检索。` : "语义检索不可用，已降级为关键词检索。"; }
  } else warning = "未配置 Embedding API，当前使用关键词检索。";

  const ranked = options.pool.candidates.map((candidate): RankedSearchCard => {
    const card = candidate.card;
    const keyword = keywordScore(query, card.searchText || "");
    let semantic = 0;
    let intent = 0; let visual = 0; let adaptation = 0;
    let matchDimension = "关键词";
    const vector = candidate.embedding;
    if (queryVector && embeddingConfig && vector && isCurrentEmbedding(vector, card.skillId, candidate.recipe, embeddingConfig.model, card.versionId) && vector.dimensions === queryVector.length) {
      intent = cosine(queryVector, vector.vectors.intent) || 0;
      visual = cosine(queryVector, vector.vectors.visual) || 0;
      adaptation = cosine(queryVector, vector.vectors.adaptation) || 0;
      semantic = intent * 0.45 + visual * 0.4 + adaptation * 0.15;
      matchDimension = ([{ name: "用途意图", score: intent }, { name: "视觉表现", score: visual }, { name: "适配约束", score: adaptation }].sort((a, b) => b.score - a.score)[0].name);
    }
    const score = queryVector ? semantic * 0.85 + keyword * 0.15 : keyword;
    const roundedSemantic = Number(semantic.toFixed(4));
    const roundedKeyword = Number(keyword.toFixed(4));
    return { ...card, score: Number(score.toFixed(4)), semanticScore: roundedSemantic, keywordScore: roundedKeyword, dimensionScores: { intent: Number(intent.toFixed(4)), visual: Number(visual.toFixed(4)), adaptation: Number(adaptation.toFixed(4)) }, matchDimension, matchReason: `${matchDimension}命中 · 语义 ${Math.round(roundedSemantic * 100)} · 关键词 ${Math.round(roundedKeyword * 100)}` };
  });

  const retrievalMode = queryVector && ranked.some((item) => item.semanticScore > 0) ? "hybrid" : "keyword";
  if (queryVector && retrievalMode === "keyword" && !warning) warning = "没有与当前 Embedding 模型兼容的向量，已降级为关键词检索。";
  const results = ranked.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, topK);
  diagnostics.returned = results.length;
  return { results, retrievalMode, warning: warning || undefined, diagnostics, queryVector };
}

export async function retrieveSkills(options: RetrievalOptions) {
  const pool = options.pool || await buildEligibleSkillPool({ root: options.root, library: options.library, excludeIds: options.excludeIds });
  return rankSkillPool({ query: options.query, embedding: options.embedding, topK: options.topK, pool });
}

export function noEligibleSkillMessage(diagnostics: RetrievalDiagnostics) {
  const rejected = diagnostics.rejected.slice(0, 20).map((item) => `${item.title || item.versionId || item.skillId || "unknown"}: ${item.reason}`).join(", ");
  const more = diagnostics.rejected.length > 20 ? `, +${diagnostics.rejected.length - 20} more` : "";
  return `没有检索到可用于生成的已批准 Skill。indexed=${diagnostics.indexed}, approved=${diagnostics.approved}, eligible=${diagnostics.eligible}, returned=${diagnostics.returned}, rejected=[${rejected}${more}]`;
}
