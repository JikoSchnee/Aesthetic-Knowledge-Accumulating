import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { imageGenerationSettingsFromEnv, templateForFalModel, type ImageGenerationSettings } from "./image-generation-settings";

export type GenerationState = "queued" | "running" | "completed" | "failed";
export type GenerationSubmission = { state: GenerationState; remoteId?: string; imageUrl?: string; imageBase64?: string; contentType?: string; error?: string };

const MAX_RESULT_BYTES = 25 * 1024 * 1024;
const transientStatuses = new Set([408, 429, 500, 501, 502, 503, 504]);

export class GenerationTransientError extends Error {
  readonly retryable = true;
  constructor(message: string, readonly status?: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "GenerationTransientError";
  }
}

function errorStatus(error: unknown) {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { status?: unknown; response?: { status?: unknown } };
  const status = Number(candidate.status ?? candidate.response?.status);
  return Number.isFinite(status) ? status : undefined;
}

export function isGenerationTransientError(error: unknown): error is GenerationTransientError {
  if (error instanceof GenerationTransientError) return true;
  const status = errorStatus(error);
  if (status !== undefined && transientStatuses.has(status)) return true;
  const message = error instanceof Error ? error.message : String(error || "");
  return /fetch failed|network(?:\s+error)?|timed?\s*out|ECONN(?:RESET|REFUSED|ABORTED)|EAI_AGAIN|socket hang up/i.test(message);
}

function transientError(error: unknown, context: string) {
  if (error instanceof GenerationTransientError) return error;
  const status = errorStatus(error);
  if (isGenerationTransientError(error)) return new GenerationTransientError(`${context}：${error instanceof Error ? error.message : "临时网络错误。"}`, status, { cause: error });
  return error;
}

async function generationFetch(url: string, init: RequestInit, context: string) {
  try { return await fetch(url, init); }
  catch (error) { throw transientError(error, context); }
}

type FalClient = {
  storage: {
    upload: (file: Blob, options?: { lifecycle?: { expiresIn?: string } }) => Promise<string>;
  };
  queue: {
    submit: (model: never, options: { input: never }) => Promise<{ request_id: string }>;
    status: (model: string, options: { requestId: string; logs: boolean }) => Promise<{ status: string }>;
    result: (model: never, options: { requestId: string }) => Promise<{ data: unknown }>;
  };
};

const requireFromProject = createRequire(import.meta.url);

function createFalClient(credentials: string): FalClient {
  try {
    const falModule = requireFromProject("@fal-ai/client") as {
      createFalClient: (options: { credentials: string }) => FalClient;
    };
    return falModule.createFalClient({ credentials });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "MODULE_NOT_FOUND") {
      throw new Error("fal.ai SDK 尚未安装，请在项目目录执行 npm install 后重新启动服务。", { cause: error });
    }
    throw error;
  }
}

function mimeFromBytes(bytes: Buffer) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: "image/png", extension: "png" };
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mime: "image/jpeg", extension: "jpg" };
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return { mime: "image/webp", extension: "webp" };
  return undefined;
}

export function validateRaster(bytes: Buffer) {
  if (!bytes.length || bytes.length > MAX_RESULT_BYTES) throw new Error("生成结果为空或超过 25MB。 ");
  const format = mimeFromBytes(bytes);
  if (!format) throw new Error("生成服务返回的文件不是有效的 PNG、JPEG 或 WebP 图片。");
  return format;
}

function getPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (Array.isArray(current) && /^\d+$/.test(key)) return current[Number(key)];
    if (current && typeof current === "object") return (current as Record<string, unknown>)[key];
    return undefined;
  }, value);
}

function fillFalTemplate(value: unknown, prompt: string, imageUrl: string): unknown {
  if (Array.isArray(value)) return value.map((item) => fillFalTemplate(item, prompt, imageUrl));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, fillFalTemplate(item, prompt, imageUrl)]));
  if (value === "{{prompt}}") return prompt;
  if (value === "{{image_url}}") return imageUrl;
  if (value === "{{image_urls}}") return [imageUrl];
  if (typeof value === "string") return value.replaceAll("{{prompt}}", prompt).replaceAll("{{image_url}}", imageUrl);
  return value;
}

function falInput(settings: ImageGenerationSettings, prompt: string, imageUrl: string) {
  const template = templateForFalModel(settings.model, settings.outputFormat) || settings.falInputTemplate;
  return fillFalTemplate(JSON.parse(template), prompt, imageUrl) as Record<string, unknown>;
}

