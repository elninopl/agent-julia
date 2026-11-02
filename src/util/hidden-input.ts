// One line from stdin with nothing echoed: raw mode on a terminal, the first
// line of whatever is piped in otherwise. Typed-ahead input after the line
// is pushed back for the next reader.
export async function readHidden(): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of input) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0] ?? "";
  }
  input.setRawMode(true);
  input.setEncoding("utf8");
  input.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const done = (err: Error | null, rest = "") => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      if (rest) input.unshift(rest, "utf8");
      process.stderr.write("\n");
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (let i = 0; i < chunk.length; i++) {
        const ch = chunk[i]!;
        if (ch === "\r" || ch === "\n") {
          const skip = ch === "\r" && chunk[i + 1] === "\n" ? 2 : 1;
          return done(null, chunk.slice(i + skip));
        }
        if (ch === "\u0003") return done(new Error("cancelled"));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    input.on("data", onData);
  });
}
