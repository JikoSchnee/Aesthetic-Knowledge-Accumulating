import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type ImageGenerationProviderName = "openrouter" | "fal";
export type OutputFormat = "png" | "jpeg" | "webp";

export type ImageGenerationSettings = {
  provider: ImageGenerationProviderName;
  model: string;
  endpoint: string;
  apiKey: string;
  outputFormat: OutputFormat;
  falInputTemplate: string;
  falResultPath: string;
};

export const FAL_PRESETS = [
  { id: "fal-ai/flux-pro/kontext", label: "FLUX.1 Kontext Pro", imageField: "image_url" as const, supportsOutputFormat: true, defaults: {} },
  { id: "fal-ai/flux-2/edit", label: "FLUX.2 Edit", imageField: "image_urls" as const, supportsOutputFormat: true, defaults: {} },
  { id: "fal-ai/flux/dev/image-to-image", label: "FLUX.1 Dev Image-to-Image", imageField: "image_url" as const, supportsOutputFormat: true, defaults: {} },
  { id: "fal-ai/bytedance/seedream/v4.5/edit", label: "Seedream 4.5 Edit", imageField: "image_urls" as const, supportsOutputFormat: false, defaults: { image_size: "auto_2K", max_images: 1, enable_safety_checker: true } },
  { id: "fal-ai/nano-banana/edit", label: "Nano Banana Edit", imageField: "image_urls" as const, supportsOutputFormat: true, defaults: { aspect_ratio: "auto", limit_generations: true } },
  { id: "openai/gpt-image-2/edit", label: "GPT Image 2 Edit", imageField: "image_urls" as const, supportsOutputFormat: true, defaults: { image_size: "auto", quality: "high" } }
];

export const IMAGE_GENERATION_DEFAULTS: ImageGenerationSettings = {
  provider: "openrouter",
  model: "google/gemini-2.5-flash-image",
  endpoint: "https://openrouter.ai/api/v1",
  apiKey: "",
  outputFormat: "png",
  falInputTemplate: JSON.stringify({ prompt: "{{prompt}}", image_url: "{{image_url}}", num_images: 1 }),
  falResultPath: "images.0.url"
};

const clean = (value: string) => value.replace(/[\r\n]/g, "").trim();

export function imageGenerationSettingsFromEnv(): ImageGenerationSettings {
  const provider = process.env.IMAGE_GENERATION_PROVIDER === "fal" ? "fal" : "openrouter";
  return {
    provider,
    model: process.env.IMAGE_GENERATION_MODEL || (provider === "fal" ? "fal-ai/flux-pro/kontext" : IMAGE_GENERATION_DEFAULTS.model),
    endpoint: process.env.IMAGE_GENERATION_ENDPOINT || (provider === "fal" ? "https://queue.fal.run" : IMAGE_GENERATION_DEFAULTS.endpoint),
    apiKey: provider === "fal" ? process.env.FAL_KEY || "" : process.env.IMAGE_GENERATION_API_KEY || "",
    outputFormat: ["png", "jpeg", "webp"].includes(process.env.IMAGE_GENERATION_OUTPUT_FORMAT || "") ? process.env.IMAGE_GENERATION_OUTPUT_FORMAT as OutputFormat : "png",
    falInputTemplate: process.env.IMAGE_GENERATION_FAL_INPUT_TEMPLATE || IMAGE_GENERATION_DEFAULTS.falInputTemplate,
    falResultPath: process.env.IMAGE_GENERATION_FAL_RESULT_PATH || IMAGE_GENERATION_DEFAULTS.falResultPath
  };
}

export function visibleImageGenerationSettings() {
  const settings = imageGenerationSettingsFromEnv();
  return { ...settings, apiKey: settings.apiKey ? "env-configured" : "", presets: FAL_PRESETS };
}

