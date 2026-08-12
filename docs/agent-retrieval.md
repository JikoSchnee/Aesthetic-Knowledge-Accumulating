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

## Approval and version gate

Eligibility is resolved before any score or Top-K cutoff. A search document is only eligible when its backing skill record is `approved`, its `versionId` is the active approved version for the stable `skillId`, its identity and library fields agree with the record, and it is not explicitly excluded. Pending, rejected, superseded, missing, mismatched, and invalid-index candidates are reported in retrieval diagnostics and never participate in ranking.

Missing, stale, or model-incompatible embeddings do not remove an otherwise eligible Skill. They only force that candidate onto the keyword fallback path. A newly created version remains `needs_review`; the prior approved version stays active until approval atomically switches the active-version pointer.

`retrievalProfile.description` and `triggerTerms` are positive retrieval text. `excludeWhen` documents non-applicable cases but must never be appended to positive keyword or embedding input.

## Compatibility gate

Before comparing a query vector with a Skill vector, verify all of the following in `embedding.json`:

1. The query and Skill use the same embedding model identity.
2. Their vector dimensions are identical.
3. The three `contentHashes` still match the current recipe-derived texts.

If any check fails, do not compute similarity. Rebuild the Skill vectors once with the agent's embedding model and cache them locally. Never regenerate every Skill for every user query.

## Hybrid ranking method

1. Load search documents and validate them against skill records and active-version pointers.
2. Remove all ineligible candidates and record the rejection reason for each one.
3. Convert the user's complete request into one query vector.
4. For every compatible eligible Skill, calculate cosine similarity against `intent`, `visual`, and `adaptation`.
5. Compute semantic score as `intent × 0.45 + visual × 0.40 + adaptation × 0.15`.
6. Compute a normalized keyword score from the query against `search-document.json.searchText`.
7. Compute final score as `semantic × 0.85 + keyword × 0.15`.
8. Rank descending, apply Top-K, and report the strongest vector dimension as the match reason.

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

Eval runs with manifest schema `2.0` persist their eligible pool, search documents, recipes, compatible vectors, prompts, model IDs, endpoints, and generation parameters at creation time. Resume only reads this snapshot. Schema `1.0` runs remain readable but are legacy and not strictly reproducible.
