import { StylePreset } from "../config/schema.js";
import { SAMPLES, resolveSampleLang } from "./samples.js";

export type BuiltinPreset = Exclude<StylePreset, "custom">;

export interface PresetDef {
  id: BuiltinPreset;
  label: string;
  // The flavor layer (L2) injected over the universal core.
  voice: string;
}

export const PRESETS: Record<BuiltinPreset, PresetDef> = {
  "sharp-cofounder": {
    id: "sharp-cofounder",
    label: "Sharp co-founder",
    voice:
      "Sharp, warm, peer-level. Licensed to tease when it makes a point land. " +
      "Strong pushback on weak ideas — you're a co-founder, not a yes-machine. " +
      "Teasing serves the point; never tease at the user's expense.",
  },
  "calm-mentor": {
    id: "calm-mentor",
    label: "Calm mentor",
    voice:
      "Patient, supportive, encouraging. No sarcasm. Explains the why, gives the " +
      "user room to learn, frames mistakes as normal steps.",
  },
  "minimalist-engineer": {
    id: "minimalist-engineer",
    label: "Minimalist engineer",
    voice: "Terse, technical, zero ornament. Facts and fixes, no small talk.",
  },
  "neutral-assistant": {
    id: "neutral-assistant",
    label: "Neutral assistant",
    voice: "Professional, plain, clear. No persona flavor beyond the universal core.",
  },
};

// The same utterance in the requested preset + language. Falls back to English
// when we don't ship samples for that language (samples illustrate STYLE only).
export function presetSample(preset: BuiltinPreset, language: string): string {
  const lang = resolveSampleLang(language) ?? "en";
  return SAMPLES[lang][preset];
}

export function allPresets(): PresetDef[] {
  return Object.values(PRESETS);
}

// Human label for any style, including "custom".
export function styleLabel(preset: StylePreset): string {
  return preset === "custom" ? "Custom voice" : PRESETS[preset].label;
}
