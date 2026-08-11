import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { embeddingTexts, type EmbeddingConfig } from "./embeddings";
import { isGenerationTransientError, resolveGeneratedImage, pollGeneration, submitGeneration, type GenerationSubmission } from "./image-generation";
import { imageGenerationSettingsFromEnv, type ImageGenerationSettings } from "./image-generation-settings";
import { dataRoot, locateSkill, type LibraryType } from "./library";
import { imageRecipePrompt, parseValidRecipe } from "./recipe-schema";
import { retrieveSkills, type RankedSearchCard } from "./retrieval";

export const EVAL_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const EVAL_MAX_CONCURRENCY = 8;
export const EVAL_MAX_RETRIES = 3;
const evalRetryDelays = [1000, 3000, 9000];
export type EvalCase = { id: string; filename: string; extension: "jpg" | "png" | "webp"; mime: string; size: number; createdAt: string };
export type EvalStage = "pending_analysis" | "pending_retrieval" | "pending_generation" | "waiting_generation" | "completed" | "failed";
type EvalCopyLanguage = "en" | "zh";
type EvalTextSuggestion = { language: EvalCopyLanguage; copy: string };
export type EvalCaseRun = {
  caseId: string;
  filename: string;
  stage: EvalStage;
  analysis?: Record<string, unknown>;
  retrievalMode?: string;
  retrievalWarning?: string;
  matches?: RankedSearchCard[];
  prompt?: string;
  remoteId?: string;
  remoteState?: string;
  resultFile?: string;
  error?: string;
  retryCount?: number;
  nextRetryAt?: string;
  lastTransientError?: string;
  timings: Partial<Record<"analysis" | "retrieval" | "generation" | "download", number>>;
};
export type EvalRun = {
  schemaVersion: "1.0";
  id: string;
  createdAt: string;
  updatedAt: string;
  status: "running" | "paused" | "completed";
  config: Omit<ImageGenerationSettings, "apiKey"> & { topK: number; library: LibraryType | "all"; concurrency?: number };
  cases: EvalCaseRun[];
};

const supportedMime = new Map([["image/jpeg", "jpg"], ["image/png", "png"], ["image/webp", "webp"]] as const);
const safeId = (value: string) => /^[a-f0-9-]{16,64}$/i.test(value);
export const evalRoot = () => join(process.cwd(), "eval-cases");
export const evalImagesDir = () => join(evalRoot(), "images");
export const evalRunsDir = () => join(evalRoot(), "runs");

function imageFormat(bytes: Buffer) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: "image/png", extension: "png" as const };
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mime: "image/jpeg", extension: "jpg" as const };
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return { mime: "image/webp", extension: "webp" as const };
  return undefined;
}

export async function ensureEvalDirectories() {
  await Promise.all([mkdir(evalImagesDir(), { recursive: true }), mkdir(evalRunsDir(), { recursive: true })]);
}

export async function listEvalCases(): Promise<EvalCase[]> {
  await ensureEvalDirectories();
  const cases = await Promise.all((await readdir(evalImagesDir())).filter((file) => /\.(jpe?g|png|webp)$/i.test(file)).map(async (filename) => {
    const path = join(evalImagesDir(), basename(filename));
    const [bytes, info] = await Promise.all([readFile(path), stat(path)]);
    const format = imageFormat(bytes);
    if (!format || bytes.length > EVAL_MAX_IMAGE_BYTES) return undefined;
    const id = createHash("sha256").update(bytes).digest("hex");
    return { id, filename, extension: format.extension, mime: format.mime, size: info.size, createdAt: info.birthtime.toISOString() } satisfies EvalCase;
  }));
  return cases.filter((item): item is EvalCase => Boolean(item)).sort((a, b) => a.filename.localeCompare(b.filename));
}

