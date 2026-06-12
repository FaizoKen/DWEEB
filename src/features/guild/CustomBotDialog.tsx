/**
 * Per-server "Custom bot" dialog, opened from the account menu — register the
 * server's OWN Discord application so DWEEB's interactions dispatcher serves
 * it too. Components on messages sent by *their* bot (via a webhook owned by
 * their app) then work through DWEEB's plugins, under the bot's own identity.
 *
 * Each server gets a quota of registrations (default 1). The `cap` in the API
 * response is the source of truth — per-server plans may raise it later, so
 * nothing here hardcodes the number. Once the quota is spent the blank form
 * disappears; a registered app's "Update" action reopens it with the
 * Application ID locked, for replacing a reset key/secret in place.
 *
 * Registration collects the app's Client Secret along with its public ids.
 * The secret is sealed server-side (AES-GCM under the proxy's key), never
 * returned to any browser, and is what makes "Create a webhook from <bot>"
 * in the Send dialog a single click. Webhook creation deliberately does NOT
 * live here — it sits next to the other webhook options where sending
 * happens; this dialog only manages the registration.
 */

import { useEffect, useState, type ReactNode } from "react";
import { useAuthStore } from "@/core/auth/authStore";
import {
  addCustomBot,
  fetchCustomBots,
  isAuthError,
  removeCustomBot,
  type CustomBots,
} from "@/core/guild/api";
import { interactionsEndpointUrl, oauthCallbackUrl } from "@/core/guild/config";
import { Modal } from "@/ui/Modal";
import { Button } from "@/ui/Button";
import { Field } from "@/ui/Field";
import { TextInput } from "@/ui/TextInput";
import styles from "./CustomBotDialog.module.css";

type BotsState =
  | { kind: "loading" }
  | { kind: "ready"; bots: CustomBots }
  | { kind: "unavailable" } // feature off on this deployment (501)
  | { kind: "error"; message: string };

/** Discord snowflakes are 17–20 digits today; accept a small range with slack. */
const SNOWFLAKE_RE = /^\d{15,25}$/;
const PUBLIC_KEY_RE = /^[0-9a-fA-F]{64}$/;

