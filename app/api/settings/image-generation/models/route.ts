import { NextResponse } from "next/server";
import { FAL_PRESETS, imageGenerationSettingsFromEnv } from "../../../../../src/lib/image-generation-settings";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const provider = new URL(request.url).searchParams.get("provider") || imageGenerationSettingsFromEnv().provider;
  if (provider === "fal") return NextResponse.json({ models: FAL_PRESETS.map((item) => ({ id: item.id, name: item.label })), customAllowed: true });
  const settings = imageGenerationSettingsFromEnv();
  if (!settings.apiKey) return NextResponse.json({ models: [], warning: "请先保存 OpenRouter API Key。" });
  try {
    const response = await fetch(`${settings.endpoint.replace(/\/$/, "")}/images/models`, { headers: { authorization: `Bearer ${settings.apiKey}` }, cache: "no-store" });
    const payload = await response.json() as { data?: Array<{ id: string; name?: string }> };
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return NextResponse.json({ models: (payload.data || []).map((item) => ({ id: item.id, name: item.name || item.id })) });
  } catch (error) {
    return NextResponse.json({ models: [], warning: `无法读取 OpenRouter 生图模型：${error instanceof Error ? error.message : "未知错误"}` });
  }
}
