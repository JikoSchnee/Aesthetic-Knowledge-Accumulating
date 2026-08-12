import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { NextResponse } from "next/server";
import { locateSkill } from "../../../../src/lib/library";

export const runtime = "nodejs";

type PackageFile = { path: string; content: string; mime: string };

function markdown(recipe: Record<string, unknown>) {
  const metadata = (recipe.metadata || {}) as { title?: string; category?: string; medium?: string[]; useCases?: string[]; retrievalTags?: string[] };
  const list = (items: unknown) => Array.isArray(items) ? items.map((item) => `- ${item}`).join("\n") : "";
  return `# ${metadata.title || "Visual Recipe"}\n\n## Recipe Metadata\n- Category: ${metadata.category || ""}\n- Medium: ${(metadata.medium || []).join(", ")}\n- Use cases: ${(metadata.useCases || []).join(", ")}\n- Tags: ${(metadata.retrievalTags || []).join(", ")}\n\n## One-Sentence Visual Definition\n${recipe.visualDefinition || ""}\n\n## Core Visual Relationships\n${list(recipe.coreVisualRelationships)}\n\n## Core Invariants\n${list(recipe.coreInvariants)}\n\n## Composition and Visual Hierarchy\n${JSON.stringify(recipe.compositionAndHierarchy || {}, null, 2)}\n\n## Space and Overlap\n${JSON.stringify(recipe.spaceAndOverlap || {}, null, 2)}\n\n## Subject, Action, and Narrative\n${JSON.stringify(recipe.subjectActionAndNarrative || {}, null, 2)}\n\n## Color System\n${JSON.stringify(recipe.colorSystem || {}, null, 2)}\n\n## Light and Atmosphere\n${JSON.stringify(recipe.lightAndAtmosphere || {}, null, 2)}\n\n## Material and Process Marks\n${JSON.stringify(recipe.materialAndProcess || {}, null, 2)}\n\n## Typography and Graphic Language\n${JSON.stringify(recipe.typographyAndGraphicLanguage || {}, null, 2)}\n\n## Adjustable Variables\n${list(recipe.adjustableVariables)}\n\n## Must Redesign\n${list(recipe.mustRedesign)}\n\n## Aesthetic Floor\n${JSON.stringify(recipe.aestheticFloor || {}, null, 2)}\n\n## Post-Generation Checks\n${list(recipe.postGenerationChecks)}\n\n## Reuse Formula\n${recipe.reuseFormula || ""}\n`;
}

function sanitise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitise);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => !/(api.?key|authorization|raw.*response|base64)/i.test(key)).map(([key, entry]) => [key, sanitise(entry)]));
}

const guide = `---
name: taste-skill-library
description: Progressive-loading instructions for an exported library of reviewed visual recipes.
---

# Taste Skill Library

## Start here

Select the relevant folder under \`skills/\`. Read its \`recipe.md\` first for a complete, human-readable visual direction. Do not load every Skill.

## Progressive loading

1. Read \`references/composition.md\` when composition, hierarchy, space, action, or narrative is needed.
2. Read \`references/color-material.md\` when palette, lighting, material, texture, or finish is needed.
3. Read \`references/graphic-language.md\` for typography or graphic-language work. When text must be reliable, generate the base without final text. Use a real font when \`fontRequired\` is true; when it is false, construct original SVG outlines or hand lettering instead of searching for a nonexistent font.
4. Read \`references/adaptation.md\` before adapting a recipe; it defines variables and non-negotiable redesign constraints.
5. Read \`references/verification.md\` before finalising output or resolving a duplicate-Skill decision.
6. Read \`references/retrieval.md\` before semantic retrieval. It defines vector roles, compatibility, weighting, fallback, and post-retrieval loading.
7. Read \`skill-record.json\` only when provenance, status, model, approval, or duplicate-governance data is required.

## Boundaries

Use a Skill as a visual decision system, not a request to copy source text, logos, signatures, protected characters, exact arrangement, or a living artist's distinctive style. Respect every Skill's \`mustRedesign\` and \`aestheticFloor\` fields.
`;

const references: Record<string, string> = {
  "references/composition.md": `# Composition and Narrative\n\nUse \`visualDefinition\` to establish the single visual direction. Use \`coreVisualRelationships\` and \`coreInvariants\` as constraints, then consult \`compositionAndHierarchy\`, \`spaceAndOverlap\`, and \`subjectActionAndNarrative\` for placement, scale, depth, and eye path. Preserve relationships and hierarchy; redesign literal objects and arrangements.\n`,
  "references/color-material.md": `# Color, Light, and Material\n\nRead \`colorSystem\` before selecting a palette. Its dominant, contrast, accent, value, and restriction fields define roles rather than fixed swatches. Load \`lightAndAtmosphere\` and \`materialAndProcess\` only when present in the target Skill. Treat their directions as visual behavior, not source-image copying instructions.\n`,
  "references/adaptation.md": `# Adaptation\n\nStart with \`reuseFormula\` for a compact direction, then choose only from \`adjustableVariables\`. Every item in \`mustRedesign\` is mandatory. \`aestheticFloor.mustAchieve\` defines acceptance criteria; \`aestheticFloor.avoid\` defines rejection criteria. Do not average unrelated Skills into one direction.\n`,
  "references/verification.md": `# Verification and Governance\n\nRun \`postGenerationChecks\` before delivering work. A Skill is approved only after human review. If \`skill-record.json\` contains \`duplicateCandidates\`, treat it as a governance signal: preserve it as an independent Skill only when its visual role is intentionally distinct; otherwise reject it.\n`
};

