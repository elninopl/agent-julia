import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate config writes during tests. migrate() persists the config via
// saveConfig(), which resolves to the user's real ~/.config path unless
// AGENT_JULIA_CONFIG points elsewhere — so without this, running the suite would
// overwrite a developer's actual agent-julia config. Pin it to a throwaway file.
process.env.AGENT_JULIA_CONFIG = join(mkdtempSync(join(tmpdir(), "aj-cfg-")), "config.json");
