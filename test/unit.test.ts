import { describe, expect, it } from "vitest";
import { clampToBudget, estimateTokens } from "../src/util/tokens.js";
import { pageFilePath, pageId } from "../src/store/paths.js";
import { extractLinks, todayISO } from "../src/store/markdown.js";
import { presetSample } from "../src/persona/presets.js";
import { ConfigSchema, CURRENT_SCHEMA_VERSION } from "../src/config/schema.js";

describe("tokens", () => {
  it("estimates and clamps to budget on a paragraph boundary", () => {
    expect(estimateTokens("")).toBe(0);
    const long = "a".repeat(400) + "\n\n" + "b".repeat(400);
    const clamped = clampToBudget(long, 60); // ~240 chars
    expect(estimateTokens(clamped)).toBeLessThanOrEqual(60);
  });
});

describe("page id resolution", () => {
  it("normalizes ids regardless of prefix/extension", () => {
    expect(pageId("pages/elnino.md")).toBe("elnino");
    expect(pageId("archive/old")).toBe("old");
    expect(pageFilePath("/root", "elnino")).toBe("/root/pages/elnino.md");
  });
});

describe("markdown helpers", () => {
  it("extracts wiki links", () => {
    expect(extractLinks("see [[elnino]] and [[Prive-Game|Privé]]")).toEqual(["elnino", "prive-game"]);
  });
  it("produces ISO dates", () => {
    expect(todayISO(new Date("2026-06-21T10:00:00Z"))).toBe("2026-06-21");
  });
});

describe("persona presets", () => {
  it("renders the same utterance per language with EN fallback", () => {
    expect(presetSample("minimalist-engineer", "pl")).toContain("try/catch");
    expect(presetSample("minimalist-engineer", "xx")).toContain("try/catch"); // fallback to EN
  });
});

describe("config schema", () => {
  it("applies defaults around a required memoryDir", () => {
    const cfg = ConfigSchema.parse({ memoryDir: "/tmp/mem" });
    expect(cfg.name).toBe("Julia");
    expect(cfg.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(cfg.search).toBe("hybrid");
    expect(cfg.privacyHardOff.length).toBeGreaterThan(0);
  });
});
