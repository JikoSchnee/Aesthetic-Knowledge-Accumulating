import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { dataRoot, readSkills, recipeDirectory } from "./library";
import { activeVersionsPath, applyRetrievalProfile, readActiveSkillVersions, retrievalProfileForRecipe, skillIdentity, writeActiveSkillVersions } from "./skill-governance";

type MigrationWrite = { path: string; value: Record<string, unknown>; original?: string };

async function atomicWrite(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2));
  await rename(temporary, path);
}

export async function planRetrievalProfileMigration(root = dataRoot()) {
  const records = await readSkills(root, "all");
  const writes: MigrationWrite[] = [];
  const active = await readActiveSkillVersions(root);
  const activeSkills = { ...active.skills };
  let profilesGenerated = 0; let identitiesAdded = 0; let searchDocumentsUpdated = 0;
  for (const stored of records) {
    const identity = skillIdentity(stored as unknown as Record<string, unknown>);
    const recipe = applyRetrievalProfile(stored.recipe || {});
    if (!stored.recipe?.retrievalProfile) profilesGenerated += 1;
    if (!stored.skillId || !stored.versionId || !stored.version) identitiesAdded += 1;
    const next = { ...stored, skillId: identity.skillId, versionId: identity.versionId, version: identity.version, recipe, recipeSchemaVersion: "1.2" } as unknown as Record<string, unknown>;
    const recordPath = join(recipeDirectory(root, stored.libraryType === "imported_skill" ? "imported_skill" : "photo"), `${stored.id}.json`);
    const original = await readFile(recordPath, "utf8");
    if (JSON.stringify(JSON.parse(original)) !== JSON.stringify(next)) writes.push({ path: recordPath, value: next, original });
    if (identity.status !== "approved") continue;
    activeSkills[identity.skillId] ||= identity.versionId;
    const searchPath = join(root, "search-documents", `${identity.versionId}.json`);
    try {
      const searchOriginal = await readFile(searchPath, "utf8");
      const search = JSON.parse(searchOriginal) as Record<string, unknown>;
      const profile = retrievalProfileForRecipe(recipe);
      const nextSearch = {
        ...search,
        id: identity.versionId,
        skillId: identity.skillId,
        versionId: identity.versionId,
        version: identity.version,
        retrievalProfile: profile,
        searchText: [search.title, search.category, ...(Array.isArray(search.medium) ? search.medium : []), ...(Array.isArray(search.useCases) ? search.useCases : []), ...(Array.isArray(search.tags) ? search.tags : []), profile.description, ...profile.triggerTerms, ...(Array.isArray(search.coreRelationships) ? search.coreRelationships : []), search.reuseFormula, search.typographyText].filter(Boolean).join(" · "),
        recipeSchemaVersion: "1.2",
        searchSchemaVersion: "1.2"
      };
      if (JSON.stringify(JSON.parse(searchOriginal)) !== JSON.stringify(nextSearch)) { writes.push({ path: searchPath, value: nextSearch, original: searchOriginal }); searchDocumentsUpdated += 1; }
    } catch { /* Approval diagnostics will report an approved record without a search document. */ }
  }
  return { root, records: records.length, profilesGenerated, identitiesAdded, searchDocumentsUpdated, writes, activeSkills };
}

export async function migrateRetrievalProfiles(options: { root?: string; dryRun?: boolean } = {}) {
  const plan = await planRetrievalProfileMigration(options.root || dataRoot());
  const report = { dryRun: options.dryRun !== false, records: plan.records, profilesGenerated: plan.profilesGenerated, identitiesAdded: plan.identitiesAdded, searchDocumentsUpdated: plan.searchDocumentsUpdated, filesChanged: plan.writes.length, backupDirectory: undefined as string | undefined };
  if (options.dryRun !== false) return report;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = join(plan.root, "migration-backups", `retrieval-profile-${stamp}`);
  await mkdir(backup, { recursive: true });
  for (const item of plan.writes) {
    if (item.original !== undefined) {
      const relative = item.path.startsWith(`${plan.root}/`) ? item.path.slice(plan.root.length + 1) : item.path.split("/").at(-1) || "record.json";
      const backupPath = join(backup, relative); await mkdir(dirname(backupPath), { recursive: true }); await writeFile(backupPath, item.original);
    }
    await atomicWrite(item.path, item.value);
  }
  try { const originalActive = await readFile(activeVersionsPath(plan.root), "utf8"); await writeFile(join(backup, "active-skill-versions.json"), originalActive); } catch { /* No prior mapping. */ }
  await writeActiveSkillVersions(plan.root, plan.activeSkills);
  report.backupDirectory = backup;
  return report;
}
