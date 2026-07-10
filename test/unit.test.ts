import { describe, expect, it } from "vitest";
import { clampToBudget, estimateTokens } from "../src/util/tokens.js";
import { pageFilePath, pageId } from "../src/store/paths.js";
import { extractLinks, todayISO } from "../src/store/markdown.js";
import { presetSample } from "../src/persona/presets.js";
import { ConfigSchema, CURRENT_SCHEMA_VERSION } from "../src/config/schema.js";
import { detectLanguage } from "../src/store/lang.js";
import { recommendLocalTier } from "../src/index/embeddings.js";

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

describe("language detection", () => {
  it("detects common languages and returns undefined for thin input", () => {
    expect(detectLanguage("This is a reasonably long english sentence about software.")).toBe("en");
    expect(detectLanguage("To jest dłuższe zdanie po polsku o oprogramowaniu i pamięci.")).toBe("pl");
    expect(detectLanguage("hi")).toBeUndefined();
  });
});

describe("local model tier recommendation", () => {
  it("considers both RAM and CPU cores, staying conservative", () => {
    expect(recommendLocalTier(4, 8)).toBe("small"); // low RAM
    expect(recommendLocalTier(32, 2)).toBe("small"); // too few cores
    expect(recommendLocalTier(16, 8)).toBe("base"); // ample both
    expect(recommendLocalTier(16, 4)).toBe("small"); // cores below bar
    expect(recommendLocalTier(64, 16)).toBe("base");
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

describe("page id is a security boundary", () => {
  it("cannot traverse out of pages/", () => {
    expect(pageId("../../../etc/passwd")).toBe("etc-passwd");
    expect(pageId("..\\..\\windows")).toBe("windows");
    expect(pageId("/absolute/path")).toBe("absolute-path");
    expect(pageId("nested/sub/dir")).toBe("nested-sub-dir");
    expect(pageFilePath("/store", "../../escape")).toBe("/store/pages/escape.md");
    expect(pageId("")).toBe("untitled");
    expect(pageId("..")).toBe("untitled");
  });

  it("keeps ordinary ids unchanged", () => {
    expect(pageId("prive-game")).toBe("prive-game");
    expect(pageId("v2.plan_notes")).toBe("v2.plan_notes");
  });
});