function openRouterResult(payload: Record<string, unknown>): GenerationSubmission {
  const data = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.images) ? payload.images : [];
  const first = data[0] as Record<string, unknown> | undefined;
  const imageBase64 = typeof first?.b64_json === "string" ? first.b64_json : typeof first?.base64 === "string" ? first.base64 : undefined;
  const imageUrl = typeof first?.url === "string" ? first.url : undefined;
  if (!imageBase64 && !imageUrl) return { state: "failed", error: "OpenRouter 没有返回可用图片。" };
  return { state: "completed", imageBase64, imageUrl, contentType: typeof first?.content_type === "string" ? first.content_type : undefined };
}

export async function submitGeneration(input: { prompt: string; sourcePath: string; sourceMime: string; settings?: ImageGenerationSettings }): Promise<GenerationSubmission> {
  const settings = input.settings || imageGenerationSettingsFromEnv();
  const source = await readFile(input.sourcePath);
  if (settings.provider === "fal") {
    try {
      const fal = createFalClient(settings.apiKey);
      const imageUrl = await fal.storage.upload(new Blob([source], { type: input.sourceMime }), { lifecycle: { expiresIn: "1d" } });
      const submitted = await fal.queue.submit(settings.model as never, { input: falInput(settings, input.prompt, imageUrl) as never });
      return { state: "queued", remoteId: submitted.request_id };
    } catch (error) { throw transientError(error, "fal.ai 生图提交暂时失败"); }
  }

  const response = await generationFetch(`${settings.endpoint.replace(/\/$/, "")}/images`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${settings.apiKey}` },
    body: JSON.stringify({
      model: settings.model,
      prompt: input.prompt,
      input_references: [{ image_url: `data:${input.sourceMime};base64,${source.toString("base64")}` }],
      output_format: settings.outputFormat
    })
  }, "OpenRouter 生图请求暂时失败");
  const text = await response.text();
  if (transientStatuses.has(response.status)) throw new GenerationTransientError(`OpenRouter 生图暂时失败（HTTP ${response.status}）：${text.slice(0, 260)}`, response.status);
  if (!response.ok) throw new Error(`OpenRouter 生图失败（HTTP ${response.status}）：${text.slice(0, 260)}`);
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(text) as Record<string, unknown>; } catch { throw new Error("OpenRouter 返回了无法解析的响应。"); }
  return openRouterResult(payload);
}

export async function pollGeneration(remoteId: string, settings = imageGenerationSettingsFromEnv()): Promise<GenerationSubmission> {
  if (settings.provider !== "fal") throw new Error("只有 fal.ai 任务需要轮询。");
  try {
    const fal = createFalClient(settings.apiKey);
    const status = await fal.queue.status(settings.model, { requestId: remoteId, logs: false });
    if (status.status === "IN_QUEUE") return { state: "queued", remoteId };
    if (status.status === "IN_PROGRESS") return { state: "running", remoteId };
    const result = await fal.queue.result(settings.model as never, { requestId: remoteId }) as unknown as { data: unknown };
    const imageUrl = getPath(result.data, settings.falResultPath);
    if (typeof imageUrl !== "string" || !/^https:\/\//i.test(imageUrl)) return { state: "failed", remoteId, error: `fal.ai 结果路径 ${settings.falResultPath} 没有返回 HTTPS 图片。` };
    return { state: "completed", remoteId, imageUrl };
  } catch (error) { throw transientError(error, "fal.ai 任务轮询暂时失败"); }
}

export async function resolveGeneratedImage(result: GenerationSubmission) {
  let bytes: Buffer;
  if (result.imageBase64) {
    const encoded = result.imageBase64.includes(",") ? result.imageBase64.slice(result.imageBase64.indexOf(",") + 1) : result.imageBase64;
    bytes = Buffer.from(encoded, "base64");
  } else if (result.imageUrl) {
    if (!/^https:\/\//i.test(result.imageUrl)) throw new Error("生成结果 URL 必须使用 HTTPS。");
    const response = await generationFetch(result.imageUrl, { redirect: "follow" }, "生成结果下载暂时失败");
    if (transientStatuses.has(response.status)) throw new GenerationTransientError(`生成结果下载暂时失败（HTTP ${response.status}）。`, response.status);
    if (!response.ok) throw new Error(`无法下载生成结果（HTTP ${response.status}）。`);
    const length = Number(response.headers.get("content-length") || 0);
    if (length > MAX_RESULT_BYTES) throw new Error("生成结果超过 25MB。");
    bytes = Buffer.from(await response.arrayBuffer());
  } else throw new Error("生成任务没有图片结果。");
  return { bytes, ...validateRaster(bytes) };
}
