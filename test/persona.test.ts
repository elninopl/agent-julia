import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { composeCore } from "../src/persona/compose.js";
import { pasteBody, pasteHash } from "../src/persona/paste.js";
import { coreHashOf, fingerprintLine, serverInstructions } from "../src/persona/startup.js";
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

describe("the pasted layer carries nothing that changes often", () => {
  const cfg = () =>
    ConfigSchema.parse({
      memoryDir: "/unused",
      name: "Julia",
      pronouns: "she/her",
      language: "pl",
      privacyHardOff: ["passwords, API keys", "card numbers", "third-party private data"],
    });

  it("contains no line from the voice, the corrections or the shipped rules", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aj-paste-"));
    const paths = storePaths(dir);
    writeFileSync(paths.personaFile, "- Zawsze mów do mnie per elniño.\n", "utf8");
    writeFileSync(paths.voiceCorrections, "# Voice corrections\n\n- 2026-01-01 — Never use the word moat.\n", "utf8");

    const body = await pasteBody(cfg());
    expect(body).not.toContain("elniño");
    expect(body).not.toContain("moat");
    // core-voice.md's own wording must not leak in either.
    const core = await readFile(join("src", "persona", "assets", "core-voice.md"), "utf8");
    const distinctive = core.split("\n").filter((l) => l.startsWith("- ") && l.length > 60);
    for (const line of distinctive) expect(body).not.toContain(line.trim());
  });

  it("carries the identity, the language and every privacy entry", async () => {
    const c = cfg();
    const body = await pasteBody(c);
    expect(body).toContain("Julia");
    expect(body).toContain("she/her");
    expect(body).toContain("Respond in pl");
    for (const p of c.privacyHardOff) expect(body).toContain(p);
  });

  it("is stable for the same config and changes when the config does", async () => {
    const a = await pasteBody(cfg());
    expect(await pasteBody(cfg())).toBe(a);
    const b = await pasteBody(ConfigSchema.parse({ memoryDir: "/unused", name: "Ada", language: "en" }));
    expect(pasteHash(b)).not.toBe(pasteHash(a));
  });

  it("tells the agent what to do when the tools are not there", async () => {
    const body = await pasteBody(cfg());
    expect(body).toMatch(/get_core/);
    expect(body).toMatch(/not there|not available/i);
  });
});

describe("what every client is told on connect", () => {
  it("fits the budget and leads with identity and the privacy rail", () => {
    const text = serverInstructions(
      ConfigSchema.parse({ memoryDir: "/unused", name: "Julia", language: "pl" }),
    );
    expect(text.length).toBeLessThanOrEqual(1800);
    expect(text.indexOf("You are Julia")).toBeLessThan(text.indexOf("Voice:"));
    expect(text).toContain("get_core");
    expect(text).toContain("never store");
  });

  it("stays inside the budget by trimming what overflows, not what is already bounded", () => {
    // The overflow is always the privacy list, so that is what gets trimmed —
    // entry by entry, with a count of what was left out. Dropping it whole would
    // leave a client with no idea what it must not keep, which is the one thing
    // in here that exists for safety rather than for tone.
    const privacyHardOff = Array.from(
      { length: 12 },
      (_, i) => `a very long category of secret number ${i} `.repeat(3).trim(),
    );
    const text = serverInstructions(
      ConfigSchema.parse({ memoryDir: "/unused", name: "X".repeat(40), language: "pl", privacyHardOff }),
    );
    expect(text.length).toBeLessThanOrEqual(1800);
    expect(text).toContain("X".repeat(40));
    expect(text).toContain("You never store");
    expect(text).toContain(privacyHardOff[0]!);
    expect(text).toMatch(/more categories on this user's never-store list/);
    expect(text).toContain("get_core");
  });

  it("drops the memory paragraph before it touches identity or privacy", () => {
    // Sized so the whole thing overflows but identity plus voice still fits:
    // that is the rung where the memory paragraph is the right thing to lose.
    const privacyHardOff = Array.from({ length: 12 }, (_, i) => `secret category number ${i} `.repeat(4).trim());
    const text = serverInstructions(ConfigSchema.parse({ memoryDir: "/unused", privacyHardOff }));
    expect(text.length).toBeLessThanOrEqual(1800);
    for (const p of privacyHardOff) expect(text).toContain(p);
    expect(text).not.toContain("Memory: `search`");
  });

  it("keeps a never-store instruction even when no single entry fits", () => {
    // One oversized entry used to empty the list and leave a trailing clause
    // with no subject, so the rail disappeared entirely.
    const text = serverInstructions(
      ConfigSchema.parse({ memoryDir: "/unused", privacyHardOff: ["x".repeat(3000)] }),
    );
    expect(text.length).toBeLessThanOrEqual(1800);
    expect(text).toMatch(/You never store/);
    expect(text).toContain("do not keep it");
  });

  it("keeps the shorter entries that follow an oversized one", () => {
    const text = serverInstructions(
      ConfigSchema.parse({
        memoryDir: "/unused",
        privacyHardOff: ["x".repeat(3000), "passwords and API keys", "card numbers"],
      }),
    );
    expect(text).toContain("passwords and API keys");
    expect(text).toContain("card numbers");
  });

  it("says nothing about storing when there is nothing on the list", () => {
    const text = serverInstructions(ConfigSchema.parse({ memoryDir: "/unused", privacyHardOff: [] }));
    expect(text).not.toContain("You never store .");
    expect(text).not.toMatch(/never store\s*\./);
  });

  it("is pure — the same config gives the same text and it reads no disk", () => {
    const cfg = ConfigSchema.parse({ memoryDir: "/does/not/exist", name: "Ada" });
    expect(serverInstructions(cfg)).toBe(serverInstructions(cfg));
  });
});

describe("the core fingerprint", () => {
  it("lets a surface that already has the block confirm it instead of re-reading", async () => {
    const paths = store({ corrections: 2 });
    const core = await composeCore(paths, config(3000));
    const line = fingerprintLine(core.text);
    const hash = coreHashOf(core.text).slice(0, 8);
    expect(line).toContain(hash);
    expect(line).toContain('since: "' + hash + '"');
    // It changes when the voice changes, which is the whole point.
    const other = await composeCore(store({ corrections: 5 }), config(3000));
    expect(coreHashOf(other.text)).not.toBe(coreHashOf(core.text));
  });
});
