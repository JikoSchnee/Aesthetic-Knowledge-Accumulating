import { NextResponse } from "next/server";
import { fetchGitHubSkillDocuments, GitHubImportError } from "../../../../../src/lib/github-skill-import";
import { stageSkillCandidates } from "../../../../../src/lib/skill-intake";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const body = await request.json() as { url?: string };
    if (!body.url || body.url.length > 2048) return NextResponse.json({ error: "请输入 GitHub Skill 链接。" }, { status: 400 });
    const result = await fetchGitHubSkillDocuments(body.url.trim());
    const intake = await stageSkillCandidates(result.candidates, result.rejected);
    return NextResponse.json({ ...intake, repository: result.repository });
  } catch (error) {
    if (error instanceof GitHubImportError) return NextResponse.json({ error: error.message, ...error.details }, { status: error.status });
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法读取 GitHub Skill。" }, { status: 400 });
  }
}
