import { NextResponse } from "next/server";
import { readEvalSkillDetail } from "../../../../../../../src/lib/evals";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ id: string; skillId: string }> }) {
  try {
    const { id, skillId } = await params;
    const file = new URL(request.url).searchParams.get("file") || undefined;
    return NextResponse.json(await readEvalSkillDetail(id, skillId, file));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法读取 Skill 详情。" }, { status: 404 });
  }
}
