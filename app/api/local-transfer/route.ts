import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
import JSZip from "jszip";
import { NextResponse } from "next/server";
import { LOCAL_TRANSFER_MAX_BYTES, localTransferStats, resolveTransferTarget, safeTransferPath, validateTransferManifest } from "../../../src/lib/local-transfer";

export const runtime = "nodejs";
export const maxDuration = 300;

const rasterFormat = (bytes: Buffer) => {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "webp";
  return undefined;
};

export async function GET() {
  try { return NextResponse.json(await localTransferStats()); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "无法统计本地迁移数据。" }, { status: 500 }); }
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const archive = form.get("archive");
    if (!(archive instanceof File) || !archive.name.toLowerCase().endsWith(".zip")) return NextResponse.json({ error: "请选择本应用生成的 ZIP 迁移包。" }, { status: 400 });
    if (archive.size > LOCAL_TRANSFER_MAX_BYTES) return NextResponse.json({ error: "迁移包超过 2GB 上限。" }, { status: 413 });
    const zip = await JSZip.loadAsync(await archive.arrayBuffer(), { createFolders: false });
    const manifestEntry = zip.file("manifest.json");
    if (!manifestEntry) throw new Error("迁移包缺少 manifest.json。");
    const manifest = validateTransferManifest(JSON.parse(await manifestEntry.async("string")));
    const declared = new Set(manifest.files.map((file) => file.path));
    const extras = Object.values(zip.files).filter((entry) => !entry.dir && safeTransferPath((entry as unknown as { unsafeOriginalName?: string }).unsafeOriginalName || entry.name) !== "manifest.json" && !declared.has(safeTransferPath((entry as unknown as { unsafeOriginalName?: string }).unsafeOriginalName || entry.name)));
    if (extras.length) throw new Error("迁移包包含清单之外的文件。");

    for (const file of manifest.files) {
      const entry = zip.file(file.path);
      if (!entry || entry.dir) throw new Error(`迁移包缺少 ${file.path}。`);
      const declaredSize = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
      if (typeof declaredSize === "number" && declaredSize !== file.size) throw new Error(`${file.path} 的压缩信息与清单不一致。`);
      const bytes = await entry.async("nodebuffer");
      if (bytes.length !== file.size || createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw new Error(`${file.path} 完整性校验失败。`);
      const extension = extname(file.path).toLowerCase();
      if (extension === ".json") JSON.parse(bytes.toString("utf8"));
      else if (!rasterFormat(bytes)) throw new Error(`${file.path} 不是有效图片。`);
      resolveTransferTarget(file.path);
    }

    let imported = 0; let replaced = 0; let unchanged = 0;
    for (const file of manifest.files) {
      const bytes = await zip.file(file.path)!.async("nodebuffer");
      const { target } = resolveTransferTarget(file.path);
      const existing = await readFile(target).catch(() => undefined);
      if (existing?.equals(bytes)) { unchanged += 1; continue; }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
      if (existing) replaced += 1; else imported += 1;
    }
    return NextResponse.json({ imported, replaced, unchanged, total: manifest.files.length, embeddingConfig: manifest.embeddingConfig });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法导入本地迁移包。" }, { status: 400 });
  }
}
