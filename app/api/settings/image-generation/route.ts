import { NextResponse } from "next/server";
import { saveImageGenerationSettings, visibleImageGenerationSettings, type ImageGenerationSettings } from "../../../../src/lib/image-generation-settings";

export const runtime = "nodejs";

export async function GET() { return NextResponse.json(visibleImageGenerationSettings()); }

export async function POST(request: Request) {
  try { return NextResponse.json(await saveImageGenerationSettings(await request.json() as Partial<ImageGenerationSettings>)); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "无法保存生图配置。" }, { status: 400 }); }
}
