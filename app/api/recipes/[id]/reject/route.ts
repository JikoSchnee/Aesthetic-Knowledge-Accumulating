import { readFile, writeFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { dataRoot, locateSkill } from "../../../../../src/lib/library";

export const runtime = "nodejs";

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[a-f0-9]{64}$/.test(id)) return NextResponse.json({ error: "Invalid recipe id." }, { status: 400 });
  try {
    const located = await locateSkill(dataRoot(), id);
    if (!located) return NextResponse.json({ error: "Recipe not found." }, { status: 404 });
    const recipePath = located.path;
    const stored = JSON.parse(await readFile(recipePath, "utf8"));
    if (stored.status !== "needs_review") return NextResponse.json({ error: "Recipe is not awaiting review." }, { status: 409 });
    stored.status = "rejected";
    stored.duplicateDecision = "skipped";
    stored.rejectedAt = new Date().toISOString();
    await writeFile(recipePath, JSON.stringify(stored, null, 2));
    return NextResponse.json({ id, status: "rejected" });
  } catch { return NextResponse.json({ error: "Recipe not found." }, { status: 404 }); }
}