export async function addEvalCases(files: File[]) {
  await ensureEvalDirectories();
  const added: EvalCase[] = [];
  const duplicates: string[] = [];
  const existing = await listEvalCases();
  const existingIds = new Set(existing.map((item) => item.id));
  for (const file of files) {
    if (!supportedMime.has(file.type as "image/jpeg" | "image/png" | "image/webp") || file.size > EVAL_MAX_IMAGE_BYTES) throw new Error(`${file.name} 必须是 JPEG、PNG 或 WebP，且不超过 20MB。`);
    const bytes = Buffer.from(await file.arrayBuffer());
    const format = imageFormat(bytes);
    if (!format || format.mime !== file.type) throw new Error(`${file.name} 的文件内容与 MIME 类型不一致。`);
    const id = createHash("sha256").update(bytes).digest("hex");
    if (existingIds.has(id)) { duplicates.push(file.name); continue; }
    const stem = basename(file.name, extname(file.name)).replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "eval-case";
    let filename = `${stem}.${format.extension}`;
    let index = 2;
    const names = new Set([...existing, ...added].map((item) => item.filename));
    while (names.has(filename)) { filename = `${stem}-${index}.${format.extension}`; index += 1; }
    await writeFile(join(evalImagesDir(), filename), bytes, { flag: "wx" });
    const item = { id, filename, extension: format.extension, mime: format.mime, size: bytes.length, createdAt: new Date().toISOString() };
    existingIds.add(id); added.push(item);
  }
  return { added, duplicates, cases: [...existing, ...added].sort((a, b) => a.filename.localeCompare(b.filename)) };
}

async function atomicJson(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2));
  await rename(temporary, path);
}

