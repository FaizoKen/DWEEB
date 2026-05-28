/**
 * AI provider settings form.
 *
 * Lets the user bring their own key for any supported provider. Switching the
 * provider re-seeds the model/base-url defaults but preserves whatever the user
 * typed for the key. Nothing here leaves the browser until a chat request is
 * sent, and even then only to the provider the user chose.
 */

import { useState } from "react";
import { Button } from "@/ui/Button";
import { Field } from "@/ui/Field";
import { Select } from "@/ui/Select";
import { TextInput } from "@/ui/TextInput";
import { useAiStore } from "@/core/ai/aiStore";
import { PROVIDERS, defaultSettingsFor } from "@/core/ai/providers";
import { LOCAL_MODELS, isLikelyMobile, isWebGpuSupported } from "@/core/ai/localEngine";
import type { AiProvider, AiSettings } from "@/core/ai/types";
import styles from "./AiChatPanel.module.css";

interface AiSettingsFormProps {
  /** Called after a successful save so the panel can return to the chat view. */
  onSaved?: () => void;
  /** Hide the cancel button (e.g. first-run, where there's nothing to go back to). */
  showCancel?: boolean;
  onCancel?: () => void;
}

export function AiSettingsForm({ onSaved, showCancel, onCancel }: AiSettingsFormProps) {
  const saved = useAiStore((s) => s.settings);
  const setSettings = useAiStore((s) => s.setSettings);

  const mobile = isLikelyMobile();
  const webGpuOk = isWebGpuSupported();

  // On mobile the local provider is a non-starter (WebGPU buffer limits +
  // unreliable downloads), so if the saved provider is "local" we seed the draft
  // with a free cloud provider instead — the dropdown also hides "local", so the
  // form should never present an option the user can't actually use.
  const [draft, setDraft] = useState<AiSettings>(() =>
    mobile && saved.provider === "local"
      ? { ...defaultSettingsFor("groq"), apiKey: saved.apiKey }
      : saved,
  );
  const [revealKey, setRevealKey] = useState(false);

  const meta = PROVIDERS[draft.provider];
  const isLocal = draft.provider === "local";

  const visibleProviders = (Object.keys(PROVIDERS) as AiProvider[]).filter(
    (p) => !(mobile && p === "local"),
  );

  const changeProvider = (provider: AiProvider) => {
    const seed = defaultSettingsFor(provider);
    // Keep the key the user already typed; re-seed model + base url.
    setDraft({ provider, apiKey: draft.apiKey, model: seed.model, baseUrl: seed.baseUrl });
  };

  // The local provider needs no credential — the only requirement is a valid
  // model id. Cloud providers still gate on the API key.
  const keyMissing = !isLocal && draft.apiKey.trim().length === 0;
  const modelMissing = draft.model.trim().length === 0;
  const baseUrlMissing = meta.requiresBaseUrl && draft.baseUrl.trim().length === 0;
  const canSave = !keyMissing && !modelMissing && !baseUrlMissing;

  const handleSave = () => {
    if (!canSave) return;
    setSettings({
      provider: draft.provider,
      apiKey: isLocal ? "" : draft.apiKey.trim(),
      model: draft.model.trim(),
      baseUrl: isLocal ? "" : draft.baseUrl.trim(),
    });
    onSaved?.();
  };

  const selectedLocalModel = LOCAL_MODELS.find((m) => m.id === draft.model);

  return (
    <div className={styles.settings}>
      <p className={styles.settingsLead}>
        {isLocal ? (
          <>
            Runs entirely in this browser via WebGPU. No API key, no servers — your prompts and
            replies never leave the device. The model is downloaded once and cached locally.
          </>
        ) : (
          <>
            Bring your own API key. It is stored only in this browser and sent directly to your
            chosen provider — never to us.
          </>
        )}
      </p>

      <Field label="Provider">
        {(id) => (
          <Select
            id={id}
            value={draft.provider}
            onChange={(e) => changeProvider(e.currentTarget.value as AiProvider)}
          >
            {visibleProviders.map((p) => (
              <option key={p} value={p}>
                {PROVIDERS[p].label}
              </option>
            ))}
          </Select>
        )}
      </Field>

      {isLocal ? (
        <>
          {!webGpuOk ? (
            <div className={styles.localWarn}>
              WebGPU isn't available in this browser. Local AI needs the latest Chrome / Edge
              (desktop) or Safari 17.4+. On Firefox enable <code>dom.webgpu.enabled</code> in{" "}
              <code>about:config</code>.
            </div>
          ) : mobile ? (
            <div className={styles.localWarn}>
              Local AI is desktop-only in practice. Mobile GPUs cap WebGPU buffer sizes well below
              what these models need, so loading will fail before the download finishes. Pick a
              free cloud provider (Groq or OpenRouter) instead — no download, works on mobile.
            </div>
          ) : null}

          <Field
            label="Model"
            hint={
              selectedLocalModel ? (
                <>
                  ~{selectedLocalModel.sizeMB} MB download on first use, cached afterwards. Smaller
                  models load faster but produce simpler messages.
                </>
              ) : (
                "Pick a model — or paste any WebLLM prebuilt id below."
              )
            }
            error={modelMissing ? "Pick a model to use." : undefined}
          >
            {(id) => (
              <Select
                id={id}
                value={draft.model}
                invalid={modelMissing}
                onChange={(e) => {
                  const value = e.currentTarget.value;
                  setDraft((d) => ({ ...d, model: value }));
                }}
              >
                {LOCAL_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} · {m.sizeMB} MB
                  </option>
                ))}
                {selectedLocalModel ? null : (
                  <option value={draft.model}>Custom: {draft.model}</option>
                )}
              </Select>
            )}
          </Field>
        </>
      ) : (
        <>
          <Field
            label="API key"
            hint={
              meta.keysUrl ? (
                <>
                  Get one at{" "}
                  <a href={meta.keysUrl} target="_blank" rel="noopener noreferrer">
                    {new URL(meta.keysUrl).host}
                  </a>
                  .
                </>
              ) : (
                "Use the key your provider issued."
              )
            }
          >
            {(id) => (
              <div className={styles.keyRow}>
                <TextInput
                  id={id}
                  type={revealKey ? "text" : "password"}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={meta.keyPlaceholder}
                  value={draft.apiKey}
                  onChange={(e) => {
                    const value = e.currentTarget.value;
                    setDraft((d) => ({ ...d, apiKey: value }));
                  }}
                />
                <button
                  type="button"
                  className={styles.revealBtn}
                  onClick={() => setRevealKey((v) => !v)}
                  aria-pressed={revealKey}
                >
                  {revealKey ? "Hide" : "Show"}
                </button>
              </div>
            )}
          </Field>

          <Field
            label="Model"
            hint="Editable — paste any model id your key can access."
            error={modelMissing ? "A model id is required." : undefined}
          >
            {(id) => (
              <TextInput
                id={id}
                spellCheck={false}
                placeholder={meta.defaultModel || "model id"}
                value={draft.model}
                invalid={modelMissing}
                onChange={(e) => {
                  const value = e.currentTarget.value;
                  setDraft((d) => ({ ...d, model: value }));
                }}
              />
            )}
          </Field>

          <Field
            label={meta.requiresBaseUrl ? "Base URL" : "Base URL (optional)"}
            hint={
              meta.requiresBaseUrl
                ? "The OpenAI-compatible endpoint origin, e.g. https://openrouter.ai/api/v1"
                : "Override only if you proxy the provider's API."
            }
            error={baseUrlMissing ? "A base URL is required for this provider." : undefined}
          >
            {(id) => (
              <TextInput
                id={id}
                spellCheck={false}
                placeholder={meta.defaultBaseUrl || "https://…"}
                value={draft.baseUrl}
                invalid={baseUrlMissing}
                onChange={(e) => {
                  const value = e.currentTarget.value;
                  setDraft((d) => ({ ...d, baseUrl: value }));
                }}
              />
            )}
          </Field>
        </>
      )}

      <div className={styles.settingsActions}>
        {showCancel ? (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button variant="primary" onClick={handleSave} disabled={!canSave}>
          Save
        </Button>
      </div>
    </div>
  );
}
