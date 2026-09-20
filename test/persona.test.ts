import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { composeCore } from "../src/persona/compose.js";
import { storePaths } from "../src/store/paths.js";
import { ConfigSchema } from "../src/config/schema.js";
import { clampToBudget, estimateTokens } from "../src/util/tokens.js";

// A store with a custom voice and N corrections of roughly `len` characters each.
function store(opts: { corrections?: number; correctionLen?: number; voice?: string }) {
  const dir = mkdtempSync(join(tmpdir(), "aj-persona-"));
  const paths = storePaths(dir);
  writeFileSync(
    paths.personaFile,
    opts.voice ?? "- Speak plainly.\n- Use the user's first language.\n- Never sign off.",
    "utf8",
  );
  const n = opts.corrections ?? 0;
  if (n > 0) {
    const len = opts.correctionLen ?? 300;
    const lines = Array.from(
      { length: n },
      (_, i) => `- 2026-0${(i % 9) + 1}-01 — Correction number ${i}: ${"rule ".repeat(Math.ceil(len / 5))}`,
    );
    writeFileSync(paths.voiceCorrections, `# Voice corrections\n\n${lines.join("\n")}\n`, "utf8");
  }
  return paths;
}

function config(contextBudget: number) {
  return ConfigSchema.parse({ memoryDir: "/unused", stylePreset: "custom", contextBudget });
}

describe("clampToBudget", () => {
  it("never leaves a half-written word", () => {
    const text = "antidisestablishmentarianism ".repeat(40);
    const clamped = clampToBudget(text, 20);
    expect(clamped.length).toBeGreaterThan(0);
    expect(text.startsWith(clamped)).toBe(true);
    // Whatever survived ends on a word the source also ends a word on.
    for (const word of clamped.split(/\s+/)) {
      expect(word).toBe("antidisestablishmentarianism");
    }
  });

  it("prefers a paragraph boundary, then a line boundary", () => {
    const paragraphs = `${"a".repeat(400)}\n\n${"b".repeat(400)}`;
    expect(clampToBudget(paragraphs, 120)).toBe("a".repeat(400));

    const lines = `${"a".repeat(400)}\n${"b".repeat(400)}`;
    expect(clampToBudget(lines, 120)).toBe("a".repeat(400));
  });

  it("keeps a single unbroken token rather than returning nothing", () => {
    const oneWord = "x".repeat(400);
    expect(clampToBudget(oneWord, 10)).toBe("x".repeat(40));
  });

  it("returns short text untouched", () => {
    expect(clampToBudget("short enough", 100)).toBe("short enough");
  });
});

describe("composeCore budget allocation", () => {
  it("keeps the style voice even when corrections would fill the whole budget", async () => {
    // The regression: corrections were sized against the full budget, so the body
    // collapsed to its floor and "## Your voice" never reached context at all.
    const paths = store({ corrections: 12, correctionLen: 400 });
    const core = await composeCore(paths, config(1200));
    expect(core.text).toContain("## Your voice");
    expect(core.text).toContain("Speak plainly");
  });

  it("drops the oldest corrections instead of the voice, and says how many", async () => {
    const paths = store({ corrections: 12, correctionLen: 400 });
    const core = await composeCore(paths, config(1200));
    expect(core.droppedCorrections).toBeGreaterThan(0);
    expect(core.text).toContain(`(+${core.droppedCorrections} older correction(s)`);
    // Newest survive: the last correction is kept, the first is not.
    expect(core.text).toContain("Correction number 11");
    expect(core.text).not.toContain("Correction number 0:");
  });

  it("reports nothing lost when the budget is generous", async () => {
    const paths = store({ corrections: 3, correctionLen: 120 });
    const core = await composeCore(paths, config(4000));
    expect(core.truncated).toBe(false);
    expect(core.droppedCorrections).toBe(0);
    expect(core.text).toContain("## Your voice");
    expect(core.text).toContain("## Never store");
  });

  it("reports truncation honestly when the budget cannot hold the voice", async () => {
    const paths = store({ voice: "- Be terse.\n".repeat(200) });
    const core = await composeCore(paths, config(300));
    expect(core.truncated).toBe(true);
  });

  it("always keeps the privacy rail and the identity line", async () => {
    const paths = store({ corrections: 20, correctionLen: 500 });
    const core = await composeCore(paths, config(600));
    expect(core.text).toContain("## Never store");
    expect(core.text).toContain("You are ");
  });

  it("stays within a small multiple of the budget it was given", async () => {
    const paths = store({ corrections: 12, correctionLen: 400 });
    const core = await composeCore(paths, config(1200));
    expect(estimateTokens(core.text)).toBeLessThanOrEqual(1200 * 1.2);
  });
});

