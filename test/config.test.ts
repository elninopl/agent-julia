import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configBackups, configPath, loadConfig, saveConfig } from "../src/config/config.js";
import { ConfigSchema } from "../src/config/schema.js";

const original = process.env.AGENT_JULIA_CONFIG;
afterEach(() => {
  process.env.AGENT_JULIA_CONFIG = original;
});

function pointAtTemp(): string {
  const path = join(mkdtempSync(join(tmpdir(), "aj-cfg-")), "config.json");
  process.env.AGENT_JULIA_CONFIG = path;
  return path;
}

describe("the config is the one file that cannot be lost", () => {
  it("keeps the previous version every time it is written", async () => {
    const path = pointAtTemp();
    await saveConfig(ConfigSchema.parse({ memoryDir: "/one", name: "First" }));
    await saveConfig(ConfigSchema.parse({ memoryDir: "/two", name: "Second" }));
    await saveConfig(ConfigSchema.parse({ memoryDir: "/three", name: "Third" }));

    expect(JSON.parse(readFileSync(path, "utf8")).name).toBe("Third");
    const backups = configBackups();
    expect(backups.length).toBe(2);
    expect(JSON.parse(readFileSync(backups[0]!, "utf8")).name).toBe("Second");
    expect(JSON.parse(readFileSync(backups[1]!, "utf8")).name).toBe("First");
  });

  it("leaves no partial file behind and stays readable after a write", async () => {
    const path = pointAtTemp();
    await saveConfig(ConfigSchema.parse({ memoryDir: "/one", name: "Julia" }));
    expect((await loadConfig()).name).toBe("Julia");
    expect(existsSync(`${path}.${process.pid}.tmp`)).toBe(false);
  });

  it("refuses to write the user's real config from a test run", async () => {
    // The failure this guards: a scratch script imports saveConfig, forgets to
    // pin AGENT_JULIA_CONFIG, and repoints a real person's memory at a temp
    // directory that is about to be deleted.
    process.env.AGENT_JULIA_CONFIG = join(homedir(), ".config", "agent-julia", "config.json");
    const before = existsSync(configPath()) ? readFileSync(configPath(), "utf8") : null;
    await expect(saveConfig(ConfigSchema.parse({ memoryDir: "/hijacked" }))).rejects.toThrow(
      /refusing to write the real config/i,
    );
    if (before !== null) expect(readFileSync(configPath(), "utf8")).toBe(before);
  });
});
