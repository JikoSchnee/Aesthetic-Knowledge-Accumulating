import { extname } from "node:path";
import JSZip from "jszip";
import { NextResponse } from "next/server";
import { ALLOWED_SKILL_EXTENSIONS, buildSkillCandidates, MAX_SKILL_FILES, MAX_SKILL_FILE_BYTES, MAX_SKILL_TOTAL_BYTES, safeSkillPath, stageSkillCandidates, validateSkillDocument, type SkillDocument } from "../../../../../src/lib/skill-intake";

export const runtime = "nodejs";
export const maxDuration = 300;

async function filesFromUpload(files: File[], requestedPaths: string[]) {
  const documents: SkillDocument[] = []; const rejected: Array<{ file: string; reason: string }> = []; let total = 0;
  const add = (rawPath: string, content: string) => {
    const result = validateSkillDocument(rawPath, content);
    if (result.rejected) { rejected.push(result.rejected); return; }
    total += result.bytes || 0; if (total > MAX_SKILL_TOTAL_BYTES) throw new Error("Skill documents exceed the 20MB extracted limit.");
    documents.push(result.document!);
  };
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (file.size > MAX_SKILL_TOTAL_BYTES) { rejected.push({ file: file.name, reason: "File exceeds 20MB." }); continue; }
    if (file.name.toLowerCase().endsWith(".zip")) {
      const zip = await JSZip.loadAsync(await file.arrayBuffer(), { checkCRC32: true, createFolders: false });
      const entries = Object.values(zip.files).filter((entry) => !entry.dir);
      if (entries.length > MAX_SKILL_FILES) throw new Error(`ZIP contains more than ${MAX_SKILL_FILES} files.`);
      for (const entry of entries) {
        const path = safeSkillPath((entry as unknown as { unsafeOriginalName?: string }).unsafeOriginalName || entry.name);
        if (!ALLOWED_SKILL_EXTENSIONS.has(extname(path).toLowerCase())) { rejected.push({ file: path, reason: "Unsupported or executable file type." }); continue; }
        const declaredSize = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize || 0;
        if (declaredSize > MAX_SKILL_FILE_BYTES || total + declaredSize > MAX_SKILL_TOTAL_BYTES) throw new Error("ZIP declares extracted content beyond the safe size limit.");
        const content = await entry.async("string"); add(path, content);
      }
    } else add(requestedPaths[index] || file.name, await file.text());
  }
  if (documents.length > MAX_SKILL_FILES) throw new Error(`Selection contains more than ${MAX_SKILL_FILES} allowed documents.`);
  return { documents, rejected };
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const files = form.getAll("skills").filter((entry): entry is File => entry instanceof File);
    const paths = JSON.parse(String(form.get("paths") || "[]")) as string[];
    if (!files.length) return NextResponse.json({ error: "No Skill files supplied." }, { status: 400 });
    const { documents, rejected } = await filesFromUpload(files, paths);
    const discovered = buildSkillCandidates(documents);
    if (!discovered.length) return NextResponse.json({ error: "No SKILL.md or compatible recipe.json was found.", rejected }, { status: 422 });
    return NextResponse.json(await stageSkillCandidates(discovered, rejected));
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to inspect Skill package." }, { status: 400 }); }
}
