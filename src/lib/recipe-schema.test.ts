import assert from "node:assert/strict";
import test from "node:test";
import { isCurrentRecipe, parseValidRecipe, recipeValidationErrors } from "./recipe-schema";

function validRecipe() {
  return {
    metadata: { title: "Quiet geometry", category: "Editorial", retrievalTags: ["quiet geometry"] },
    retrievalProfile: { description: "Use for restrained geometric editorial compositions.", triggerTerms: ["geometric editorial cover"], excludeWhen: ["photorealistic portrait"] },
    visualDefinition: "A restrained composition organized by geometric balance.",
    coreVisualRelationships: ["Small subject against open field", "Muted ground with one accent", "Asymmetric but stable alignment"],
    coreInvariants: ["Preserve generous negative space"],
    reuseFormula: "Combine one small anchor, an open field, and a restrained accent.",
    typographyAndGraphicLanguage: {
      presence: "none", constructionMode: "none", baseSkeleton: "Not applicable", letterConstructionRules: [], characterSpecificRedesigns: [], recommendedProductionMethod: "none", fontRequired: false, roles: [], pairingStrategy: "No typography", graphicDevices: [],
      substitutionGuidance: { preserve: [], avoid: [], candidateDirections: [] },
      twoStageComposition: { backgroundInstruction: "Generate the image without text.", overlayInstruction: "Do not add text." },
      verificationChecks: ["Confirm that no text is present"], confidence: "high"
    }
  };
}

test("accepts a current recipe", () => {
  const recipe = validRecipe();
  assert.equal(isCurrentRecipe(recipe), true);
  assert.deepEqual(parseValidRecipe(JSON.stringify(recipe)), recipe);
});

test("reports actionable recipe and typography paths", () => {
  const recipe = validRecipe();
  recipe.coreVisualRelationships = ["Only one relationship"];
  recipe.typographyAndGraphicLanguage.presence = "supporting";
  const errors = recipeValidationErrors(recipe);
  assert.ok(errors.includes("coreVisualRelationships must contain at least 3 non-empty strings"));
  assert.ok(errors.includes("typographyAndGraphicLanguage.roles must contain at least one role when typography is present"));
  assert.ok(errors.includes("typographyAndGraphicLanguage.substitutionGuidance.candidateDirections must contain 2 to 4 items when typography is present"));
  assert.throws(() => parseValidRecipe(JSON.stringify(recipe)), /coreVisualRelationships.*typographyAndGraphicLanguage\.roles/);
});

test("reports contradictory lettering requirements", () => {
  const recipe = validRecipe();
  recipe.typographyAndGraphicLanguage.presence = "dominant";
  recipe.typographyAndGraphicLanguage.constructionMode = "custom-lettering";
  recipe.typographyAndGraphicLanguage.recommendedProductionMethod = "svg-outline";
  recipe.typographyAndGraphicLanguage.fontRequired = true;
  const errors = recipeValidationErrors(recipe);
  assert.ok(errors.includes("typographyAndGraphicLanguage.fontRequired must be false for custom-lettering"));
});

test("normalizes an incomplete no-typography response for text-free photos", () => {
  const recipe = validRecipe();
  recipe.typographyAndGraphicLanguage = { presence: "none" } as typeof recipe.typographyAndGraphicLanguage;
  const parsed = parseValidRecipe(JSON.stringify(recipe));
  const typography = parsed.typographyAndGraphicLanguage as Record<string, unknown>;
  assert.equal(typography.constructionMode, "none");
  assert.equal(typography.recommendedProductionMethod, "none");
  assert.equal(typography.fontRequired, false);
  assert.deepEqual(typography.roles, []);
  assert.deepEqual((typography.substitutionGuidance as Record<string, unknown>).candidateDirections, []);
  assert.deepEqual(typography.verificationChecks, ["Confirm that the final composition contains no typography."]);
});
