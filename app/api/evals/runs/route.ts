import { NextResponse } from "next/server";
import { createEvalRun, deleteEvalGroup, listEvalRuns, publicEvalRun, renameEvalGroup } from "../../../../src/lib/evals";
import type { LibraryType } from "../../../../src/lib/library";

export const runtime = "nodejs";

export async function GET() { return NextResponse.json((await listEvalRuns()).map(publicEvalRun)); }

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as { caseIds?: string[]; topK?: number; library?: LibraryType | "all"; concurrency?: number; groupName?: string };
    return NextResponse.json(publicEvalRun(await createEvalRun(body)));
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "无法创建 Eval 运行。" }, { status: 400 }); }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json() as { groupName?: string; nextGroupName?: string };
    if (!body.groupName || !body.nextGroupName) throw new Error("请填写组名。");
    return NextResponse.json((await renameEvalGroup(body.groupName, body.nextGroupName)).map(publicEvalRun));
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "无法重命名历史组。" }, { status: 400 }); }
}

export async function DELETE(request: Request) {
  try {
    const groupName = new URL(request.url).searchParams.get("group");
    if (!groupName) throw new Error("缺少历史组名。");
    return NextResponse.json({ deletedIds: await deleteEvalGroup(groupName) });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "无法删除历史组。" }, { status: 400 }); }
}