export async function POST(request: Request) {
  const { ids, destination } = await request.json() as { ids?: string[]; destination?: string };
  if (!ids?.length || ids.some((id) => !/^[a-f0-9]{64}$/.test(id))) return NextResponse.json({ error: "No valid recipes selected." }, { status: 400 });
  const dataDir = process.env.TASTE_STUDIO_DATA_DIR || join(process.cwd(), "data");
  const packageName = `taste-skill-export-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const retrievalReference = await readFile(join(process.cwd(), "docs", "agent-retrieval.md"), "utf8");
  const graphicLanguageReference = await readFile(join(process.cwd(), "docs", "graphic-language.md"), "utf8");
  const files: PackageFile[] = [{ path: "SKILL.md", content: guide, mime: "text/markdown" }, ...Object.entries(references).map(([path, content]) => ({ path, content, mime: "text/markdown" })), { path: "references/graphic-language.md", content: graphicLanguageReference, mime: "text/markdown" }, { path: "references/retrieval.md", content: retrievalReference, mime: "text/markdown" }];
  const skills: Array<{ id: string; title: string; directory: string; libraryType: string; files: string[] }> = [];

  for (const id of ids) {
    const located = await locateSkill(dataDir, id);
    if (!located) continue;
    const stored = JSON.parse(await readFile(located.path, "utf8"));
    if (stored.status !== "approved") continue;
    const search = await readFile(join(dataDir, "search-documents", `${id}.json`), "utf8");
    const slug = String(stored.recipe?.metadata?.title || "visual-recipe").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "visual-recipe";
    const directory = `skills/${slug}-${id.slice(0, 8)}`;
    const embedding = await readFile(join(dataDir, "embeddings", `${id}.json`), "utf8").catch(() => "");
    const source = stored.source as { sourceDirectory?: string; files?: string[] } | undefined;
    const sourceFiles: PackageFile[] = [];
    if (located.library === "imported_skill" && source?.sourceDirectory && Array.isArray(source.files)) {
      for (const sourceFile of source.files) {
        const content = await readFile(join(dataDir, source.sourceDirectory, sourceFile), "utf8").catch(() => "");
        if (content) sourceFiles.push({ path: `${directory}/source-files/${sourceFile}`, content, mime: sourceFile.endsWith(".json") ? "application/json" : "text/plain" });
      }
    }
    const childFiles = ["skill-record.json", "recipe.json", "recipe.md", "search-document.json", ...(embedding ? ["embedding.json"] : []), ...sourceFiles.map((file) => file.path.slice(directory.length + 1))];
    files.push(
      { path: `${directory}/skill-record.json`, content: JSON.stringify(sanitise(stored), null, 2), mime: "application/json" },
      { path: `${directory}/recipe.json`, content: JSON.stringify(stored.recipe, null, 2), mime: "application/json" },
      { path: `${directory}/recipe.md`, content: markdown(stored.recipe), mime: "text/markdown" },
      { path: `${directory}/search-document.json`, content: search, mime: "application/json" },
      ...(embedding ? [{ path: `${directory}/embedding.json`, content: embedding, mime: "application/json" }] : []),
      ...sourceFiles
    );
    skills.push({ id, title: stored.recipe?.metadata?.title || "Untitled visual recipe", directory, libraryType: stored.libraryType || located.library, files: childFiles });
  }

  const manifest = { packageName, exportedAt: new Date().toISOString(), recipeSchemaVersion: "1.2", searchSchemaVersion: "1.2", typographySchemaVersion: "1.1", embeddingSchemaVersion: "1.0", sourceImagesIncluded: false, excludes: ["source images", "font files", "source wording", "API keys", "authorization headers", "raw provider responses", "image Base64"], skills, sharedFiles: ["SKILL.md", ...Object.keys(references), "references/graphic-language.md", "references/retrieval.md"], files: ["manifest.json", ...files.map((file) => file.path)] };
  files.unshift({ path: "manifest.json", content: JSON.stringify(manifest, null, 2), mime: "application/json" });

  if (destination) {
    const target = destination.startsWith("~/") ? join(homedir(), destination.slice(2)) : destination;
    if (!isAbsolute(target) || target === "/") return NextResponse.json({ error: "请输入有效的绝对导出路径，例如 ~/Downloads/审美配方。" }, { status: 400 });
    const root = join(target, packageName);
    await Promise.all(files.map(async (file) => { const output = join(root, file.path); await mkdir(join(output, ".."), { recursive: true }); await writeFile(output, file.content); }));
    return NextResponse.json({ exported: skills.length, packageName, writtenTo: root });
  }
  return NextResponse.json({ exported: skills.length, packageName, files });
}
