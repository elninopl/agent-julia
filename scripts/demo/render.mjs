#!/usr/bin/env node
// Renders demo.html into demo.gif: each frame in headless Chrome over the
// DevTools protocol, then one ffmpeg pass. Needs Google Chrome and ffmpeg,
// no npm packages.
//
//   node scripts/demo/render.mjs                  writes scripts/demo/demo.gif
//   node scripts/demo/render.mjs --stills 2000,9000   PNGs of those moments (ms), in a temp dir
//
// $CHROME overrides where Chrome is.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FPS = 20;
const WIDTH = 960, HEIGHT = 540, GIF_WIDTH = 880;
const flag = process.argv.indexOf("--stills");
const stills = flag > 0 ? (process.argv[flag + 1] ?? "").split(",").map(Number) : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "aj-demo-chrome-"));
const frames = mkdtempSync(join(tmpdir(), "aj-demo-frames-"));
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
  "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });

try {
  const portFile = join(profile, "DevToolsActivePort");
  for (let i = 0; !(existsSync(portFile) && readFileSync(portFile, "utf8").includes("\n")); i++) {
    if (i > 150) throw new Error(`Chrome did not start (${CHROME})`);
    await sleep(100);
  }
  const port = readFileSync(portFile, "utf8").split("\n")[0];
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let next = 0;
  const waiting = new Map();
  const events = new Map();
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.id && waiting.has(msg.id)) {
      const { resolve, reject } = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method && events.has(msg.method)) {
      events.get(msg.method)();
      events.delete(msg.method);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next;
    waiting.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const once = (method) => new Promise((resolve) => events.set(method, resolve));
  const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result.value;

  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: false });
  const loaded = once("Page.loadEventFired");
  await send("Page.navigate", { url: pathToFileURL(join(here, "demo.html")).href });
  await loaded;
  await evaluate("document.fonts.ready.then(() => true)");
  const total = await evaluate("window.TOTAL");

  const times = stills ?? Array.from({ length: Math.round((total / 1000) * FPS) }, (_, i) => (i * 1000) / FPS);
  for (const [n, t] of times.entries()) {
    await evaluate(`window.render(${t}), true`);
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    const name = join(frames, stills ? `still-${t}.png` : `f${String(n).padStart(4, "0")}.png`);
    writeFileSync(name, Buffer.from(data, "base64"));
  }
  ws.close();

  if (stills) {
    console.log(`${times.length} still(s) in ${frames}`);
  } else {
    const out = join(here, "demo.gif");
    const ff = spawnSync("ffmpeg", ["-loglevel", "error", "-y", "-framerate", String(FPS), "-i", join(frames, "f%04d.png"),
      "-filter_complex", `scale=${GIF_WIDTH}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=sierra2_4a`,
      "-loop", "0", out], { stdio: "inherit" });
    if (ff.status !== 0) throw new Error("ffmpeg failed");
    console.log(`${times.length} frames → ${out}`);
  }
} finally {
  chrome.kill();
  await sleep(200);
  rmSync(profile, { recursive: true, force: true });
  if (!stills) rmSync(frames, { recursive: true, force: true });
}