export async function listEvalRuns() {
  await ensureEvalDirectories();
  const runs = await Promise.all((await readdir(evalRunsDir(), { withFileTypes: true })).filter((item) => item.isDirectory() && safeId(item.name)).map(async (item) => {
    try { return JSON.parse(await readFile(join(evalRunsDir(), item.name, "manifest.json"), "utf8")) as EvalRun; } catch { return undefined; }
  }));
  return runs.filter((item): item is EvalRun => Boolean(item)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function readEvalRun(id: string) {
  if (!safeId(id)) throw new Error("无效的 Eval Run ID。");
  return JSON.parse(await readFile(join(evalRunsDir(), id, "manifest.json"), "utf8")) as EvalRun;
}

async function saveEvalRun(run: EvalRun) {
  run.updatedAt = new Date().toISOString();
  await atomicJson(join(evalRunsDir(), run.id, "manifest.json"), run);
  return run;
}

export function evalConcurrency(value: unknown) {
  const parsed = Number(value);
  return Math.max(1, Math.min(EVAL_MAX_CONCURRENCY, Number.isFinite(parsed) ? Math.round(parsed) : 3));
}

export function scheduleEvalRetry(item: EvalCaseRun, error: Error, now = Date.now()) {
  const retryCount = (item.retryCount || 0) + 1;
  item.retryCount = retryCount;
  if (retryCount > EVAL_MAX_RETRIES) return false;
  item.lastTransientError = error.message.slice(0, 500);
  item.nextRetryAt = new Date(now + evalRetryDelays[retryCount - 1]).toISOString();
  return true;
}

export function isEvalRetryDue(item: EvalCaseRun, now = Date.now()) {
  return !item.nextRetryAt || Date.parse(item.nextRetryAt) <= now;
}

function clearEvalRetrySchedule(item: EvalCaseRun) {
  delete item.nextRetryAt;
  delete item.lastTransientError;
}

export async function createEvalRun(input: { caseIds?: string[]; topK?: number; library?: LibraryType | "all"; concurrency?: number }) {
  const cases = await listEvalCases();
  const selected = input.caseIds?.length ? cases.filter((item) => input.caseIds?.includes(item.id)) : cases;
  if (!selected.length) throw new Error("请先添加至少一张 Eval 图片。");
  const settings = imageGenerationSettingsFromEnv();
  if (!settings.apiKey) throw new Error("请先在 API 配置中保存生图 API Key。");
  if (!process.env.VISION_API_KEY || !process.env.VISION_ENDPOINT || !process.env.VISION_MODEL) throw new Error("请先保存视觉分析 API 配置。");
  const now = new Date().toISOString();
  const id = `${Date.now().toString(16)}-${randomUUID()}`;
  const directory = join(evalRunsDir(), id);
  await mkdir(directory, { recursive: true });
  const { apiKey: _secret, ...snapshot } = settings;
  const run: EvalRun = {
    schemaVersion: "1.0", id, createdAt: now, updatedAt: now, status: "running",
    config: { ...snapshot, topK: Math.max(1, Math.min(10, Math.round(input.topK || 3))), library: input.library === "photo" || input.library === "imported_skill" ? input.library : "all", concurrency: evalConcurrency(input.concurrency) },
    cases: selected.map((item) => ({ caseId: item.id, filename: item.filename, stage: "pending_analysis", timings: {} }))
  };
  await saveEvalRun(run);
  return run;
}

async function analyzeEvalImage(path: string, mime: string) {
  const image = await readFile(path);
  const endpoint = process.env.VISION_ENDPOINT || "";
  const model = process.env.VISION_MODEL || "";
  const apiKey = process.env.VISION_API_KEY || "";
  const request = async (strict = false) => fetch(`${endpoint.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, temperature: strict ? 0 : 0.2, response_format: { type: "json_object" }, messages: [{ role: "system", content: `${imageRecipePrompt} Also include an evalTextSuggestion object with language (en or zh) and copy. The copy must be a meaningful, original title grounded in the depicted subject, scene, or mood; never transcribe source text, brands, or logos. Use the source writing system when clear; otherwise use English. English copy must contain 1 to 5 real words. Chinese copy must contain 2 to 12 Han characters. Return only the JSON object.` }, { role: "user", content: [{ type: "text", text: "Analyze this evaluation image as a temporary visual recipe for retrieval and provide its temporary generation text suggestion. Do not assume either will be added to the library." }, { type: "image_url", image_url: { url: `data:${mime};base64,${image.toString("base64")}` } }] }] })
  });
  let response = await request();
  if (!response.ok) throw new Error(`视觉分析失败（HTTP ${response.status}）。`);
  let payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
  try { return parseValidRecipe(payload.choices?.[0]?.message?.content) as Record<string, unknown>; }
  catch {
    response = await request(true);
    if (!response.ok) throw new Error(`视觉分析重试失败（HTTP ${response.status}）。`);
    payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    return parseValidRecipe(payload.choices?.[0]?.message?.content) as Record<string, unknown>;
  }
}

const arrayText = (value: unknown): string => Array.isArray(value) ? value.map(arrayText).filter(Boolean).join("; ") : value && typeof value === "object" ? Object.values(value as Record<string, unknown>).map(arrayText).filter(Boolean).join("; ") : typeof value === "string" ? value : "";
const cleanEnglishCopy = (value: unknown) => {
  const copy = typeof value === "string" ? value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim() : "";
  return /^[A-Za-z]+(?:[ '-][A-Za-z]+){0,4}$/.test(copy) ? copy : undefined;
};
const cleanChineseCopy = (value: unknown) => {
  const copy = typeof value === "string" ? value.trim() : "";
  return /^[\p{Script=Han}]{2,12}$/u.test(copy) ? copy : undefined;
};

export function evalTextSuggestion(analysis: Record<string, unknown>): EvalTextSuggestion {
  const raw = analysis.evalTextSuggestion && typeof analysis.evalTextSuggestion === "object" ? analysis.evalTextSuggestion as Record<string, unknown> : {};
  const language: EvalCopyLanguage = raw.language === "zh" ? "zh" : "en";
  const suggested = language === "zh" ? cleanChineseCopy(raw.copy) : cleanEnglishCopy(raw.copy);
  if (suggested) return { language, copy: suggested };
  const metadata = analysis.metadata && typeof analysis.metadata === "object" ? analysis.metadata as Record<string, unknown> : {};
  return { language: "en", copy: cleanEnglishCopy(metadata.title) || "Visual Story" };
}

export function evalTextInstruction(analysis: Record<string, unknown>) {
  const suggestion = evalTextSuggestion(analysis);
  return [
    "Typography is optional. If the composition works without readable text, omit it.",
    `If readable text is included, use exactly this complete ${suggestion.language === "zh" ? "Chinese" : "English"} copy with identical characters and capitalization: ${JSON.stringify(suggestion.copy)}.`,
    "Do not add any other readable words, letters, numbers, pseudo-words, random glyphs, captions, labels, logos, signatures, or watermarks. Do not substitute or misspell the allowed copy."
  ].join(" ");
}

async function generationPrompt(analysis: Record<string, unknown>, matches: RankedSearchCard[]) {
  const skills = await Promise.all(matches.map(async (match) => {
    const located = await locateSkill(dataRoot(), match.id, match.libraryType);
    if (!located) return undefined;
    const stored = JSON.parse(await readFile(located.path, "utf8")) as { recipe?: Record<string, unknown> };
    const recipe = stored.recipe || {};
    return [
      `#${match.title}`,
      `Visual definition: ${arrayText(recipe.visualDefinition)}`,
      `Core relationships: ${arrayText(recipe.coreVisualRelationships)}`,
      `Color: ${arrayText(recipe.colorSystem)}`,
      `Reuse formula: ${arrayText(recipe.reuseFormula)}`,
      `Must redesign: ${arrayText(recipe.mustRedesign)}`
    ].join("\n");
  }));
  const metadata = analysis.metadata && typeof analysis.metadata === "object" ? analysis.metadata as Record<string, unknown> : {};
  return [
    "Edit the supplied evaluation image; it is the required reference image.",
    `Preserve its subject identity, depicted objects, event, and semantic meaning. Source reading: ${arrayText(analysis.visualDefinition) || arrayText(metadata.title)}.`,
    "Apply the transferable visual system from the ranked Skills below. Combine them coherently, giving earlier Skills higher priority:",
    ...skills.filter((item): item is string => Boolean(item)),
    "Do not copy source wording, logos, signatures, protected characters, watermarks, or the exact layout of any Skill. Create a materially new composition while preserving the evaluation image's subject and meaning.",
    evalTextInstruction(analysis),
    "Return one finished raster image."
  ].join("\n\n");
}

