// Preload (node --import) that resolves @huggingface/transformers to the fake.
// Inherited by the embedding child through execArgv, like any other node flag.
import { registerHooks } from "node:module";

const fake = new URL("./fake-transformers.mjs", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@huggingface/transformers") return { url: fake, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
