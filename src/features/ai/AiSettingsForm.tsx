/**
 * AI provider settings form.
 *
 * Two tiers, deliberately: the built-in DWEEB relay is the primary (and
 * default) path — no key, no model id, just a Discord sign-in — while the
 * bring-your-own-key providers live behind an "advanced" disclosure. BYOK is
 * NOT a legacy path to be removed: it's the escape valve every quota/budget
 * refusal steers users to (see `server/src/ai.rs`), it costs the deployment
 * nothing (browser → provider directly), and it's the only AI a signed-out or
 * proxyless visitor can use. Hiding it declutters the picker without breaking
 * any of that.
 *
 * Switching provider re-seeds the model/base-url defaults but preserves
 * whatever the user typed for the key. A BYOK key never leaves the browser
 * until a chat request is sent, and even then only to the provider they chose.
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

/** The BYOK provider the advanced section opens on when the user has never
 *  picked one — the most reliable free tier. */
const DEFAULT_BYOK: AiProvider = "groq";

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
  // First run (nothing usable configured yet) gets a nudge.
  const isConfigured = useAiStore((s) => s.isConfigured());
  const authStatus = useAuthStore((s) => s.status);
  const login = useAuthStore((s) => s.login);

  // The built-in relay only exists where a proxy is configured; a proxyless
  // build (pure client-side builder) hides it and runs BYOK-only.
  const builtInAvailable = isProxyConfigured();

  const [draft, setDraft] = useState<AiSettings>(() => saved);
  const [revealKey, setRevealKey] = useState(false);
  // Open the advanced section when the user is already on a BYOK provider (so
  // their live config is never hidden from them), or when built-in isn't
  // available at all and BYOK is the only option.
  const [showAdvanced, setShowAdvanced] = useState(
    () => !builtInAvailable || !PROVIDERS[saved.provider].builtIn,
  );

  const meta = PROVIDERS[draft.provider];
  const builtIn = Boolean(meta.builtIn);

  const changeProvider = (provider: AiProvider) => {
    const seed = defaultSettingsFor(provider);
    // Keep the key the user already typed; re-seed model + base url.
    setDraft({ provider, apiKey: draft.apiKey, model: seed.model, baseUrl: seed.baseUrl });
  };

  const openAdvanced = () => {
    setShowAdvanced(true);
    // Land on the provider they last saved if it was a BYOK one, else the
    // most reliable free tier.
    if (PROVIDERS[draft.provider].builtIn) {
      changeProvider(PROVIDERS[saved.provider].builtIn ? DEFAULT_BYOK : saved.provider);
    }
  };

  const useBuiltIn = () => {
    setShowAdvanced(false);
    changeProvider("dweeb");
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
      {!isConfigured && showAdvanced ? (
        <div className={styles.onboard}>
          <strong>Start free with Groq.</strong> It's the most reliable free tier — a free API key,
          no credit card. Other free providers have regional limits or daily caps.{" "}
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
        </div>
      ) : null}

      {builtIn ? (
        <>
          <div className={styles.builtInCard}>
            <span>
              <strong>DWEEB AI — ready out of the box.</strong> No API key to manage: DWEEB picks a
              fast model and covers the usage. Free daily allowance for everyone, with bigger shared
              pools on Plus and Pro servers.
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
          <button type="button" className={styles.advancedToggle} onClick={openAdvanced}>
            Use your own API key (advanced)
          </button>
        </>
      ) : (
        <>
          <p className={styles.settingsLead}>
            Your API key is stored only in this browser and sent directly to the provider you choose
            — never to us. Usage is unlimited and billed by them, not DWEEB.
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
                    .filter((p) => !PROVIDERS[p].builtIn)
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

          {builtInAvailable ? (
            <button type="button" className={styles.advancedToggle} onClick={useBuiltIn}>
              ← Use DWEEB AI instead (no key needed)
            </button>
          ) : null}
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