describe("composeCore priority: our text yields, the user's does not", () => {
  // The realistic shape the first attempt at this fix still got wrong: a real
  // custom voice and a year of real corrections, on the DEFAULT budget.
  const realVoice = [
    "- Mów po polsku, formy żeńskie w pierwszej osobie.",
    "- Ton bezpośredni, bez kurtuazji. Żadnych \"świetne pytanie\".",
    "- Pushback mocny: widzisz dziurę w pomyśle, mów wprost.",
    "- Decyzje: opcje, konsekwencje każdej, rekomendacja z uzasadnieniem.",
    "- Niepewność jawna. Nie hedge, gdy masz zdanie.",
    "- Bloki kodu zawsze z jawnym językiem.",
  ].join("\n");
  const realCorrection = (i: number) =>
    `- 2026-0${(i % 9) + 1}-01 — Correction ${i}: never use that phrasing in Polish copy, ` +
    "it reads like a calque and the reader stumbles on it; write the plain form instead. ".repeat(3);

  function realStore(n: number) {
    const dir = mkdtempSync(join(tmpdir(), "aj-real-"));
    const paths = storePaths(dir);
    writeFileSync(paths.personaFile, realVoice, "utf8");
    writeFileSync(
      paths.voiceCorrections,
      `# Voice corrections\n\n${Array.from({ length: n }, (_, i) => realCorrection(i)).join("\n")}\n`,
      "utf8",
    );
    return paths;
  }

  it("keeps the user's own voice at the default budget, with real corrections", async () => {
    const core = await composeCore(realStore(13), config(1200));
    expect(core.text).toContain("## Your voice");
    expect(core.text).toContain("Pushback mocny");
    expect(core.text).toContain("Bloki kodu zawsze z jawnym językiem");
  });

  it("shrinks the shipped universal rules rather than the voice", async () => {
    const paths = realStore(13);
    const tight = await composeCore(paths, config(1200));
    const roomy = await composeCore(paths, config(6000));

    // The shipped core voice contains its own `##` headings, so slice between the
    // known top-level section markers rather than on the next `##`.
    const section = (text: string, from: string, to: string) => {
      const a = text.indexOf(from);
      if (a < 0) return "";
      const b = text.indexOf(to, a + from.length);
      return text.slice(a, b < 0 ? undefined : b);
    };

    // Ours is cut...
    expect(section(tight.text, "## How you communicate", "## Your voice").length).toBeLessThan(
      section(roomy.text, "## How you communicate", "## Your voice").length,
    );
    // ...theirs is not.
    expect(section(tight.text, "## Your voice", "## Corrections from")).toBe(
      section(roomy.text, "## Your voice", "## Corrections from"),
    );
    expect(tight.truncated).toBe(true);
  });

  it("does not regress a plain default install: preset voice, few corrections", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aj-plain-"));
    const paths = storePaths(dir);
    writeFileSync(
      paths.voiceCorrections,
      "# Voice corrections\n\n- 2026-01-01 — Stop opening with my name.\n- 2026-02-01 — Reply in Polish.\n",
      "utf8",
    );
    const cfg = ConfigSchema.parse({ memoryDir: dir, contextBudget: 1200 }); // shipped preset
    const core = await composeCore(paths, cfg);
    expect(core.truncated).toBe(false);
    expect(core.droppedCorrections).toBe(0);
    expect(core.text).toContain("## Your voice");
    expect(core.text).toContain("Stop opening with my name");
  });

  it("works with no persona.md and no corrections at all", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aj-bare-"));
    const core = await composeCore(storePaths(dir), config(1200));
    expect(core.droppedCorrections).toBe(0);
    expect(core.text).toContain("## Your voice");
    expect(core.text).toContain("## Never store");
    expect(core.text).not.toContain("Corrections from the user");
  });
});
