# Semantic Retrieval Protocol

This document defines how an agent retrieves Skills from this library. It is a shared protocol: do not copy it into individual Skill folders.

## Retrieval assets

Each Skill may contain `embedding.json`. It has three document vectors created from the same embedding model:

| Vector | Source fields | Use it when the request asks for |
| --- | --- | --- |
| `vectors.intent` | title, category, media, use cases, tags, visual definition | the right kind of deliverable, audience, category, or application |
| `vectors.visual` | visual definition, core relationships and invariants, composition, space, color, light, material, typography | a particular visual language, hierarchy, palette, texture, atmosphere, or image behavior |
| `vectors.adaptation` | reuse formula, adjustable variables, must-redesign rules, aesthetic floor, post-generation checks | a safe way to adapt a Skill while preserving its aesthetic constraints |

The vectors are retrieval keys, not instructions to copy a source image. The recipe and shared references remain the source of actual creative constraints.

## Compatibility gate

Before comparing a query vector with a Skill vector, verify all of the following in `embedding.json`:

1. The query and Skill use the same embedding model identity.
2. Their vector dimensions are identical.
3. The three `contentHashes` still match the current recipe-derived texts.

If any check fails, do not compute similarity. Rebuild the Skill vectors once with the agent's embedding model and cache them locally. Never regenerate every Skill for every user query.

## Hybrid ranking method

1. Convert the user's complete request into one query vector.
2. For every compatible Skill, calculate cosine similarity against `intent`, `visual`, and `adaptation`.
3. Compute semantic score as `intent × 0.45 + visual × 0.40 + adaptation × 0.15`.
4. Compute a normalized keyword score from the query against `search-document.json.searchText`.
5. Compute final score as `semantic × 0.85 + keyword × 0.15`.
6. Rank descending, return the five best candidates, and report the strongest vector dimension as the match reason.

The weight distribution is intentional: choose the correct use case first, then visual behavior, then adaptation details. Do not merge unrelated high-ranking Skills unless the user explicitly asks for a synthesis.

## Fallback behavior

Use keyword-only ranking when no embedding API is configured, the API fails, no compatible Skill vectors are available, or a Skill's content hash is stale. Mark this result as `keyword` mode rather than implying semantic confidence.

An embedding failure must not make an approved Skill unavailable: the Skill remains keyword-searchable and can be re-indexed later.

## Progressive loading after retrieval

1. Read the target Skill's `recipe.md` only after it ranks as a candidate.
2. Load `references/composition.md` for layout, hierarchy, space, action, or narrative work.
3. Load `references/color-material.md` for palette, lighting, materials, and finish.
4. Load `references/graphic-language.md` only for type or graphic-language work.
5. Load `references/adaptation.md` before changing the Skill's subject, copy, objects, or context.
6. Load `references/verification.md` before delivery.
7. Read `skill-record.json` only for provenance, approval, duplicate, or index-governance questions.

Always obey the target Skill's `mustRedesign`, `aestheticFloor`, and `postGenerationChecks`. Do not use semantic similarity as permission to copy protected text, logos, signatures, characters, or an exact source arrangement.