export function CustomBotDialog({
  guildId,
  guildName,
  onClose,
}: {
  guildId: string;
  /** Resolved server name, when known — falls back to a generic label. */
  guildName?: string;
  onClose: () => void;
}) {
  const [state, setState] = useState<BotsState>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Bumped by "Retry" to re-run the fetch effect after an error.
  const [fetchKey, setFetchKey] = useState(0);

  // Register form. With the quota spent the blank form disappears; it only
  // comes back as an *edit* form via a registered app's "Update" action
  // (`editingId` locks the Application ID to that app).
  const [appId, setAppId] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);

  const resetForm = () => {
    setEditingId(null);
    setAppId("");
    setPublicKey("");
    setClientSecret("");
  };

  useEffect(() => {
    const ac = new AbortController();
    setState({ kind: "loading" });
    setActionError(null);
    fetchCustomBots(guildId, ac.signal)
      .then((bots) => setState({ kind: "ready", bots }))
      .catch((e) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        if (isAuthError(e)) {
          // Session died — the menu entry disappears with it; just close.
          useAuthStore.getState().markSignedOut();
          onClose();
        } else if (
          e instanceof Error &&
          "status" in e &&
          (e as { status: number }).status === 501
        ) {
          setState({ kind: "unavailable" });
        } else {
          setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
        }
      });
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guildId, fetchKey]);

  const fail = (e: unknown) => {
    if (isAuthError(e)) {
      useAuthStore.getState().markSignedOut();
      onClose();
    } else {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleRegister = async () => {
    setActionError(null);
    if (!SNOWFLAKE_RE.test(appId.trim())) {
      setActionError("Application ID should be the long number from General Information.");
      return;
    }
    if (!PUBLIC_KEY_RE.test(publicKey.trim())) {
      setActionError("Public Key should be 64 hex characters from General Information.");
      return;
    }
    if (clientSecret.trim().length < 16) {
      setActionError("Client Secret should be the value from OAuth2 → Client Secret.");
      return;
    }
    setBusy(true);
    try {
      const result = await addCustomBot(guildId, appId, publicKey, clientSecret);
      setState({ kind: "ready", bots: result.bots });
      if (result.ok) {
        resetForm();
      } else if (result.reason === "app_taken") {
        setActionError("That application is already registered by another server.");
      } else {
        setActionError("Every registration is in use — remove one first.");
      }
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (applicationId: string) => {
    setBusy(true);
    setActionError(null);
    try {
      setState({ kind: "ready", bots: await removeCustomBot(guildId, applicationId) });
      if (editingId === applicationId) resetForm();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  // Open the form as an update for one registered app: the Application ID is
  // fixed, and a fresh key + secret are required (they're write-only, so
  // there's nothing to prefill). The name re-fetches from Discord on save.
  const startEdit = (applicationId: string) => {
    setActionError(null);
    setEditingId(applicationId);
    setAppId(applicationId);
    setPublicKey("");
    setClientSecret("");
  };

  const endpointUrl = interactionsEndpointUrl();
  const callbackUrl = oauthCallbackUrl();

  let body: ReactNode;
  if (state.kind === "loading") {
    body = <p className={styles.note}>Checking this server’s custom bots…</p>;
  } else if (state.kind === "unavailable") {
    body = <p className={styles.note}>Custom bots aren’t available on this deployment.</p>;
  } else if (state.kind === "error") {
    body = (
      <>
        <p className={styles.error}>{state.message}</p>
        <Button size="sm" onClick={() => setFetchKey((k) => k + 1)}>
          Retry
        </Button>
      </>
    );
  } else {
    const { bots } = state;
    const showForm = bots.used < bots.cap || editingId != null;
    const editingName = editingId
      ? bots.items.find((i) => i.application_id === editingId)?.name
      : undefined;
    body = (
      <>
        <p className={styles.lead}>
          Post with {guildName ?? "this server"}’s own bot — its name, its avatar, DWEEB’s
          interactive components.
        </p>

        <section>
          <div className={styles.sectionHead}>
            <h3 className={styles.sectionTitle}>Registered</h3>
            <span className={styles.usage}>
              {bots.used}/{bots.cap}
            </span>
          </div>

          {bots.items.length === 0 ? (
            <p className={styles.note}>None yet.</p>
          ) : (
            <ul className={styles.botList}>
              {bots.items.map((item) => (
                <li key={item.application_id} className={styles.botItem}>
                  <span className={styles.botText}>
                    <span className={styles.botNameRow}>
                      <span className={styles.botName}>
                        {item.name || `App ${item.application_id}`}
                      </span>
                      {item.has_secret ? (
                        <span className={styles.chipOk}>Ready</span>
                      ) : (
                        <span
                          className={styles.chipWarn}
                          title="Use Update to add the Client Secret — needed for one-click webhooks"
                        >
                          No secret
                        </span>
                      )}
                    </span>
                    <span className={styles.botMeta}>
                      {item.application_id} ·{" "}
                      {new Date(item.added_at).toLocaleDateString([], { dateStyle: "medium" })}
                    </span>
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    title="Replace the stored Public Key and Client Secret"
                    onClick={() => startEdit(item.application_id)}
                  >
                    Update
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    title="Stops serving this app's interactions immediately"
                    onClick={() => void handleRemove(item.application_id)}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}

          {bots.items.some((i) => i.has_secret) ? (
            <p className={styles.footnote}>
              Webhooks for your bot are created from the Send dialog’s webhook section.
            </p>
          ) : null}
        </section>

        {showForm ? (
          <section>
            <div className={styles.sectionHead}>
              <h3 className={styles.sectionTitle}>
                {editingId ? `Update ${editingName || "app"}` : "Register your app"}
              </h3>
              {editingId ? (
                <button type="button" className={styles.linkBtn} onClick={resetForm}>
                  Cancel
                </button>
              ) : null}
            </div>
            <div className={styles.formGrid}>
              <Field
                label="Application ID"
                hint="The bot's name is fetched from Discord automatically"
                className={styles.colFull}
              >
                {(id) => (
                  <TextInput
                    id={id}
                    value={appId}
                    onChange={(e) => setAppId(e.target.value)}
                    placeholder="1234567890123456789"
                    inputMode="numeric"
                    disabled={editingId != null}
                  />
                )}
              </Field>
              <Field
                label="Public key"
                hint="General Information → Public Key"
                className={styles.colFull}
              >
                {(id) => (
                  <TextInput
                    id={id}
                    value={publicKey}
                    onChange={(e) => setPublicKey(e.target.value)}
                    placeholder="64 hex characters"
                    spellCheck={false}
                  />
                )}
              </Field>
              <Field
                label="Client secret"
                hint="OAuth2 → Client Secret · stored encrypted, never shown again"
                className={styles.colFull}
              >
                {(id) => (
                  <TextInput
                    id={id}
                    masked
                    value={clientSecret}
                    onChange={(e) => setClientSecret(e.target.value)}
                    placeholder="••••••••••••••••"
                  />
                )}
              </Field>
            </div>
            <div className={styles.formActions}>
              <Button size="sm" disabled={busy} onClick={() => void handleRegister()}>
                {editingId ? "Save changes" : "Register"}
              </Button>
            </div>
          </section>
        ) : (
          <p className={styles.note}>
            {bots.items.length === 0
              ? "Registrations are closed on this deployment."
              : "Quota in use — higher limits arrive with server plans."}
          </p>
        )}

        <details className={styles.setup}>
          <summary>Setup in the Developer Portal</summary>
          <ol className={styles.steps}>
            <li>
              Register the app here first (Discord verifies the endpoint the moment it’s saved).
            </li>
            <li>
              <strong>OAuth2 → Redirects</strong> — add{" "}
              <code className={styles.code}>{callbackUrl}</code>
            </li>
            <li>
              <strong>General Information → Interactions Endpoint URL</strong> — set{" "}
              <code className={styles.code}>{endpointUrl}</code>
            </li>
          </ol>
        </details>

        {actionError ? <p className={styles.error}>{actionError}</p> : null}
      </>
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Custom bot"
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      {body}
    </Modal>
  );
}
