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

// Patch before the handler exists — the handler will trigger
// `requestAdapter()` on the first `reload` message, so the patch must be in
// place before any inbound message can be handled.
patchRequestAdapterForIntegratedGpus();

const handler = new WebWorkerMLCEngineHandler();

// `addEventListener` resolves to the worker scope when this module is
// loaded by `new Worker(...)`. We use it instead of `self.onmessage = …`
// to avoid the WebWorker / DOM lib type clash in the app's tsconfig — DOM
// types are loaded for the rest of the app and adding WebWorker globally
// would override the meaning of `self` everywhere.
addEventListener("message", (event) => {
  handler.onmessage(event as MessageEvent);
});

/**
 * WebLLM's internal `detectGPUDevice` hard-codes
 * `requestAdapter({ powerPreference: "high-performance" })`. On Chrome
 * running on a system with only integrated graphics (no discrete GPU), that
 * request can return `null` even though the iGPU would happily serve a
 * request with no power-preference hint — Chrome's high-performance path
 * looks for a dedicated adapter and bails when none exists, rather than
 * falling back to the iGPU.
 *
 * Since WebLLM doesn't expose a way to override the power preference, we
 * wrap `navigator.gpu.requestAdapter` here: if the original call returns
 * `null`, retry without `powerPreference`, and then with `"low-power"`,
 * before surfacing the null result. Any of the three returning an adapter
 * is enough to unblock the engine.
 *
 * The patch is no-op if WebGPU isn't exposed at all — the engine will
 * report a clearer "no WebGPU" error in that case.
 */
function patchRequestAdapterForIntegratedGpus(): void {
  type AdapterRequestOptions = { powerPreference?: string } & Record<string, unknown>;
  type RequestAdapterFn = (options?: AdapterRequestOptions) => Promise<unknown>;
  const gpu = (navigator as unknown as { gpu?: { requestAdapter?: RequestAdapterFn } }).gpu;
  if (!gpu || typeof gpu.requestAdapter !== "function") return;

  const original = gpu.requestAdapter.bind(gpu);
  gpu.requestAdapter = async function patched(options?: AdapterRequestOptions) {
    const first = await original(options);
    if (first) return first;

    // Some Chromium configs return null when the caller asks for
    // "high-performance" on a machine that only has integrated graphics.
    // Re-try with the hint stripped, then explicitly with "low-power".
    if (options && options.powerPreference === "high-performance") {
      const { powerPreference: _ignored, ...rest } = options;
      const restKeys = Object.keys(rest).length > 0 ? rest : undefined;
      const noPref = await original(restKeys as AdapterRequestOptions | undefined);
      if (noPref) return noPref;

      const lowPower = await original({ ...rest, powerPreference: "low-power" });
      if (lowPower) return lowPower;
    }

    return first;
  };
}
