import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const envPath = join(process.cwd(), ".env");
const visible = () => ({ apiKey: process.env.SCRAPECREATORS_API_KEY ? "env-configured" : "" });
const clean = (value: string) => value.replace(/[\r\n]/g, "").trim();

export async function GET() { return NextResponse.json(visible()); }

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { apiKey?: string };
  const apiKey = body.apiKey === "env-configured" ? process.env.SCRAPECREATORS_API_KEY || "" : clean(body.apiKey || "");
  if (!apiKey) return NextResponse.json({ error: "请填写 ScrapeCreators API Key。" }, { status: 400 });
  let existing = "";
  try { existing = await readFile(envPath, "utf8"); } catch { /* Create below. */ }
  const untouched = existing.split(/\r?\n/).filter((line) => !line.startsWith("SCRAPECREATORS_API_KEY=")).filter(Boolean);
  await writeFile(envPath, [...untouched, `SCRAPECREATORS_API_KEY=${apiKey}`, ""].join("\n"), { mode: 0o600 });
  process.env.SCRAPECREATORS_API_KEY = apiKey;
  return NextResponse.json(visible());
}
