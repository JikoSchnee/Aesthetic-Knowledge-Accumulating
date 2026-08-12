import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import JSZip from "jszip";
import { collectLocalTransferFiles, type LocalTransferManifest, type LocalTransferSection } from "../../../../src/lib/local-transfer";

export const runtime = "nodejs";
export const maxDuration = 300;

const allowed = new Set<LocalTransferSection>(["embeddings", "uploads", "evals"]);

async function exportArchive(sections: LocalTransferSection[], embeddingConfig?: { endpoint?: string; model?: string }) {
  try {
    sections = [...new Set(sections.filter((section) => allowed.has(section)))];
    if (!sections.length) return Response.json({ error: "请至少选择一类本地数据。" }, { status: 400 });
    const { files } = await collectLocalTransferFiles(sections);
    if (!files.length) return Response.json({ error: "所选分类没有可打包的文件。" }, { status: 404 });
    const safeEmbeddingConfig = embeddingConfig?.endpoint?.trim() && embeddingConfig.model?.trim() ? { endpoint: embeddingConfig.endpoint.trim().slice(0, 500), model: embeddingConfig.model.trim().slice(0, 200) } : undefined;
    const manifest: LocalTransferManifest = {
      schemaVersion: "1.0",
      createdAt: new Date().toISOString(),
      excludes: ["API keys", ".env files", "Skill records synchronized through Git", "SQLite databases"],
      ...(safeEmbeddingConfig ? { embeddingConfig: safeEmbeddingConfig } : {}),
      files: files.map(({ absolutePath: _absolutePath, ...file }) => file)
    };
    const zip = new JSZip();
    zip.file("manifest.json", JSON.stringify(manifest, null, 2));
    for (const file of files) zip.file(file.path, createReadStream(file.absolutePath), { compression: file.path.endsWith(".json") ? "DEFLATE" : "STORE", compressionOptions: { level: 6 } });
    const stream = zip.generateNodeStream({ type: "nodebuffer", streamFiles: true });
    const filename = `taste-studio-local-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;
    return new Response(Readable.toWeb(stream as Readable) as ReadableStream, { headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${filename}"`, "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "无法创建本地迁移包。" }, { status: 400 });
  }
}

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  return exportArchive(query.get("sections")?.split(",") as LocalTransferSection[] || [], { endpoint: query.get("endpoint") || "", model: query.get("model") || "" });
}

export async function POST(request: Request) {
  const body = await request.json() as { sections?: LocalTransferSection[]; embeddingConfig?: { endpoint?: string; model?: string } };
  return exportArchive(body.sections || [], body.embeddingConfig);
}
