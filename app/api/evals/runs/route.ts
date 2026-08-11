import { NextResponse } from "next/server";
import { createEvalRun, listEvalRuns, publicEvalRun } from "../../../../src/lib/evals";
import type { LibraryType } from "../../../../src/lib/library";

export const runtime = "nodejs";

export async function GET() { return NextResponse.json((await listEvalRuns()).map(publicEvalRun)); }

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as { caseIds?: string[]; topK?: number; library?: LibraryType | "all" };
    return NextResponse.json(publicEvalRun(await createEvalRun(body)));
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "无法创建 Eval 运行。" }, { status: 400 }); }
}
