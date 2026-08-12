import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { embeddingTexts, type EmbeddingConfig } from "./embeddings";
import { isGenerationTransientError, resolveGeneratedImage, pollGeneration, submitGeneration, type GenerationSubmission } from "./image-generation";
import { imageGenerationSettingsFromEnv, type ImageGenerationSettings } from "./image-generation-settings";
import { dataRoot, locateSkill, type LibraryType } from "./library";
import { imageRecipePrompt, parseJsonObject, parseValidRecipe } from "./recipe-schema";
import { buildEligibleSkillPool, noEligibleSkillMessage, rankSkillPool, retrieveSkills, type RankedSearchCard, type RetrievalDiagnostics, type RetrievalPool } from "./retrieval";

export const EVAL_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const EVAL_MAX_CONCURRENCY = 8;
export const EVAL_MAX_RETRIES = 3;
const evalRetryDelays = [1000, 3000, 9000];
export type EvalCase = { id: string; filename: string; extension: "jpg" | "png" | "webp"; mime: string; size: number; createdAt: string };
export type EvalStage = "pending_analysis" | "pending_retrieval" | "pending_generation" | "waiting_generation" | "completed" | "failed";
type EvalCopyLanguage = "en" | "zh";
type EvalTextSuggestion = { language: EvalCopyLanguage; copy: string };
export type SubjectLock = {
  subjectType: "person" | "group" | "animal" | "object" | "scene" | "other";
  subjectCount: number;
  identityAndFace: string;
  hairAndColor: string;
  bodyType: string;
  definingFeatures: string[];
};
export type EvalQualityCheck = { status: "pending" | "passed" | "failed"; reasons: string[] };
const EVAL_ANALYSIS_USER_PROMPT = "Analyze this evaluation image as a temporary visual recipe for retrieval and provide its temporary generation text suggestion. Do not assume either will be added to the library.";
const EVAL_ANALYSIS_SYSTEM_PROMPT = `${imageRecipePrompt} Also include an evalTextSuggestion object with language (en or zh) and copy. The copy must be a meaningful, original title grounded in the depicted subject, scene, or mood; never transcribe source text, brands, or logos. Use the source writing system when clear; otherwise use English. English copy must contain 1 to 5 real words. Chinese copy must contain 2 to 12 Han characters. Also include subjectLock using {"subjectType":"person|group|animal|object|scene|other","subjectCount":1,"identityAndFace":"stable identity and facial appearance, or not applicable","hairAndColor":"exact hairstyle, texture, length, and color, or not applicable","bodyType":"stable build and proportions, or not applicable","definingFeatures":["stable visual feature"]}. Describe only visible, identity-bearing appearance; do not include pose, clothing, or handheld props. Never leave a subjectLock string or array empty. Return only the JSON object.`;
export const EVAL_GENERATION_TEMPLATE = [
  "Use case: identity-preserve. Edit the supplied evaluation image; it is the sole and required subject reference image.",
  "SUBJECT LOCK — highest priority: {{SUBJECT_LOCK}}",
  "The output must contain the same primary subject count and preserve identity, face, hairstyle and hair color, body type, and all stable defining appearance from the source. Keep every primary subject clearly visible and recognizable; do not remove, replace, merge, hide, heavily crop, or overpower a subject with typography, background, texture, lighting, or effects.",
  "Pose, clothing, and handheld props may change to support a materially new composition. Source reading: {{SOURCE_READING}}.",
  "Apply the transferable visual system from this matched Skill:",
  "{{SKILL}}",
  "The Skill may control only visual style, palette, typography, and composition. If any Skill instruction conflicts with the SUBJECT LOCK, ignore that instruction and preserve the source subject. Do not copy source wording, logos, signatures, protected characters, watermarks, or the exact layout of any Skill.",
  "{{TEXT_INSTRUCTION}}",
  "Return one finished raster image."
].join("\n\n");
const EVAL_QUALITY_SYSTEM_PROMPT = [
  "You are a strict image-edit identity preservation inspector.",
  "Image 1 is the source and Image 2 is the generated result. Compare content, not rendering style.",
  "Return only JSON using this exact shape: {\"checks\":{\"subjectPresentAndCount\":true,\"identityAndFace\":true,\"hairAndColor\":true,\"bodyType\":true,\"definingFeatures\":true,\"subjectVisibility\":true},\"reasons\":[\"concise failure reason\"]}.",
  "A non-applicable person-specific check must be true. reasons must be empty only when every check is true."
].join(" ");
const EVAL_QUALITY_USER_PROMPT = "Verify the generated result against this source subject lock: {{SUBJECT_LOCK}}. Fail any changed identity-bearing trait, missing/extra primary subject, changed hairstyle or hair color, changed body type, lost defining feature, or subject that is obscured/cropped enough to stop being clearly recognizable.";

