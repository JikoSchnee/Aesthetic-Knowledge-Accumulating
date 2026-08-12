import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { NextResponse } from "next/server";
import { createSkillEmbedding, hasEmbeddingConfig, removeEmbeddingMetadata, type EmbeddingConfig } from "../../../../src/lib/embeddings";
import { isTypography, TYPOGRAPHY_SCHEMA_VERSION, typographyContract, typographyRules, typographyText } from "../../../../src/lib/typography";
import { retrievalProfileForRecipe, skillIdentity } from "../../../../src/lib/skill-governance";

export const runtime = "nodejs";
export const maxDuration = 300;

type VisionConfig = { endpoint?: string; model?: string; apiKey?: string };
const configured = (value?: VisionConfig): value is Required<VisionConfig> => Boolean(value?.endpoint?.trim() && value.model?.trim() && value.apiKey?.trim());
const dataRoot = () => process.env.TASTE_STUDIO_DATA_DIR || join(process.cwd(), "data");
const readJson = async <T,>(path: string): Promise<T | undefined> => { try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return undefined; } };

function parseObject(content: unknown) {
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => typeof part === "string" ? part : (part as { text?: string }).text || "").join("\n") : "";
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i); const candidate = (fenced ? fenced[1] : text).trim(); const start = candidate.indexOf("{");
  if (start < 0) throw new Error("模型没有返回 JSON 对象。");
  let depth = 0; let quoted = false; let escaped = false;
  for (let index = start; index < candidate.length; index += 1) { const character = candidate[index]; if (quoted) { if (escaped) escaped = false; else if (character === "\\") escaped = true; else if (character === '"') quoted = false; continue; } if (character === '"') quoted = true; else if (character === "{") depth += 1; else if (character === "}" && --depth === 0) return JSON.parse(candidate.slice(start, index + 1).replace(/,\s*([}\]])/g, "$1")); }
  throw new Error("模型返回了不完整的 JSON。");
}

async function analyzeTypography(image: Buffer, extension: string, vision: Required<VisionConfig>) {
  const prompt = `Analyze only the typography and graphic language in this reference. Return ONLY {${typographyContract}} in English. ${typographyRules}`;
  const requestModel = (strict = false) => fetch(`${vision.endpoint.replace(/\/$/, "")}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${vision.apiKey}` }, body: JSON.stringify({ model: vision.model, temperature: 0, response_format: { type: "json_object" }, messages: [{ role: "system", content: strict ? `${prompt} This is a strict retry: no Markdown and no surrounding text.` : prompt }, { role: "user", content: [{ type: "text", text: "Extract reusable typographic structure without copying source wording or brand identity." }, { type: "image_url", image_url: { url: `data:${extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : "image/png"};base64,${image.toString("base64")}` } }] }] }) });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await requestModel(attempt === 1);
    if (!response.ok) throw new Error(`字体分析请求失败（HTTP ${response.status}）。`);
    const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    try { const parsed = parseObject(payload.choices?.[0]?.message?.content) as Record<string, unknown>; if (!isTypography(parsed.typographyAndGraphicLanguage)) throw new Error(); return parsed.typographyAndGraphicLanguage; } catch { if (attempt === 1) throw new Error("模型连续两次未返回有效的字体设计结构。"); }
  }
  throw new Error("字体分析失败。");
}

export async function GET() {
  const root = dataRoot(); const recipesDir = join(root, "recipes"); const uploadsDir = join(root, "uploads", "default");
  try {
    const [recipeFiles, uploadFiles] = await Promise.all([readdir(recipesDir), readdir(uploadsDir)]); const uploads = new Set(uploadFiles.map((file) => file.slice(0, -extname(file).length)));
    const recipes = await Promise.all(recipeFiles.filter((file) => file.endsWith(".json")).map(async (file) => JSON.parse(await readFile(join(recipesDir, file), "utf8"))));
    const approved = recipes.filter((item) => item.status === "approved"); const stats = { total: approved.length, ready: 0, pending: 0, failed: 0, missingSource: 0 };
    for (const item of approved) { if (!uploads.has(item.id)) stats.missingSource += 1; else if (item.typographySchemaVersion === TYPOGRAPHY_SCHEMA_VERSION && isTypography(item.recipe?.typographyAndGraphicLanguage)) stats.ready += 1; else if (item.typographyStatus === "failed") stats.failed += 1; else stats.pending += 1; }
    return NextResponse.json(stats);
  } catch { return NextResponse.json({ total: 0, ready: 0, pending: 0, failed: 0, missingSource: 0 }); }
}