function validateFalTemplate(template: string) {
  let parsed: unknown;
  try { parsed = JSON.parse(template); } catch { throw new Error("fal.ai 输入模板必须是合法 JSON。"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("fal.ai 输入模板必须是 JSON 对象。");
  const tokens: string[] = template.match(/{{[^}]+}}/g) || [];
  const allowed = new Set(["{{prompt}}", "{{image_url}}", "{{image_urls}}"]);
  if (tokens.some((token) => !allowed.has(token))) throw new Error("fal.ai 模板只允许 prompt、image_url、image_urls 三种占位符。");
  if (!tokens.includes("{{prompt}}") || (!tokens.includes("{{image_url}}") && !tokens.includes("{{image_urls}}"))) throw new Error("fal.ai 模板必须包含 prompt 和至少一种参考图占位符。");
}

export function validateImageGenerationSettings(settings: ImageGenerationSettings) {
  if (!settings.model || !settings.endpoint || !settings.apiKey) throw new Error("请完整填写 Provider、模型、Endpoint 和 API Key。");
  if (!/^https:\/\//i.test(settings.endpoint)) throw new Error("Endpoint 必须使用 HTTPS。");
  if (settings.provider === "fal") {
    if (!/^[a-z0-9_-]+\/[a-z0-9_./-]+$/i.test(settings.model)) throw new Error("fal.ai endpoint ID 格式无效。");
    validateFalTemplate(settings.falInputTemplate);
    if (!/^[A-Za-z0-9_-]+(?:\.(?:[A-Za-z0-9_-]+|\d+))*$/.test(settings.falResultPath)) throw new Error("fal.ai 结果路径格式无效。");
  }
}

export async function saveImageGenerationSettings(input: Partial<ImageGenerationSettings>) {
  const provider: ImageGenerationProviderName = input.provider === "fal" ? "fal" : "openrouter";
  const storedProviderKey = provider === "fal" ? process.env.FAL_KEY || "" : process.env.IMAGE_GENERATION_API_KEY || "";
  const apiKey = input.apiKey === "env-configured" ? storedProviderKey : clean(input.apiKey || "");
  const settings: ImageGenerationSettings = {
    provider,
    model: clean(input.model || ""),
    endpoint: clean(input.endpoint || ""),
    apiKey,
    outputFormat: ["png", "jpeg", "webp"].includes(input.outputFormat || "") ? input.outputFormat as OutputFormat : "png",
    falInputTemplate: clean(input.falInputTemplate || IMAGE_GENERATION_DEFAULTS.falInputTemplate),
    falResultPath: clean(input.falResultPath || IMAGE_GENERATION_DEFAULTS.falResultPath)
  };
  validateImageGenerationSettings(settings);

  const envPath = join(process.cwd(), ".env");
  let existing = "";
  try { existing = await readFile(envPath, "utf8"); } catch { /* Create below. */ }
  const entries: Record<string, string> = {
    IMAGE_GENERATION_PROVIDER: settings.provider,
    IMAGE_GENERATION_MODEL: settings.model,
    IMAGE_GENERATION_ENDPOINT: settings.endpoint,
    IMAGE_GENERATION_API_KEY: settings.provider === "openrouter" ? settings.apiKey : process.env.IMAGE_GENERATION_API_KEY || "",
    IMAGE_GENERATION_OUTPUT_FORMAT: settings.outputFormat,
    IMAGE_GENERATION_FAL_INPUT_TEMPLATE: settings.falInputTemplate,
    IMAGE_GENERATION_FAL_RESULT_PATH: settings.falResultPath,
    FAL_KEY: settings.provider === "fal" ? settings.apiKey : process.env.FAL_KEY || ""
  };
  const keys = Object.keys(entries);
  const untouched = existing.split(/\r?\n/).filter((line) => !keys.some((key) => line.startsWith(`${key}=`))).filter(Boolean);
  await writeFile(envPath, [...untouched, ...Object.entries(entries).map(([key, value]) => `${key}=${value}`), ""].join("\n"), { mode: 0o600 });
  Object.assign(process.env, entries);
  return visibleImageGenerationSettings();
}

export function templateForFalModel(model: string, outputFormat: OutputFormat = "png") {
  const preset = FAL_PRESETS.find((item) => item.id === model);
  if (!preset) return undefined;
  return JSON.stringify({
    prompt: "{{prompt}}",
    [preset.imageField]: preset.imageField === "image_urls" ? ["{{image_url}}"] : "{{image_url}}",
    num_images: 1,
    ...preset.defaults,
    ...(preset.supportsOutputFormat ? { output_format: outputFormat } : {})
  });
}
