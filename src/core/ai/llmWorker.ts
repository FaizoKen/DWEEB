/**
 * WebLLM worker host.
 *
 * Runs the MLCEngine — and therefore the WebGPU device that hosts model
 * weights and inference — inside a dedicated worker. Two reliability wins
 * versus the in-page engine:
 *
 *   • The GPU device lives in the worker's JS context, isolated from main-
 *     thread React work and any other code that touches `navigator.gpu`.
 *     On Windows D3D12, contention with the main thread during
 *     `requestDevice()` is the most common cause of `DXGI_ERROR_DEVICE_REMOVED`.
 *   • A wedged device can be cleared with `worker.terminate()` from the main
 *     thread. That tears down the entire worker process and lets the driver
 *     release the device, which `engine.unload()` alone often can't do
 *     within the lifetime of a single page.
 *
 * This is the same pattern chat.webllm.ai uses (see `CreateWebWorkerMLCEngine`
 * in @mlc-ai/web-llm).
 */

import { WebWorkerMLCEngineHandler } from "@mlc-ai/web-llm";

const handler = new WebWorkerMLCEngineHandler();

// `addEventListener` resolves to the worker scope when this module is
// loaded by `new Worker(...)`. We use it instead of `self.onmessage = …`
// to avoid the WebWorker / DOM lib type clash in the app's tsconfig — DOM
// types are loaded for the rest of the app and adding WebWorker globally
// would override the meaning of `self` everywhere.
addEventListener("message", (event) => {
  handler.onmessage(event as MessageEvent);
});
