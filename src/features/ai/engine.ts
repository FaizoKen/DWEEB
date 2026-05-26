/**
 * Local inference engine — a thin wrapper over WebLLM.
 *
 * Everything here is browser-only and runs on the user's GPU via WebGPU. The
 * heavy `@mlc-ai/web-llm` bundle is loaded with a dynamic `import()` so it
 * never lands in the main app chunk; it is only fetched the first time the
 * user actually loads a model.
 *
 * The live engine handle lives in module scope (it holds a GPU context and a
 * worker — not something we want in React state). The UI store talks to it
 * through these functions and re-renders off progress callbacks.
 *
 * Offline story: WebLLM caches model weights in the browser's Cache Storage
 * keyed by model id. After a model has been fetched once, `loadEngine` resolves
 * with zero network — which is the whole point of an on-device assistant.
 */

import type { ChatTurn } from "./prompt";

// Loaded lazily; typed loosely to avoid pinning to web-llm's internal types.
type WebLLMModule = typeof import("@mlc-ai/web-llm");
type Engine = Awaited<ReturnType<WebLLMModule["CreateMLCEngine"]>>;

let modulePromise: Promise<WebLLMModule> | null = null;
let engine: Engine | null = null;
let loadedModelId: string | null = null;

function loadModule(): Promise<WebLLMModule> {
  if (!modulePromise) modulePromise = import("@mlc-ai/web-llm");
  return modulePromise;
}

/** WebGPU is required. Safari < 18 and Firefox (default) lack it. */
export function isWebGpuAvailable(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

export interface LoadProgress {
  /** 0..1 when known, else undefined. */
  ratio?: number;
  text: string;
}

/** True if the model's weights are already cached for fully-offline load. */
export async function isModelCached(modelId: string): Promise<boolean> {
  try {
    const m = await loadModule();
    return await m.hasModelInCache(modelId, { model_list: m.prebuiltAppConfig.model_list });
  } catch {
    return false;
  }
}

/**
 * Ensure an engine is loaded for `modelId`. Reuses the existing engine when the
 * id is unchanged; reloads weights when the user switches models.
 */
export async function loadEngine(
  modelId: string,
  onProgress: (p: LoadProgress) => void,
): Promise<void> {
  if (!isWebGpuAvailable()) {
    throw new Error(
      "This browser has no WebGPU support, which the on-device AI needs. Try the latest Chrome, Edge, or Safari 18+ on a desktop.",
    );
  }

  if (engine && loadedModelId === modelId) return;

  const m = await loadModule();

  // Switching models: dispose the old engine so we don't hold two GPU contexts.
  if (engine && loadedModelId !== modelId) {
    try {
      await engine.unload();
    } catch {
      /* best effort */
    }
    engine = null;
    loadedModelId = null;
  }

  const created = await m.CreateMLCEngine(modelId, {
    initProgressCallback: (report: { progress: number; text: string }) => {
      onProgress({
        ratio: Number.isFinite(report.progress) ? report.progress : undefined,
        text: report.text,
      });
    },
  });

  engine = created;
  loadedModelId = modelId;
}

export interface GenerateOptions {
  signal?: AbortSignal;
}

/**
 * Run a chat completion and return the raw assistant text. Output is
 * constrained to a JSON object via `response_format` so even small models
 * stay syntactically valid; semantic validation happens downstream.
 */
export async function generate(turns: ChatTurn[], opts: GenerateOptions = {}): Promise<string> {
  if (!engine) throw new Error("Model is not loaded yet.");
  opts.signal?.throwIfAborted();

  const completion = await engine.chat.completions.create({
    messages: turns,
    temperature: 0.3,
    max_tokens: 2048,
    response_format: { type: "json_object" },
  });

  opts.signal?.throwIfAborted();
  return completion.choices[0]?.message?.content ?? "";
}

export function currentModelId(): string | null {
  return loadedModelId;
}
