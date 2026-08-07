export type RecipeLike = {
  id: string;
  status?: string;
  recipe?: {
    metadata?: { title?: string; retrievalTags?: string[] };
    coreVisualRelationships?: string[];
    reuseFormula?: string;
  };
};

export type DuplicateCandidate = { id: string; title: string; similarity: number; overlap: string[] };

export function dedupeText(recipe: RecipeLike["recipe"]) {
  const metadata = recipe?.metadata || {};
  return [metadata.title, ...(metadata.retrievalTags || []), ...(recipe?.coreVisualRelationships || []), recipe?.reuseFormula]
    .filter(Boolean).join(" ").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function terms(text: string) { return new Set(text.split(" ").filter((word) => word.length >= 3)); }

export function findDuplicateCandidates(recipe: RecipeLike["recipe"], existing: RecipeLike[], threshold = 0.5): DuplicateCandidate[] {
  const current = terms(dedupeText(recipe));
  if (!current.size) return [];
  return existing.filter((item) => item.status === "needs_review" || item.status === "approved").map((item) => {
    const other = terms(dedupeText(item.recipe));
    const overlap = [...current].filter((term) => other.has(term));
    const similarity = overlap.length / new Set([...current, ...other]).size;
    return { id: item.id, title: item.recipe?.metadata?.title || "Untitled visual recipe", similarity: Number(similarity.toFixed(2)), overlap: overlap.slice(0, 8) };
  }).filter((item) => item.similarity >= threshold).sort((a, b) => b.similarity - a.similarity);
}