export type EvalSnapshot = {
  schemaVersion: "1.0";
  createdAt: string;
  pool: RetrievalPool;
  vision: { endpoint: string; model: string; temperature: number; retryTemperature: number; responseFormat: "json_object"; systemPrompt: string; userPrompt: string };
  embedding: { endpoint?: string; model?: string };
  generation: Omit<ImageGenerationSettings, "apiKey">;
  prompts: { generationTemplate: string; qualitySystemPrompt?: string; qualityUserPrompt?: string };
};
export type EvalCaseRun = {
  caseId: string;
  filename: string;
  stage: EvalStage;
  analysis?: Record<string, unknown>;
  retrievalMode?: string;
  retrievalWarning?: string;
  retrievalCode?: "NO_ELIGIBLE_SKILL";
  retrievalDiagnostics?: RetrievalDiagnostics;
  retrievalQuery?: string;
  queryVector?: number[];
  matches?: RankedSearchCard[];
  generations?: EvalGeneration[];
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
export type EvalGeneration = {
  matchId: string;
  rank: number;
  stage: "pending_generation" | "waiting_generation" | "completed" | "failed";
  prompt?: string;
  remoteId?: string;
  remoteState?: string;
  resultFile?: string;
  error?: string;
  retryCount?: number;
  nextRetryAt?: string;
  lastTransientError?: string;
  fidelityAttempt?: 1 | 2;
  qualityCheck?: EvalQualityCheck;
  qualityTimings?: number;
  timings: Partial<Record<"generation" | "download", number>>;
};
export type EvalRun = {
  schemaVersion: "1.0" | "2.0";
  id: string;
  createdAt: string;
  updatedAt: string;
  groupName?: string;
  name?: string;
  status: "running" | "paused" | "completed";
  pauseReason?: string;
  config: Omit<ImageGenerationSettings, "apiKey"> & { topK: number; library: LibraryType | "all"; concurrency?: number };
  snapshot?: { file: "snapshot.json"; sha256: string; candidateCount: number; visionModel: string; embeddingModel?: string; promptHash: string };
  cases: EvalCaseRun[];
};

export function evalGroupName(value: unknown) {
  const name = typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 80) : "";
  return name || "未命名组";
}

export function evalRunName(value: unknown, fallback = "未命名任务") {
  const name = typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 80) : "";
  return name || fallback;
}

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

async function readEvalSnapshot(run: EvalRun): Promise<EvalSnapshot | undefined> {
  if (run.schemaVersion !== "2.0" || !run.snapshot) return undefined;
  const path = join(evalRunsDir(), run.id, run.snapshot.file);
  const bytes = await readFile(path);
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== run.snapshot.sha256) throw new Error("Eval 快照校验失败，运行已暂停以避免使用被修改的候选数据。");
  return JSON.parse(bytes.toString("utf8")) as EvalSnapshot;
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

type RetryableEvalItem = Pick<EvalCaseRun, "retryCount" | "nextRetryAt" | "lastTransientError">;
export function scheduleEvalRetry(item: RetryableEvalItem, error: Error, now = Date.now()) {
  const retryCount = (item.retryCount || 0) + 1;
  item.retryCount = retryCount;
  if (retryCount > EVAL_MAX_RETRIES) return false;
  item.lastTransientError = error.message.slice(0, 500);
  item.nextRetryAt = new Date(now + evalRetryDelays[retryCount - 1]).toISOString();
  return true;
}

export function isEvalRetryDue(item: Pick<EvalCaseRun, "nextRetryAt">, now = Date.now()) {
  return !item.nextRetryAt || Date.parse(item.nextRetryAt) <= now;
}

function clearEvalRetrySchedule(item: RetryableEvalItem) {
  delete item.nextRetryAt;
  delete item.lastTransientError;
}

