import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectLocalTransferFiles, resolveTransferTarget, safeTransferPath, validateTransferManifest } from "./local-transfer";

test("local transfer paths stay inside approved data roots", () => {
  assert.equal(safeTransferPath("data/embeddings/" + "a".repeat(64) + ".json"), "data/embeddings/" + "a".repeat(64) + ".json");
  assert.throws(() => safeTransferPath("data/embeddings/../secret"), /不安全/);
  assert.throws(() => resolveTransferTarget("data/recipes/secret.json", "/tmp/project", "/tmp/library"), /不允许写入/);
  const resolved = resolveTransferTarget(`data/embeddings/${"b".repeat(64)}.json`, "/tmp/project", "/tmp/library");
  assert.equal(resolved.target, `/tmp/library/embeddings/${"b".repeat(64)}.json`);
});

test("local transfer manifests reject duplicate, oversized, and mismatched entries", () => {
  const path = `data/embeddings/${"c".repeat(64)}.json`;
  const file = { section: "embeddings", path, size: 2, sha256: "d".repeat(64) };
  assert.equal(validateTransferManifest({ schemaVersion: "1.0", createdAt: new Date(0).toISOString(), excludes: [], files: [file] }).files.length, 1);
  assert.throws(() => validateTransferManifest({ schemaVersion: "1.0", files: [file, file] }), /重复/);
  assert.throws(() => validateTransferManifest({ schemaVersion: "1.0", files: [{ ...file, section: "uploads" }] }), /分类/);
  assert.throws(() => validateTransferManifest({ schemaVersion: "1.0", files: [file], embeddingConfig: { endpoint: 42, model: "model" } }), /Embedding 配置无效/);
  assert.deepEqual(validateTransferManifest({ schemaVersion: "1.0", files: [file], embeddingConfig: { endpoint: " https://example.com/v1 ", model: " model " } }).embeddingConfig, { endpoint: "https://example.com/v1", model: "model" });
});

test("local transfer collection hashes only selected portable files", async () => {
  const root = await mkdtemp(join(tmpdir(), "taste-transfer-"));
  const project = join(root, "project"); const library = join(root, "library"); const id = "e".repeat(64);
  try {
    await mkdir(join(library, "embeddings"), { recursive: true });
    await mkdir(join(library, "uploads", "default"), { recursive: true });
    await writeFile(join(library, "embeddings", `${id}.json`), "{}");
    await writeFile(join(library, "uploads", "default", "photo.jpg"), Buffer.from([0xff, 0xd8, 0xff]));
    const result = await collectLocalTransferFiles(["embeddings"], project, library);
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].path, `data/embeddings/${id}.json`);
    assert.equal(result.files[0].sha256.length, 64);
  } finally { await rm(root, { recursive: true, force: true }); }
});