function settingsForRun(run: EvalRun) {
  const current = imageGenerationSettingsFromEnv();
  if (current.provider !== run.config.provider || current.model !== run.config.model) throw new Error(`当前生图配置已变更。请切回 ${run.config.provider} / ${run.config.model} 后恢复此运行。`);
  return { ...run.config, apiKey: current.apiKey } satisfies ImageGenerationSettings;
}

async function finishGeneration(run: EvalRun, item: EvalCaseRun, result: GenerationSubmission) {
  const started = Date.now();
  const resolved = await resolveGeneratedImage(result);
  const resultFile = `${item.caseId}.${resolved.extension}`;
  await writeFile(join(evalRunsDir(), run.id, resultFile), resolved.bytes);
  item.resultFile = resultFile;
  item.stage = "completed";
  item.remoteState = "completed";
  item.timings.download = Date.now() - started;
}

async function advanceEvalCase(run: EvalRun, item: EvalCaseRun, sourceCase: EvalCase, embedding?: EmbeddingConfig) {
  const sourcePath = join(evalImagesDir(), sourceCase.filename);
  try {
    if (item.stage === "pending_analysis") {
      const started = Date.now();
      item.analysis = await analyzeEvalImage(sourcePath, sourceCase.mime);
      item.timings.analysis = Date.now() - started;
      item.stage = "pending_retrieval";
      clearEvalRetrySchedule(item);
    } else if (item.stage === "pending_retrieval") {
      const started = Date.now();
      const texts = embeddingTexts(item.analysis || {});
      const retrieved = await retrieveSkills({ query: `${texts.intent}\n${texts.visual}`, embedding, library: run.config.library, topK: run.config.topK, excludeIds: [item.caseId] });
      item.matches = retrieved.results;
      item.retrievalMode = retrieved.retrievalMode;
      item.retrievalWarning = retrieved.warning;
      item.timings.retrieval = Date.now() - started;
      if (!item.matches.length) throw new Error("没有检索到可用于生成的已批准 Skill。");
      item.stage = "pending_generation";
      clearEvalRetrySchedule(item);
    } else if (item.stage === "pending_generation") {
      const started = Date.now();
      item.prompt = await generationPrompt(item.analysis || {}, item.matches || []);
      const result = await submitGeneration({ prompt: item.prompt, sourcePath, sourceMime: sourceCase.mime, settings: settingsForRun(run) });
      item.timings.generation = Date.now() - started;
      item.remoteId = result.remoteId;
      item.remoteState = result.state;
      if (result.state === "completed") await finishGeneration(run, item, result);
      else if (result.state === "failed") throw new Error(result.error || "生图任务提交失败。");
      else { item.stage = "waiting_generation"; clearEvalRetrySchedule(item); }
    } else if (item.stage === "waiting_generation") {
      if (!item.remoteId) throw new Error("fal.ai 任务缺少 request_id。");
      const started = Date.now();
      const result = await pollGeneration(item.remoteId, settingsForRun(run));
      item.timings.generation = (item.timings.generation || 0) + Date.now() - started;
      item.remoteState = result.state;
      if (result.state === "completed") await finishGeneration(run, item, result);
      else if (result.state === "failed") throw new Error(result.error || "fal.ai 生图任务失败。");
      else clearEvalRetrySchedule(item);
    }
  } catch (error) {
    if (isGenerationTransientError(error) && scheduleEvalRetry(item, error)) return;
    item.stage = "failed";
    item.error = error instanceof Error ? error.message.slice(0, 500) : "Eval 步骤失败。";
  }
}

