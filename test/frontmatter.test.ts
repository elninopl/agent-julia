import { describe, expect, it } from "vitest";
import { parseFrontmatter, stringifyFrontmatter } from "../src/store/frontmatter.js";

describe("front matter", () => {
  it("splits a document into its front matter and its body", () => {
    const { data, content } = parseFrontmatter("---\ntitle: Privé\ntags:\n  - game\n---\n\nbody here\n");
    expect(data).toEqual({ title: "Privé", tags: ["game"] });
    expect(content.trim()).toBe("body here");
  });

  it("treats a document without front matter as all body", () => {
    const { data, content } = parseFrontmatter("just a body\n");
    expect(data).toEqual({});
    expect(content).toBe("just a body\n");
  });

  it("refuses front matter written in a scripting language", () => {
    // gray-matter, which this replaced, would have run it through eval().
    expect(() => parseFrontmatter('---js\n{ title: "x" }\n---\n\nbody\n')).toThrow(/not supported/i);
    expect(() => parseFrontmatter("---toml\ntitle = 'x'\n---\n\nbody\n")).toThrow(/not supported/i);
  });

  it("refuses front matter that is not a mapping, or not YAML at all", () => {
    expect(() => parseFrontmatter("---\n- one\n- two\n---\n\nbody\n")).toThrow(/mapping/i);
    expect(() => parseFrontmatter("---\ntitle: [unclosed\n---\n\nbody\n")).toThrow(/not valid YAML/i);
  });

  it("leaves an unterminated delimiter alone instead of guessing", () => {
    const raw = "---\ntitle: x\n\nbody with no closing delimiter\n";
    expect(parseFrontmatter(raw)).toEqual({ data: {}, content: raw });
  });

  it("round-trips, and drops keys with no value", () => {
    const doc = stringifyFrontmatter("\nbody\n", { title: "x", status: "active", missing: undefined });
    expect(doc).toBe("---\ntitle: x\nstatus: active\n---\n\nbody\n");
    expect(parseFrontmatter(doc).data).toEqual({ title: "x", status: "active" });
  });

  it("handles CRLF and a byte order mark", () => {
    expect(parseFrontmatter("﻿---\r\ntitle: x\r\n---\r\n\r\nbody\r\n").data).toEqual({ title: "x" });
  });

  it("keeps a long value on one line", () => {
    const long = "a ".repeat(120).trim();
    expect(stringifyFrontmatter("\nb\n", { title: long })).toContain(long);
  });
});
