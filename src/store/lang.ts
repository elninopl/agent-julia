// Per-page language auto-detection (metadata). Uses franc (pure JS, no native
// deps). Detected language is stored in a page's frontmatter as `lang`, enabling
// per-language features later and showing at a glance what a note is written in.
import { franc } from "franc-min";

// ISO 639-3 (what franc returns) -> friendly 639-1 codes for the languages we
// care about. Unknown codes fall through to the 3-letter code.
const ISO3_TO_ISO1: Record<string, string> = {
  eng: "en", cmn: "zh", spa: "es", hin: "hi", arb: "ar", ara: "ar",
  por: "pt", rus: "ru", jpn: "ja", deu: "de", fra: "fr", kor: "ko",
  ita: "it", tur: "tr", vie: "vi", pol: "pl", nld: "nl", ind: "id",
  ukr: "uk", tha: "th", ces: "cs",
};

// Returns a short language code, or undefined when the text is too short or the
// language can't be determined confidently.
export function detectLanguage(text: string): string | undefined {
  const sample = text.trim();
  if (sample.length < 24) return undefined; // too little signal to trust
  const code = franc(sample, { minLength: 24 });
  if (!code || code === "und") return undefined;
  return ISO3_TO_ISO1[code] ?? code;
}
