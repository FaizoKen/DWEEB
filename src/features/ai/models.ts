/**
 * Curated local-model catalog for the in-browser assistant.
 *
 * Every id here is a prebuilt WebLLM model that runs fully on-device via
 * WebGPU. The first time a model is selected its weights download from the
 * MLC CDN and are cached in the browser (Cache Storage); every run after that
 * — including with no network at all — loads straight from that cache.
 *
 * The list is intentionally small and skewed toward instruction-following
 * models that are good at emitting structured JSON, since the assistant's
 * whole job is to produce a valid Components V2 payload. Sizes are the
 * approximate VRAM/disk footprint reported by WebLLM's prebuilt config.
 */

export interface LocalModel {
  /** WebLLM prebuilt `model_id`. */
  id: string;
  /** Short display name. */
  label: string;
  /** Approximate download / VRAM size, human-readable. */
  size: string;
  /** One-line positioning shown in the picker. */
  blurb: string;
}

export const LOCAL_MODELS: LocalModel[] = [
  {
    id: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
    label: "Llama 3.2 1B",
    size: "~0.9 GB",
    blurb: "Fastest. Lightest download — good on low-end GPUs.",
  },
  {
    id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
    label: "Qwen2.5 1.5B",
    size: "~1.6 GB",
    blurb: "Balanced default — strong at structured JSON for its size.",
  },
  {
    id: "Llama-3.2-3B-Instruct-q4f16_1-MLC",
    label: "Llama 3.2 3B",
    size: "~2.3 GB",
    blurb: "Best instruction-following. Needs a capable GPU.",
  },
  {
    id: "Qwen2.5-3B-Instruct-q4f16_1-MLC",
    label: "Qwen2.5 3B",
    size: "~2.5 GB",
    blurb: "Highest quality JSON. Heaviest download.",
  },
];

export const DEFAULT_MODEL_ID = "Qwen2.5-1.5B-Instruct-q4f16_1-MLC";

const STORAGE_KEY = "dwb.ai.v1";

/** Remembered model choice, falling back to the default. Never throws. */
export function loadModelChoice(): string {
  try {
    if (typeof localStorage === "undefined") return DEFAULT_MODEL_ID;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw && LOCAL_MODELS.some((m) => m.id === raw)) return raw;
  } catch {
    /* ignore */
  }
  return DEFAULT_MODEL_ID;
}

/** Persist the model choice so it survives reloads. Never throws. */
export function saveModelChoice(id: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* ignore */
  }
}