export async function createEvalRun(input: { caseIds?: string[]; topK?: number; library?: LibraryType | "all"; concurrency?: number; groupName?: string; name?: string; embedding?: EmbeddingConfig }) {
  const cases = await listEvalCases();
  const selected = input.caseIds?.length ? cases.filter((item) => input.caseIds?.includes(item.id)) : cases;
  if (!selected.length) throw new Error("请先添加至少一张 Eval 图片。");
  const settings = imageGenerationSettingsFromEnv();
  if (!settings.apiKey) throw new Error("请先在 API 配置中保存生图 API Key。");
  if (!process.env.VISION_API_KEY || !process.env.VISION_ENDPOINT || !process.env.VISION_MODEL) throw new Error("请先保存视觉分析 API 配置。");
  const now = new Date().toISOString();
  const id = `${Date.now().toString(16)}-${randomUUID()}`;
  const directory = join(evalRunsDir(), id);
  const { apiKey: _secret, ...generationSnapshot } = settings;
  const library = input.library === "photo" || input.library === "imported_skill" ? input.library : "all";
  const pool = await buildEligibleSkillPool({ root: dataRoot(), library, excludeIds: selected.map((item) => item.id) });
  if (!pool.candidates.length) throw new Error(noEligibleSkillMessage(pool.diagnostics));
  const evalSnapshot: EvalSnapshot = {
    schemaVersion: "1.0",
    createdAt: now,
    pool,
    vision: { endpoint: process.env.VISION_ENDPOINT, model: process.env.VISION_MODEL, temperature: 0.2, retryTemperature: 0, responseFormat: "json_object", systemPrompt: EVAL_ANALYSIS_SYSTEM_PROMPT, userPrompt: EVAL_ANALYSIS_USER_PROMPT },
    embedding: { endpoint: input.embedding?.endpoint?.trim(), model: input.embedding?.model?.trim() },
    generation: generationSnapshot,
    prompts: { generationTemplate: EVAL_GENERATION_TEMPLATE, qualitySystemPrompt: EVAL_QUALITY_SYSTEM_PROMPT, qualityUserPrompt: EVAL_QUALITY_USER_PROMPT }
  };
  const snapshotBytes = Buffer.from(JSON.stringify(evalSnapshot, null, 2));
  const snapshotHash = createHash("sha256").update(snapshotBytes).digest("hex");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "snapshot.json"), snapshotBytes, { flag: "wx" });
  const run: EvalRun = {
    schemaVersion: "2.0", id, createdAt: now, updatedAt: now, groupName: evalGroupName(input.groupName), name: evalRunName(input.name, `Eval ${new Date().toLocaleString("zh-CN")}`), status: "running",
    config: { ...generationSnapshot, topK: Math.max(1, Math.min(10, Math.round(input.topK || 3))), library, concurrency: evalConcurrency(input.concurrency) },
    snapshot: { file: "snapshot.json", sha256: snapshotHash, candidateCount: pool.candidates.length, visionModel: evalSnapshot.vision.model, embeddingModel: evalSnapshot.embedding.model, promptHash: createHash("sha256").update(`${evalSnapshot.vision.systemPrompt}\0${evalSnapshot.vision.userPrompt}\0${evalSnapshot.prompts.generationTemplate}\0${evalSnapshot.prompts.qualitySystemPrompt}\0${evalSnapshot.prompts.qualityUserPrompt}`).digest("hex") },
    cases: selected.map((item) => ({ caseId: item.id, filename: item.filename, stage: "pending_analysis", timings: {} }))
  };
  await saveEvalRun(run);
  return run;
}

export async function renameEvalRun(id: string, name: unknown) {
  const run = await readEvalRun(id);
  run.name = evalRunName(name, run.name || `Eval ${new Date(run.createdAt).toLocaleString("zh-CN")}`);
  return saveEvalRun(run);
}

export async function renameEvalGroup(from: unknown, to: unknown) {
  const source = evalGroupName(from);
  const target = evalGroupName(to);
  if (source === target) return listEvalRuns();
  const runs = await listEvalRuns();
  await Promise.all(runs.filter((run) => evalGroupName(run.groupName) === source).map(async (run) => { run.groupName = target; await saveEvalRun(run); }));
  return listEvalRuns();
}

export async function deleteEvalRun(id: string) {
  if (!safeId(id)) throw new Error("无效的 Eval Run ID。");
  // Resolve the run first so the only recursive deletion target is a validated run directory.
  await readEvalRun(id);
  await rm(join(evalRunsDir(), id), { recursive: true, force: true });
}