export async function POST(request: Request) {
  const { vision, embedding } = await request.json() as { vision?: VisionConfig; embedding?: EmbeddingConfig };
  if (!configured(vision)) return NextResponse.json({ error: "请先填写视觉模型 Base URL、模型 ID 和 API Key。" }, { status: 400 });
  const root = dataRoot(); const recipesDir = join(root, "recipes"); const uploadsDir = join(root, "uploads", "default"); const searchDir = join(root, "search-documents"); const embeddingsDir = join(root, "embeddings");
  await mkdir(embeddingsDir, { recursive: true });
  const [recipeFiles, uploadFiles] = await Promise.all([readdir(recipesDir), readdir(uploadsDir)]); const uploadMap = new Map(uploadFiles.map((file) => [file.slice(0, -extname(file).length), file]));
  const recipes = (await Promise.all(recipeFiles.filter((file) => file.endsWith(".json")).map(async (file) => JSON.parse(await readFile(join(recipesDir, file), "utf8"))))).filter((item) => item.status === "approved");
  const encoder = new TextEncoder();
  const stream = new ReadableStream({ async start(controller) {
    const emit = (payload: Record<string, unknown>) => controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`)); let succeeded = 0; let skipped = 0; let vectorsRebuilt = 0; const failed: Array<{ id: string; title: string; reason: string }> = [];
    emit({ type: "start", total: recipes.length });
    for (let index = 0; index < recipes.length; index += 1) {
      const stored = recipes[index]; const title = stored.recipe?.metadata?.title || stored.id;
      try {
        if (stored.typographySchemaVersion === TYPOGRAPHY_SCHEMA_VERSION && isTypography(stored.recipe?.typographyAndGraphicLanguage)) skipped += 1;
        else {
          const upload = uploadMap.get(stored.id); if (!upload) throw new Error("本地源图缺失。");
          const typography = await analyzeTypography(await readFile(join(uploadsDir, upload)), extname(upload).toLowerCase(), vision);
          stored.recipe.typographyAndGraphicLanguage = typography; stored.recipeSchemaVersion = "1.2"; stored.typographySchemaVersion = TYPOGRAPHY_SCHEMA_VERSION; stored.typographyStatus = "ready"; stored.typographyModel = vision.model; stored.typographyUpdatedAt = new Date().toISOString(); delete stored.typographyError;
          const searchPath = join(searchDir, `${stored.id}.json`); const search = await readJson<Record<string, unknown>>(searchPath); const typographySearchText = typographyText(typography);
          if (search) { const array = (value: unknown) => Array.isArray(value) ? value : []; const profile = retrievalProfileForRecipe(stored.recipe); search.retrievalProfile = profile; search.typographyText = typographySearchText; search.searchText = [search.title, search.category, ...array(search.medium), ...array(search.useCases), ...array(search.tags), profile.description, ...profile.triggerTerms, ...array(search.coreRelationships), search.reuseFormula, typographySearchText].filter(Boolean).join(" · "); search.typographyStatus = "ready"; search.typographySchemaVersion = TYPOGRAPHY_SCHEMA_VERSION; search.recipeSchemaVersion = "1.2"; search.searchSchemaVersion = "1.2"; }
          if (hasEmbeddingConfig(embedding)) {
            try { const identity = skillIdentity(stored as Record<string, unknown>); const generated = await createSkillEmbedding(identity.skillId, stored.recipe, embedding, identity.versionId); await writeFile(join(embeddingsDir, `${stored.id}.json`), JSON.stringify(generated, null, 2)); vectorsRebuilt += 1; }
            catch { /* The changed recipe remains stale until a later local vector rebuild. */ }
          }
          removeEmbeddingMetadata(stored); if (search) removeEmbeddingMetadata(search);
          await writeFile(join(recipesDir, `${stored.id}.json`), JSON.stringify(stored, null, 2)); if (search) await writeFile(searchPath, JSON.stringify(search, null, 2)); succeeded += 1;
        }
      } catch (error) { stored.typographyStatus = "failed"; stored.typographyModel = vision.model; stored.typographyError = error instanceof Error ? error.message : "字体分析失败。"; removeEmbeddingMetadata(stored); await writeFile(join(recipesDir, `${stored.id}.json`), JSON.stringify(stored, null, 2)); failed.push({ id: stored.id, title, reason: stored.typographyError }); }
      emit({ type: "progress", completed: index + 1, total: recipes.length, succeeded, skipped, failed: failed.length, vectorsRebuilt, title });
    }
    emit({ type: "complete", total: recipes.length, succeeded, skipped, vectorsRebuilt, failed }); controller.close();
  } });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
}
