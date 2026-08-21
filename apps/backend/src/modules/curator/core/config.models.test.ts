import { describe, expect, it } from "vitest";
import { CLOUD_COLLECTION_MODEL, CLOUD_TAGGING_MODEL } from "./config.js";

/**
 * Regression guard for a real outage: a rename once rewrote both cloud model
 * defaults to `llmClient-haiku-...` / `llmClient-sonnet-...`. Anthropic rejects
 * unknown model IDs with a non-retryable 404, so cloud tagging and collection
 * generation failed silently for every user with an API key configured while
 * typecheck, lint, and the whole test suite stayed green.
 */
describe("cloud model defaults", () => {
  const defaults = [
    ["tagging", CLOUD_TAGGING_MODEL],
    ["collection", CLOUD_COLLECTION_MODEL],
  ] as const;

  it.each(defaults)("%s model is a claude-* model id", (_label, model) => {
    expect(model).toMatch(/^claude-/);
  });

  it.each(defaults)("%s model carries no internal identifier", (_label, model) => {
    expect(model).not.toMatch(/llmClient|client|undefined/i);
  });

  it("uses distinct models so the cost split is preserved", () => {
    expect(CLOUD_TAGGING_MODEL).not.toBe(CLOUD_COLLECTION_MODEL);
  });
});
