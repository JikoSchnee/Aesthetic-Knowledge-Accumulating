import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const defaults = { provider: "openrouter", model: "google/gemini-2.5-flash", endpoint: "https://openrouter.ai/api/v1" };
const envPath = join(process.cwd(), ".env");
const visible = () => ({ provider: process.env.VISION_PROVIDER || defaults.provider, model: process.env.VISION_MODEL || defaults.model, endpoint: process.env.VISION_ENDPOINT || defaults.endpoint, apiKey: process.env.VISION_API_KEY ? "env-configured" : "" });
const value = (input: string) => input.replace(/[\r\n]/g, "").trim();

export async function GET() { return NextResponse.json(visible()); }

export async function POST(request: Request) {
  const body = await request.json() as { provider?: string; model?: string; endpoint?: string; apiKey?: string };
  const provider = value(body.provider || ""); const model = value(body.model || ""); const endpoint = value(body.endpoint || ""); const apiKey = body.apiKey === "env-configured" ? process.env.VISION_API_KEY || "" : value(body.apiKey || "");
  if (!provider || !model || !endpoint || !apiKey) return NextResponse.json({ error: "请完整填写服务商、模型、Endpoint 和 API Key。" }, { status: 400 });
  let existing = ""; try { existing = await readFile(envPath, "utf8"); } catch { /* Create below. */ }
  const entries = { VISION_PROVIDER: provider, VISION_MODEL: model, VISION_ENDPOINT: endpoint, VISION_API_KEY: apiKey };
  const untouched = existing.split(/\r?\n/).filter((line) => !Object.keys(entries).some((key) => line.startsWith(`${key}=`))).filter(Boolean);
  await writeFile(envPath, [...untouched, ...Object.entries(entries).map(([key, item]) => `${key}=${item}`), ""].join("\n"), { mode: 0o600 });
  Object.assign(process.env, entries);
  return NextResponse.json(visible());
}