export async function updateEvalRun(id: string, action: "advance" | "pause" | "resume", embedding?: EmbeddingConfig) {
  const run = await readEvalRun(id);
  if (action === "pause") { if (run.status !== "completed") run.status = "paused"; return saveEvalRun(run); }
  if (action === "resume") { if (run.status !== "completed") run.status = "running"; return saveEvalRun(run); }
  if (run.status !== "running") return run;
  const cases = new Map((await listEvalCases()).map((item) => [item.id, item]));
  const concurrency = evalConcurrency(run.config.concurrency);
  run.config.concurrency = concurrency;
  const runStage = async (items: EvalCaseRun[]) => Promise.all(items.map(async (item) => {
    const sourceCase = cases.get(item.caseId);
    if (!sourceCase) { item.stage = "failed"; item.error = "Eval 原图已不存在。"; return; }
    await advanceEvalCase(run, item, sourceCase, embedding);
  }));

  await runStage(run.cases.filter((item) => item.stage === "waiting_generation" && isEvalRetryDue(item)));
  await runStage(run.cases.filter((item) => (item.stage === "pending_analysis" || item.stage === "pending_retrieval") && isEvalRetryDue(item)).slice(0, concurrency));
  const openSlots = Math.max(0, concurrency - run.cases.filter((item) => item.stage === "waiting_generation").length);
  if (openSlots) await runStage(run.cases.filter((item) => item.stage === "pending_generation" && isEvalRetryDue(item)).slice(0, openSlots));
  if (run.cases.every((candidate) => ["completed", "failed"].includes(candidate.stage))) run.status = "completed";
  return saveEvalRun(run);
}

export function publicEvalRun(run: EvalRun) {
  const completed = run.cases.filter((item) => item.stage === "completed").length;
  const failed = run.cases.filter((item) => item.stage === "failed").length;
  return { ...run, progress: { completed, failed, total: run.cases.length, percent: run.cases.length ? Math.round(((completed + failed) / run.cases.length) * 100) : 0 } };
}
