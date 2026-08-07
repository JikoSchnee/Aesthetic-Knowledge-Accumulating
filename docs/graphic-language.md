# Typography and Graphic Language

Load this reference only when the target Skill contains `typographyAndGraphicLanguage` and the task involves visible text or graphic language.

## Reading the fields

- `presence` says whether typography is dominant, supporting, or absent.
- `constructionMode` decides whether the visible letterform is reproducible typesetting, a modified font, custom lettering, or illustrated type. Make this decision before consulting candidate fonts.
- `fontRequired` is a routing flag. When false, stop searching for an exact font file and construct the required glyphs instead.
- `baseSkeleton` records the broad proportions and stroke logic that can seed a new lettering system without copying the source.
- `letterConstructionRules` defines reusable rules shared by the letters; `characterSpecificRedesigns` lists exceptions that must be drawn individually.
- `recommendedProductionMethod` selects real-font, variable-font, SVG-outline, or hand-lettering production.
- `roles` describes each typographic level. Treat `classification`, `anatomy`, and `typesetting` as the primary evidence; `hierarchyLevel` establishes relative importance.
- `composition` describes the text block's position, scale, rotation, warp, overlap, and relationship to imagery.
- `treatment` describes fill, outline, shadow, depth, texture, and distortion after typesetting.
- `pairingStrategy` explains how multiple roles contrast or cooperate.
- `graphicDevices` covers rules, frames, labels, badges, and related non-font elements.
- `substitutionGuidance.preserve` and `.avoid` are binding constraints. Candidate names are approximate directions, not exact font identification.
- `verificationChecks` defines the final acceptance test.

## Font substitution

Choose an available, properly licensed font by matching observable anatomy before matching a candidate name. Compare width, weight, stroke contrast, x-height, terminals, corners, counters, and stroke character. Then reproduce case, tracking, leading, line-break rhythm, density, and hierarchy. Reject a candidate that has the right genre label but the wrong proportions.

Never reuse source wording, a logo, or a brand identity. Replace all copy and redesign the exact arrangement while preserving the reusable relationship described by the Skill.

## Construction modes

- `font-based`: choose and typeset a licensed font; reproduce the recorded anatomy, spacing, hierarchy, and treatments.
- `modified-font`: begin from a licensed font or variable-font skeleton, convert or preserve it as editable geometry, then apply the recorded structural modifications. Do not present the base font unchanged.
- `custom-lettering`: treat every required character as designed geometry. Candidate fonts are skeleton references only, not expected matches.
- `illustrated-type`: construct letters and their image, material, texture, or dimensional effects as one graphic system. Preserve legibility checks while accepting that glyph and illustration boundaries may merge.
- `none`: do not introduce typography merely to fill space.

## Custom lettering workflow

When `fontRequired` is false:

1. Stop trying to identify an exact font. Read `baseSkeleton` to establish width, weight, contrast, axis, curve tension, terminals, counters, and stroke rhythm.
2. Design only the characters required by the new, original copy. Do not reconstruct the source alphabet, wording, logo, or signature.
3. Apply every `letterConstructionRules` item consistently so the characters behave as one family.
4. Apply `characterSpecificRedesigns` after the shared system; these exceptions should remain intentional rather than accidental inconsistencies.
5. Use `svg-outline` for editable, repeatable contours and `hand-lettering` when irregular gesture is the primary construction logic. Keep the result editable until spacing and legibility pass verification.
6. Treat candidate font names or categories only as starting references for proportions. Never claim that a custom-lettered result is an identified commercial font.

## Two-stage composition

Reliable text must be composed with deterministic geometry rather than generated as final pixels by an image model:

1. Use `twoStageComposition.backgroundInstruction` to generate or design the visual base without final text.
2. Use `overlayInstruction` to add original copy with HTML/CSS or a licensed font when `fontRequired` is true; use SVG outlines or hand lettering when it is false.
3. Apply the role's composition and treatment after typesetting.
4. Run every typography-specific and recipe-level verification check before delivery.

If the workflow cannot perform deterministic typesetting, disclose that text fidelity is approximate and do not claim an exact font match.
