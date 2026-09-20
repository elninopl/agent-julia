import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectSources,
  loadRoutes,
  mergeSources,
  readProjects,
  normalizeDir,
  readSources,
  renderSources,
  routingNoteFor,
} from "../src/store/sources.js";
import { storePaths } from "../src/store/paths.js";
import { writePage } from "../src/store/markdown.js";

describe("declaring where the rest of a project's knowledge lives", () => {
  it("reads the object form and the one a person types by hand", () => {
    const fm = {
      project: "~/Sites/prive",
      sources: [
        { kind: "dir", at: "_doc", about: "product and technical docs" },
        { kind: "mcp", at: "acme", how: "docs_search, docs_read", about: "company docs" },
        "dir:_notes — scratch",
        "https://example.test/wiki — the old wiki",
      ],
    };
    expect(readProjects(fm)).toEqual(["~/Sites/prive"]);
    const sources = readSources(fm);
    expect(sources).toHaveLength(4);
    expect(sources[0]).toMatchObject({ kind: "dir", at: "_doc" });
    expect(sources[1]).toMatchObject({ kind: "mcp", how: "docs_search, docs_read" });
    // A string is not a second-class declaration: kind and note come out of it.
    expect(sources[2]).toMatchObject({ kind: "dir", at: "_notes", about: "scratch" });
    expect(sources[3]).toMatchObject({ kind: "url", at: "https://example.test/wiki" });
  });

  it("ignores a sources key that is not a list, instead of throwing", () => {
    expect(readSources({ sources: "some docs" })).toEqual([]);
    expect(readSources({})).toEqual([]);
  });

  it("names an MCP server as a place to call, not as a path", () => {
    const [line] = renderSources([{ kind: "mcp", at: "acme", how: "docs_search", about: "company docs" }]);
    expect(line).toContain("`acme` MCP server");
    expect(line).toContain("docs_search");
    expect(line).not.toContain("/");
  });

  it("resolves a relative path against the project it belongs to", () => {
    const [line] = renderSources([{ kind: "dir", at: "_doc" }], "/Users/me/Sites/prive");
    expect(line).toContain("/Users/me/Sites/prive/_doc");
  });
});

describe("finding the documentation a project keeps for itself", () => {
  it("counts what is there and leaves what is not", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aj-src-"));
    mkdirSync(join(dir, "_doc", "web"), { recursive: true });
    writeFileSync(join(dir, "_doc", "one.md"), "# one", "utf8");
    writeFileSync(join(dir, "_doc", "web", "two.md"), "# two", "utf8");
    writeFileSync(join(dir, "CLAUDE.md"), "# repo rules", "utf8");

    const found = await detectSources(dir);
    expect(found.map((s) => s.at).sort()).toEqual(["CLAUDE.md", "_doc"]);
    expect(found.find((s) => s.at === "_doc")!.about).toContain("2 markdown");
  });

  it("keeps a declaration when detection finds the same place", () => {
    const declared = [{ kind: "dir" as const, at: "_doc", about: "what the user said it is" }];
    const detected = [
      { kind: "dir" as const, at: "_doc", about: "587 markdown file(s)" },
      { kind: "file" as const, at: "CLAUDE.md" },
    ];
    const merged = mergeSources(declared, detected);
    expect(merged).toHaveLength(2);
    expect(merged[0]!.about).toBe("what the user said it is");
  });
});

describe("routing reaches whoever reads the page", () => {
  it("maps a working directory to the page that claims it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aj-routes-"));
    const paths = storePaths(dir);
    const project = join(dir, "repo");
    mkdirSync(project);
    await writePage(
      paths,
      "prive",
      ["---", `project: ${project}`, "sources:", "  - kind: dir", "    at: _doc", "---", "", "The page."].join("\n"),
      {},
    );
    await writePage(paths, "unrelated", "Nothing to route.", {});

    // Keyed by the resolved directory: /var and /private/var are the same place,
    // and so is a ~/Sites that turns out to be a symlink.
    const routes = await loadRoutes(paths);
    const key = await normalizeDir(project);
    expect(routes.get(key)?.page).toBe("prive");
    expect(routes.get(key)?.sources[0]).toMatchObject({ at: "_doc" });
  });

  it("says nothing extra about a page that holds everything it is about", async () => {
    expect(await routingNoteFor({ title: "Elniño" })).toBeNull();
  });

  it("tells a reader where to look and what not to copy", async () => {
    const note = await routingNoteFor({
      project: "/nowhere/prive",
      sources: [{ kind: "dir", at: "_doc", about: "product docs" }],
    });
    expect(note).toContain("/nowhere/prive/_doc");
    expect(note).toContain("product docs");
    expect(note).toContain("route to it");
  });
});
