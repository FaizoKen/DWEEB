/**
 * Dedicated Web Worker that hosts the actual WebLLM engine.
 *
 * `localEngine.ts` instantiates this module with
 * `new Worker(new URL("./webllmWorker.ts", import.meta.url), { type: "module" })`
 * and talks to it through `CreateWebWorkerMLCEngine`. All the heavy WebGPU work
 * — compiling the model and generating every token — runs here, off the main
 * thread.
 *
 * That is the whole point: on a weak integrated GPU, running inference on the
 * main thread pins both the UI and the GPU queue, the tab freezes, and the GPU
 * eventually trips its watchdog (a Windows TDR / "device-removed") which wedges
 * Chrome's shared GPU process for *every* tab until a full restart. Moving the
 * work into a worker keeps the main thread free and isolates the GPU
 * submission, which is exactly how the official chat.webllm.ai app stays stable
 * on the same hardware.
 *
 * The worker is intentionally tiny: a single handler that proxies messages
 * between the main-thread client and the in-worker engine.
 */

import { WebWorkerMLCEngineHandler } from "@mlc-ai/web-llm";

const handler = new WebWorkerMLCEngineHandler();

self.onmessage = (msg: MessageEvent) => {
  handler.onmessage(msg);
};
