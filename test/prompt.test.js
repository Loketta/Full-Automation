import test from "node:test";
import assert from "node:assert/strict";
import { buildInstrumentalPrompt, validatePrompt, ValidationError } from "../src/prompt.js";

test("validates and trims a useful prompt", () => {
  assert.equal(validatePrompt("  dark cyberpunk instrumental  "), "dark cyberpunk instrumental");
});

test("rejects missing, short, and oversized prompts", () => {
  assert.throws(() => validatePrompt(), ValidationError);
  assert.throws(() => validatePrompt("short"), /at least 10/);
  assert.throws(() => validatePrompt("x".repeat(2001)), /2000 characters or fewer/);
});

test("forces an instrumental-only instruction", () => {
  assert.match(buildInstrumentalPrompt("Dark synthwave"), /Instrumental only\. No vocals/);
});
