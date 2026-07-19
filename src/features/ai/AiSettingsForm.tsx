/**
 * AI provider settings form.
 *
 * Lets the user bring their own key for any supported provider. Switching the
 * provider re-seeds the model/base-url defaults but preserves whatever the user
 * typed for the key. Nothing here leaves the browser until a chat request is
 * sent, and even then only to the provider the user chose.
 */

import { useState } from "react";
import { cn } from "@/lib/cn";
import { Button } from "@/ui/Button";
import { Field } from "@/ui/Field";
import { Select } from "@/ui/Select";
import { TextInput } from "@/ui/TextInput";
import { useAiStore } from "@/core/ai/aiStore";
import { PROVIDERS, defaultSettingsFor } from "@/core/ai/providerMeta";
import type { AiProvider, AiSettings } from "@/core/ai/types";
import { useAuthStore } from "@/core/auth/authStore";
import { isProxyConfigured } from "@/core/guild/config";
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
  // First run (no key yet) gets a nudge toward the most reliable free tier.
  const isConfigured = useAiStore((s) => s.isConfigured());

  const [draft, setDraft] = useState<AiSettings>(() => saved);
  const [revealKey, setRevealKey] = useState(false);
  const authStatus = useAuthStore((s) => s.status);
  const login = useAuthStore((s) => s.login);

  const meta = PROVIDERS[draft.provider];
  // The built-in relay only exists where a proxy is configured; a proxyless
  // build (pure client-side builder) hides it and starts users on BYOK.
  const builtInAvailable = isProxyConfigured();
  const builtIn = Boolean(meta.builtIn);

  const changeProvider = (provider: AiProvider) => {
    const seed = defaultSettingsFor(provider);
    // Keep the key the user already typed; re-seed model + base url.
    setDraft({ provider, apiKey: draft.apiKey, model: seed.model, baseUrl: seed.baseUrl });
  };

  // The built-in provider has no key/model/base-url of its own — the proxy
  // owns the credential and pins the model, so those checks don't apply.
  const keyMissing = !builtIn && meta.requiresKey && draft.apiKey.trim().length === 0;
  const modelMissing = !builtIn && draft.model.trim().length === 0;
  const baseUrlMissing = !builtIn && meta.requiresBaseUrl && draft.baseUrl.trim().length === 0;
  const canSave = !keyMissing && !modelMissing && !baseUrlMissing && (!builtIn || builtInAvailable);

  const handleSave = () => {
    if (!canSave) return;
    setSettings({
      provider: draft.provider,
      apiKey: draft.apiKey.trim(),
      model: draft.model.trim(),
      baseUrl: draft.baseUrl.trim(),
    });
    onSaved?.();
  };

  return (
    <div className={styles.settings}>
      {!isConfigured ? (
        <div className={styles.onboard}>
          {builtInAvailable ? (
            <>
              <strong>No key needed.</strong> DWEEB AI is built in — sign in with Discord and start
              building for free. Prefer full control?{" "}
              {draft.provider === "dweeb" ? (
                "Pick a provider below to use your own key."
              ) : (
                <button
                  type="button"
                  className={styles.onboardSwitch}
                  onClick={() => changeProvider("dweeb")}
                >
                  Switch to DWEEB AI
                </button>
              )}
            </>
          ) : (
            <>
              <strong>New here? Start free with Groq.</strong> It's the most reliable free tier — a
              free API key, no credit card. Other free providers have regional limits or daily caps.{" "}
              {draft.provider === "groq" ? (
                <a href={PROVIDERS.groq.keysUrl} target="_blank" rel="noopener noreferrer">
                  Get a free Groq key →
                </a>
              ) : (
                <button
                  type="button"
                  className={styles.onboardSwitch}
                  onClick={() => changeProvider("groq")}
                >
                  Switch to Groq
                </button>
              )}
            </>
          )}
        </div>
      ) : null}
      <p className={styles.settingsLead}>
        {builtIn
          ? "Built-in AI runs through DWEEB's server — no key to manage. Your own API key (below, under any other provider) always stays only in this browser."
          : "Bring your own API key. It is stored only in this browser and sent directly to your chosen provider — never to us."}
      </p>

      <Field label="Provider">
        {(id) => (
          <div className={styles.providerControl}>
            <Select
              id={id}
              value={draft.provider}
              onChange={(e) => changeProvider(e.currentTarget.value as AiProvider)}
            >
              {(Object.keys(PROVIDERS) as AiProvider[])
                .filter((p) => builtInAvailable || !PROVIDERS[p].builtIn)
                .map((p) => (
                  <option key={p} value={p}>
                    {PROVIDERS[p].label}
                    {PROVIDERS[p].freeTier ? " — Free" : ""}
                  </option>
                ))}
            </Select>
            <span
              className={cn(
                styles.providerTag,
                meta.freeTier ? styles.providerTagFree : styles.providerTagPaid,
              )}
            >
              {meta.freeTier
                ? (meta.freeTierNote ??
                  (meta.requiresKey
                    ? "Free tier — no credit card needed"
                    : "Free — runs on your machine"))
                : "Paid — requires API credit"}
            </span>
          </div>
        )}
      </Field>

      {builtIn ? (
        <div className={styles.builtInCard}>
          <span>
            <strong>Ready out of the box.</strong> DWEEB picks a fast model and covers the usage —
            free daily allowance for everyone, bigger shared pools on Plus/Pro servers.
          </span>
          {authStatus === "anon" ? (
            <span>
              You'll need to{" "}
              <button type="button" className={styles.onboardSwitch} onClick={login}>
                sign in with Discord
              </button>{" "}
              to use it.
            </span>
          ) : null}
        </div>
      ) : null}

      {builtIn ? null : (
        <>
          <Field
            label={meta.requiresKey ? "API key" : "API key (optional)"}
            hint={
              meta.keysUrl ? (
                <>
                  Get one at{" "}
                  <a href={meta.keysUrl} target="_blank" rel="noopener noreferrer">
                    {new URL(meta.keysUrl).host}
                  </a>
                  .
                </>
              ) : meta.requiresKey ? (
                "Use the key your provider issued."
              ) : (
                "No API key is required for this provider."
              )
            }
          >
            {(id) => (
              <div className={styles.keyRow}>
                <TextInput
                  id={id}
                  masked={!revealKey}
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