async function analyzeEvalImage(path: string, mime: string, snapshot?: EvalSnapshot) {
  const image = await readFile(path);
  const endpoint = snapshot?.vision.endpoint || process.env.VISION_ENDPOINT || "";
  const model = snapshot?.vision.model || process.env.VISION_MODEL || "";
  const apiKey = process.env.VISION_API_KEY || "";
  if (snapshot && (process.env.VISION_ENDPOINT !== endpoint || process.env.VISION_MODEL !== model)) throw new Error(`当前视觉分析配置已变更。请切回 ${endpoint} / ${model} 后恢复此运行。`);
  if (!apiKey) throw new Error("视觉分析 API Key 不可用。");
  const vision = snapshot?.vision || { endpoint, model, temperature: 0.2, retryTemperature: 0, responseFormat: "json_object" as const, systemPrompt: EVAL_ANALYSIS_SYSTEM_PROMPT, userPrompt: EVAL_ANALYSIS_USER_PROMPT };
  const request = async (strict = false, validationError = "") => fetch(`${endpoint.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, temperature: strict ? vision.retryTemperature : vision.temperature, response_format: { type: vision.responseFormat }, messages: [{ role: "system", content: vision.systemPrompt }, { role: "user", content: [{ type: "text", text: strict ? `${vision.userPrompt}\nRegenerate the complete object and correct these validation errors: ${validationError}` : vision.userPrompt }, { type: "image_url", image_url: { url: `data:${mime};base64,${image.toString("base64")}` } }] }] })
  });
  let response = await request();
  if (!response.ok) throw new Error(`视觉分析失败（HTTP ${response.status}）。`);
  let payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
  try { return parseValidRecipe(payload.choices?.[0]?.message?.content) as Record<string, unknown>; }
  catch (firstError) {
    response = await request(true, firstError instanceof Error ? firstError.message.slice(0, 1200) : "invalid recipe structure");
    if (!response.ok) throw new Error(`视觉分析重试失败（HTTP ${response.status}）。`);
    payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    return parseValidRecipe(payload.choices?.[0]?.message?.content) as Record<string, unknown>;
  }
}

const arrayText = (value: unknown): string => Array.isArray(value) ? value.map(arrayText).filter(Boolean).join("; ") : value && typeof value === "object" ? Object.values(value as Record<string, unknown>).map(arrayText).filter(Boolean).join("; ") : typeof value === "string" ? value : "";
const compactText = (value: unknown, fallback: string) => typeof value === "string" && value.trim() ? value.replace(/\s+/g, " ").trim() : fallback;
const subjectTypes = new Set<SubjectLock["subjectType"]>(["person", "group", "animal", "object", "scene", "other"]);

export function subjectLockFromAnalysis(analysis: Record<string, unknown>): SubjectLock {
  const raw = analysis.subjectLock && typeof analysis.subjectLock === "object" && !Array.isArray(analysis.subjectLock) ? analysis.subjectLock as Record<string, unknown> : {};
  const metadata = analysis.metadata && typeof analysis.metadata === "object" ? analysis.metadata as Record<string, unknown> : {};
  const subjectType = subjectTypes.has(raw.subjectType as SubjectLock["subjectType"]) ? raw.subjectType as SubjectLock["subjectType"] : "other";
  const parsedCount = Math.round(Number(raw.subjectCount));
  const definingFeatures = Array.isArray(raw.definingFeatures) ? raw.definingFeatures.map((value) => compactText(value, "")).filter(Boolean).slice(0, 8) : [];
  if (!definingFeatures.length) definingFeatures.push(compactText(analysis.visualDefinition, compactText(metadata.title, "the source image's primary subject appearance")));
  return {
    subjectType,
    subjectCount: Number.isFinite(parsedCount) && parsedCount > 0 ? Math.min(parsedCount, 20) : 1,
    identityAndFace: compactText(raw.identityAndFace, subjectType === "person" || subjectType === "group" ? "preserve the exact visible identity and facial appearance from the source" : "not applicable"),
    hairAndColor: compactText(raw.hairAndColor, subjectType === "person" || subjectType === "group" || subjectType === "animal" ? "preserve the exact visible hair or fur shape, texture, length, and color from the source" : "not applicable"),
    bodyType: compactText(raw.bodyType, subjectType === "person" || subjectType === "group" || subjectType === "animal" ? "preserve the visible build, proportions, and silhouette from the source" : "not applicable"),
    definingFeatures
  };
}

export function subjectLockInstruction(analysis: Record<string, unknown>) {
  const lock = subjectLockFromAnalysis(analysis);
  return [
    `type=${lock.subjectType}`,
    `count=${lock.subjectCount}`,
    `identity/face=${lock.identityAndFace}`,
    `hair/color=${lock.hairAndColor}`,
    `body type=${lock.bodyType}`,
    `defining features=${lock.definingFeatures.join("; ")}`
  ].join(" | ");
}

export function fidelityRepairPrompt(prompt: string, reasons: string[]) {
  const failures = reasons.map((reason) => compactText(reason, "")).filter(Boolean).slice(0, 8);
  return `${prompt}\n\nFIDELITY CORRECTION — the previous result failed subject preservation for: ${failures.join("; ") || "subject identity drift"}. Correct only these failures. Re-read the supplied source image as the sole subject reference and obey the SUBJECT LOCK above. Do not repeat the failed change.`;
}

const qualityLabels: Record<string, string> = {
  subjectPresentAndCount: "主体缺失或数量不一致",
  identityAndFace: "人物身份或面部不一致",
  hairAndColor: "发型、发质、长度或发色不一致",
  bodyType: "体型或身体比例不一致",
  definingFeatures: "主体关键外观特征丢失或改变",
  subjectVisibility: "主体被严重遮挡、裁切或弱化"
};

export function parseQualityCheck(content: unknown): EvalQualityCheck {
  const parsed = typeof content === "string" || Array.isArray(content) ? parseJsonObject(content) : content as Record<string, unknown>;
  const checks = parsed?.checks && typeof parsed.checks === "object" && !Array.isArray(parsed.checks) ? parsed.checks as Record<string, unknown> : {};
  const failed = Object.keys(qualityLabels).filter((key) => checks[key] !== true);
  const supplied = Array.isArray(parsed?.reasons) ? parsed.reasons.map((value) => compactText(value, "")).filter(Boolean) : [];
  const reasons = [...new Set([...supplied, ...failed.map((key) => qualityLabels[key])])];
  return { status: failed.length ? "failed" : "passed", reasons: failed.length ? reasons : [] };
}

export function qualityOutcome(check: EvalQualityCheck, attempt: 1 | 2) {
  if (check.status === "passed") return "accept" as const;
  if (attempt === 1 && !check.reasons.some((reason) => reason.startsWith("主体保真质检不可用"))) return "retry" as const;
  return "accept_with_warning" as const;
}
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

export async function generationPrompt(analysis: Record<string, unknown>, match: RankedSearchCard, snapshot?: EvalSnapshot) {
  let recipe = snapshot?.pool.candidates.find((candidate) => candidate.card.versionId === match.versionId)?.recipe;
  if (!recipe) {
    const located = await locateSkill(dataRoot(), match.versionId || match.id, match.libraryType);
    if (!located) throw new Error(`找不到已匹配的 Skill：${match.title}`);
    const stored = JSON.parse(await readFile(located.path, "utf8")) as { recipe?: Record<string, unknown> };
    recipe = stored.recipe || {};
  }
  const skill = [
    `#${match.title}`,
    `Visual definition: ${arrayText(recipe.visualDefinition)}`,
    `Core relationships: ${arrayText(recipe.coreVisualRelationships)}`,
    `Color: ${arrayText(recipe.colorSystem)}`,
    `Reuse formula: ${arrayText(recipe.reuseFormula)}`,
    `Must redesign: ${arrayText(recipe.mustRedesign)}`
  ].join("\n");
  const metadata = analysis.metadata && typeof analysis.metadata === "object" ? analysis.metadata as Record<string, unknown> : {};
  return (snapshot?.prompts.generationTemplate || EVAL_GENERATION_TEMPLATE)
    .replaceAll("{{SOURCE_READING}}", arrayText(analysis.visualDefinition) || arrayText(metadata.title))
    .replaceAll("{{SUBJECT_LOCK}}", subjectLockInstruction(analysis))
    .replaceAll("{{SKILL}}", skill)
    .replaceAll("{{TEXT_INSTRUCTION}}", evalTextInstruction(analysis));
}

