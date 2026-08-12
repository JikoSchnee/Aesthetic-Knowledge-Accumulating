import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { RetrievalProfile } from "./skill-governance";

export type LibraryType = "photo" | "imported_skill";

export type StoredSkill = {
  id: string;
  skillId?: string;
  versionId?: string;
  version?: number;
  libraryType?: LibraryType;
  status: "needs_review" | "approved" | "rejected" | string;
  createdAt: string;
  recipe: Record<string, unknown> & { metadata?: { title?: string; category?: string }; retrievalProfile?: RetrievalProfile };
  embeddingStatus?: string;
  embeddingModel?: string;
  embeddingUpdatedAt?: string;
  embeddingError?: string;
  indexStatus?: string;
  [key: string]: unknown;
};

export function dataRoot() { return process.env.TASTE_STUDIO_DATA_DIR || join(process.cwd(), "data"); }
export function recipeDirectory(root: string, library: LibraryType) { return join(root, library === "photo" ? "recipes" : "imported-skills"); }

async function readDirectory(root: string, library: LibraryType): Promise<StoredSkill[]> {
  const directory = recipeDirectory(root, library);
  try {
    return await Promise.all((await readdir(directory)).filter((file) => file.endsWith(".json")).map(async (file) => {
      const value = JSON.parse(await readFile(join(directory, file), "utf8")) as StoredSkill;
      return { ...value, libraryType: value.libraryType || library };
    }));
  } catch { return []; }
}

export async function readSkills(root = dataRoot(), library: LibraryType | "all" = "all") {
  if (library !== "all") return readDirectory(root, library);
  const [photo, imported] = await Promise.all([readDirectory(root, "photo"), readDirectory(root, "imported_skill")]);
  return [...photo, ...imported];
}

export async function locateSkill(root: string, id: string, preferred?: LibraryType) {
  const order: LibraryType[] = preferred ? [preferred, preferred === "photo" ? "imported_skill" : "photo"] : ["photo", "imported_skill"];
  for (const library of order) {
    const path = join(recipeDirectory(root, library), `${id}.json`);
    try { await access(path); return { library, path }; } catch { /* Continue. */ }
  }
  return undefined;
}

export function normaliseLibrary(value: string | null | undefined): LibraryType | "all" {
  return value === "photo" || value === "imported_skill" ? value : "all";
}