function settingsForRun(run: EvalRun) {
  const current = imageGenerationSettingsFromEnv();
  const keys: Array<keyof Omit<ImageGenerationSettings, "apiKey">> = ["provider", "model", "endpoint", "outputFormat", "falInputTemplate", "falResultPath"];
  const changed = keys.filter((key) => current[key] !== run.config[key]);
  if (changed.length) throw new Error(`当前生图配置已变更（${changed.join(", ")}）。请切回 ${run.config.provider} / ${run.config.model} 后恢复此运行。`);
  if (!current.apiKey) throw new Error("生图 API Key 不可用。");
  return { ...run.config, apiKey: current.apiKey } satisfies ImageGenerationSettings;
}

async function inspectGeneratedQuality(sourceCase: EvalCase, generated: Buffer, generatedMime: string, analysis: Record<string, unknown>, snapshot: EvalSnapshot): Promise<EvalQualityCheck> {
  try {
    const source = await readFile(join(evalImagesDir(), sourceCase.filename));
    const apiKey = process.env.VISION_API_KEY || "";
    if (!apiKey) throw new Error("视觉分析 API Key 不可用");
    const userPrompt = (snapshot.prompts.qualityUserPrompt || EVAL_QUALITY_USER_PROMPT).replaceAll("{{SUBJECT_LOCK}}", subjectLockInstruction(analysis));
    const response = await fetch(`${snapshot.vision.endpoint.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: snapshot.vision.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: snapshot.prompts.qualitySystemPrompt || EVAL_QUALITY_SYSTEM_PROMPT },
          { role: "user", content: [
            { type: "text", text: userPrompt },
            { type: "image_url", image_url: { url: `data:${sourceCase.mime};base64,${source.toString("base64")}` } },
            { type: "image_url", image_url: { url: `data:${generatedMime};base64,${generated.toString("base64")}` } }
          ] }
        ]
      })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    return parseQualityCheck(payload.choices?.[0]?.message?.content);
  } catch (error) {
    return { status: "failed", reasons: [`主体保真质检不可用：${error instanceof Error ? error.message : "未知错误"}`] };
  }
}

async function finishGeneration(run: EvalRun, item: EvalCaseRun, generation: EvalGeneration, result: GenerationSubmission, sourceCase: EvalCase, snapshot?: EvalSnapshot) {
  const started = Date.now();
  const resolved = await resolveGeneratedImage(result);
  generation.timings.download = (generation.timings.download || 0) + Date.now() - started;
  if (snapshot?.prompts.qualitySystemPrompt) {
    const qualityStarted = Date.now();
    const qualityCheck = await inspectGeneratedQuality(sourceCase, resolved.bytes, resolved.mime, item.analysis || {}, snapshot);
    generation.qualityTimings = (generation.qualityTimings || 0) + Date.now() - qualityStarted;
    generation.qualityCheck = qualityCheck;
    const attempt = generation.fidelityAttempt || 1;
    if (qualityOutcome(qualityCheck, attempt as 1 | 2) === "retry") {
      generation.fidelityAttempt = 2;
      generation.qualityCheck = { status: "pending", reasons: qualityCheck.reasons };
      generation.stage = "pending_generation";
      generation.remoteState = "quality_retry";
      delete generation.remoteId;
      return;
    }
  }
  const resultFile = `${item.caseId}-${generation.rank}.${resolved.extension}`;
  await writeFile(join(evalRunsDir(), run.id, resultFile), resolved.bytes);
  generation.resultFile = resultFile;
  generation.stage = "completed";
  generation.remoteState = "completed";
}

function refreshCaseStage(item: EvalCaseRun) {
  const generations = item.generations || [];
  if (!generations.length) return;
  if (generations.every((generation) => ["completed", "failed"].includes(generation.stage))) {
    item.stage = generations.every((generation) => generation.stage === "failed") ? "failed" : "completed";
    item.error = generations.filter((generation) => generation.error).map((generation) => generation.error).join("；") || undefined;
  } else if (generations.some((generation) => generation.stage === "waiting_generation")) item.stage = "waiting_generation";
  else item.stage = "pending_generation";
}

async function advanceGeneration(run: EvalRun, item: EvalCaseRun, generation: EvalGeneration, sourceCase: EvalCase, snapshot?: EvalSnapshot) {
  const sourcePath = join(evalImagesDir(), sourceCase.filename);
  try {
    if (generation.stage === "pending_generation") {
      const match = item.matches?.find((candidate) => candidate.id === generation.matchId);
      if (!match) throw new Error("生成任务缺少对应的匹配 Skill。");
      const started = Date.now();
      generation.prompt ||= await generationPrompt(item.analysis || {}, match, snapshot);
      generation.fidelityAttempt ||= 1;
      const requestPrompt = generation.fidelityAttempt === 2 ? fidelityRepairPrompt(generation.prompt, generation.qualityCheck?.reasons || []) : generation.prompt;
      const result = await submitGeneration({ prompt: requestPrompt, sourcePath, sourceMime: sourceCase.mime, settings: settingsForRun(run) });
      generation.timings.generation = Date.now() - started;
      generation.remoteId = result.remoteId;
      generation.remoteState = result.state;
      if (result.state === "completed") await finishGeneration(run, item, generation, result, sourceCase, snapshot);
      else if (result.state === "failed") throw new Error(result.error || "生图任务提交失败。");
      else { generation.stage = "waiting_generation"; clearEvalRetrySchedule(generation); }
    } else if (generation.stage === "waiting_generation") {
      if (!generation.remoteId) throw new Error("fal.ai 任务缺少 request_id。");
      const started = Date.now();
      const result = await pollGeneration(generation.remoteId, settingsForRun(run));
      generation.timings.generation = (generation.timings.generation || 0) + Date.now() - started;
      generation.remoteState = result.state;
      if (result.state === "completed") await finishGeneration(run, item, generation, result, sourceCase, snapshot);
      else if (result.state === "failed") throw new Error(result.error || "fal.ai 生图任务失败。");
      else clearEvalRetrySchedule(generation);
    }
  } catch (error) {
    if (isGenerationTransientError(error) && scheduleEvalRetry(generation, error)) { refreshCaseStage(item); return; }
    generation.stage = "failed";
    generation.error = error instanceof Error ? error.message.slice(0, 500) : "生图步骤失败。";
  }
  refreshCaseStage(item);
}

async function advanceEvalCase(run: EvalRun, item: EvalCaseRun, sourceCase: EvalCase, embedding?: EmbeddingConfig, snapshot?: EvalSnapshot) {
  const sourcePath = join(evalImagesDir(), sourceCase.filename);
  try {
    if (item.stage === "pending_analysis") {
      const started = Date.now();
      item.analysis = await analyzeEvalImage(sourcePath, sourceCase.mime, snapshot);
      item.timings.analysis = Date.now() - started;
      item.stage = "pending_retrieval";
      clearEvalRetrySchedule(item);
    } else if (item.stage === "pending_retrieval") {
      const started = Date.now();
      const texts = embeddingTexts(item.analysis || {});
      item.retrievalQuery = `${texts.intent}\n${texts.visual}`;
      const retrieved = snapshot
        ? await rankSkillPool({ query: item.retrievalQuery, embedding, topK: run.config.topK, pool: snapshot.pool })
        : await retrieveSkills({ query: item.retrievalQuery, embedding, library: run.config.library, topK: run.config.topK, excludeIds: [item.caseId] });
      item.matches = retrieved.results;
      item.retrievalMode = retrieved.retrievalMode;
      item.retrievalWarning = retrieved.warning;
      item.retrievalDiagnostics = retrieved.diagnostics;
      item.queryVector = retrieved.queryVector;
      item.timings.retrieval = Date.now() - started;
      if (!item.matches.length) { item.retrievalCode = "NO_ELIGIBLE_SKILL"; throw new Error(noEligibleSkillMessage(retrieved.diagnostics)); }
      item.stage = "pending_generation";
      clearEvalRetrySchedule(item);
    } else if (item.stage === "pending_generation" && !item.generations) {
      item.generations = (item.matches || []).map((match, index) => ({ matchId: match.id, rank: index + 1, stage: "pending_generation", fidelityAttempt: 1, timings: {} }));
      if (!item.generations.length) { item.retrievalCode = "NO_ELIGIBLE_SKILL"; throw new Error(noEligibleSkillMessage(item.retrievalDiagnostics || { indexed: 0, approved: 0, eligible: 0, returned: 0, rejected: [] })); }
    }
  } catch (error) {
    if (isGenerationTransientError(error) && scheduleEvalRetry(item, error)) return;
    item.stage = "failed";
    item.error = error instanceof Error ? error.message.slice(0, 500) : "Eval 步骤失败。";
  }
}

function validateSnapshotRuntime(run: EvalRun, snapshot: EvalSnapshot, embedding?: EmbeddingConfig) {
  if (process.env.VISION_ENDPOINT !== snapshot.vision.endpoint || process.env.VISION_MODEL !== snapshot.vision.model || !process.env.VISION_API_KEY) {
    throw new Error(`视觉分析配置与快照不一致。需要 ${snapshot.vision.endpoint} / ${snapshot.vision.model} 和可用 API Key。`);
  }
  settingsForRun(run);
  if (!snapshot.embedding.endpoint || !snapshot.embedding.model) return undefined;
  if (embedding?.endpoint?.trim() !== snapshot.embedding.endpoint || embedding.model?.trim() !== snapshot.embedding.model || !embedding.apiKey?.trim()) {
    throw new Error(`Embedding 配置与快照不一致。需要 ${snapshot.embedding.endpoint} / ${snapshot.embedding.model} 和可用 API Key。`);
  }
  return embedding;
}

export async function updateEvalRun(id: string, action: "advance" | "pause" | "resume", embedding?: EmbeddingConfig) {
  const run = await readEvalRun(id);
  if (action === "pause") { if (run.status !== "completed") { run.status = "paused"; run.pauseReason = "用户暂停"; } return saveEvalRun(run); }
  let snapshot: EvalSnapshot | undefined;
  try { snapshot = await readEvalSnapshot(run); }
  catch (error) {
    run.status = "paused";
    run.pauseReason = error instanceof Error ? error.message : "Eval 快照无法读取。";
    return saveEvalRun(run);
  }
  if (action === "resume") {
    if (run.status !== "completed") {
      try { if (snapshot) embedding = validateSnapshotRuntime(run, snapshot, embedding); run.status = "running"; delete run.pauseReason; }
      catch (error) { run.status = "paused"; run.pauseReason = error instanceof Error ? error.message : "运行配置与快照不一致。"; }
    }
    return saveEvalRun(run);
  }
  if (run.status !== "running") return run;
  try { if (snapshot) embedding = validateSnapshotRuntime(run, snapshot, embedding); }
  catch (error) { run.status = "paused"; run.pauseReason = error instanceof Error ? error.message : "运行配置与快照不一致。"; return saveEvalRun(run); }
  const cases = new Map((await listEvalCases()).map((item) => [item.id, item]));
  const concurrency = evalConcurrency(run.config.concurrency);
  run.config.concurrency = concurrency;
  // Runs created before per-Skill outputs existed retain their one existing task/result.
  for (const item of run.cases) {
    if (item.generations || !item.matches?.length || !["pending_generation", "waiting_generation", "completed", "failed"].includes(item.stage)) continue;
    item.generations = [{ matchId: item.matches[0].id, rank: 1, stage: item.stage === "completed" ? "completed" : item.stage === "failed" ? "failed" : item.stage === "waiting_generation" ? "waiting_generation" : "pending_generation", prompt: item.prompt, remoteId: item.remoteId, remoteState: item.remoteState, resultFile: item.resultFile, error: item.error, retryCount: item.retryCount, nextRetryAt: item.nextRetryAt, lastTransientError: item.lastTransientError, timings: { generation: item.timings.generation, download: item.timings.download } }];
  }
  const runStage = async (items: EvalCaseRun[]) => Promise.all(items.map(async (item) => {
    const sourceCase = cases.get(item.caseId);
    if (!sourceCase) { item.stage = "failed"; item.error = "Eval 原图已不存在。"; return; }
    await advanceEvalCase(run, item, sourceCase, embedding, snapshot);
  }));

  // First create durable per-Skill generation records after retrieval. Each record is
  // advanced independently below, so Top K produces Top K images rather than one blend.
  await runStage(run.cases.filter((item) => (item.stage === "pending_analysis" || item.stage === "pending_retrieval") && isEvalRetryDue(item)).slice(0, concurrency));
  await runStage(run.cases.filter((item) => item.stage === "pending_generation" && !item.generations && isEvalRetryDue(item)).slice(0, concurrency));
  const generationJobs = run.cases.flatMap((item) => (item.generations || []).map((generation) => ({ item, generation })))
    .filter(({ generation }) => ["pending_generation", "waiting_generation"].includes(generation.stage) && isEvalRetryDue(generation));
  const waiting = generationJobs.filter(({ generation }) => generation.stage === "waiting_generation");
  await Promise.all(waiting.map(({ item, generation }) => {
    const sourceCase = cases.get(item.caseId);
    return sourceCase ? advanceGeneration(run, item, generation, sourceCase, snapshot) : Promise.resolve();
  }));
  const activeRemote = run.cases.flatMap((item) => item.generations || []).filter((generation) => generation.stage === "waiting_generation").length;
  const openSlots = Math.max(0, concurrency - activeRemote);
  await Promise.all(generationJobs.filter(({ generation }) => generation.stage === "pending_generation").slice(0, openSlots).map(({ item, generation }) => {
    const sourceCase = cases.get(item.caseId);
    return sourceCase ? advanceGeneration(run, item, generation, sourceCase, snapshot) : Promise.resolve();
  }));
  if (run.cases.every((candidate) => ["completed", "failed"].includes(candidate.stage))) run.status = "completed";
  return saveEvalRun(run);
}

export function publicEvalRun(run: EvalRun) {
  const completed = run.cases.filter((item) => item.stage === "completed").length;
  const failed = run.cases.filter((item) => item.stage === "failed").length;
  return { ...run, progress: { completed, failed, total: run.cases.length, percent: run.cases.length ? Math.round(((completed + failed) / run.cases.length) * 100) : 0 } };
}
