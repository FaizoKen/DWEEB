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
import { customBotInviteUrl, interactionsEndpointUrl, oauthCallbackUrl } from "@/core/guild/config";
import { copyText } from "@/core/serialization/clipboard";
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

/**
 * Live result of checking whether the owner finished the portal step. The
 * proof is end-to-end: the dispatcher reports `verified` once Discord has
 * actually delivered a validly-signed interaction for the app — which only
 * happens after its Interactions Endpoint URL points back at DWEEB with the
 * right public key. (Reading the app's config back isn't possible — that
 * needs a bot token, which registration never collects.)
 */
type VerifyState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "done"; connected: boolean }
  // Network / server hiccup re-fetching the registry; transient, offer a retry.
  | { kind: "unreachable"; message: string };

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

  // The app whose "Point it back at DWEEB" step is currently on screen — set
  // right after a registration (so step 3 doesn't vanish when the quota fills)
  // and when a returning owner clicks "Check connection" on a registered app.
  const [setupApp, setSetupApp] = useState<{ id: string; name: string } | null>(null);
  const [verify, setVerify] = useState<VerifyState>({ kind: "idle" });

  const resetForm = () => {
    setEditingId(null);
    setAppId("");
    setPublicKey("");
    setClientSecret("");
  };

  // Open the finish-setup panel for one app, fresh (no stale verify result).
  // Clears any in-progress edit so the two don't compete for the same area.
  const openSetup = (id: string, name: string) => {
    setActionError(null);
    resetForm();
    setVerify({ kind: "idle" });
    setSetupApp({ id, name });
  };

  const closeSetup = () => {
    setSetupApp(null);
    setVerify({ kind: "idle" });
  };

  // Re-pull the registry and read the app's `verified` flag — true once the
  // dispatcher has received a validly-signed interaction for it, i.e. the
  // owner finished the Interactions Endpoint URL step. A failed fetch is
  // "couldn't check" (retry), never a false "not connected".
  const runVerify = async (applicationId: string) => {
    setVerify({ kind: "checking" });
    try {
      const bots = await fetchCustomBots(guildId);
      setState({ kind: "ready", bots });
      const item = bots.items.find((i) => i.application_id === applicationId);
      setVerify({ kind: "done", connected: item?.verified ?? false });
    } catch (e) {
      if (isAuthError(e)) {
        useAuthStore.getState().markSignedOut();
        onClose();
        return;
      }
      setVerify({ kind: "unreachable", message: e instanceof Error ? e.message : String(e) });
    }
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
        const registeredId = appId.trim();
        if (editingId == null) {
          // A fresh registration still has to paste DWEEB's two URLs into the
          // app's portal — so keep that step on screen (openSetup clears the
          // form) instead of letting it vanish once the quota fills.
          const name = result.bots.items.find((i) => i.application_id === registeredId)?.name || "";
          openSetup(registeredId, name);
        } else {
          // An Update is just a key/secret swap — no portal step to finish.
          resetForm();
        }
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
      if (setupApp?.id === applicationId) closeSetup();
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
    closeSetup();
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
    // A first-time registration gets the full numbered walkthrough; an "Update"
    // (editingId set) is just a key/secret swap, so it skips the portal steps.
    const freshRegister = showForm && editingId == null;
    const editingName = editingId
      ? bots.items.find((i) => i.application_id === editingId)?.name
      : undefined;

    const formFields = (
      <div className={styles.formGrid}>
        <Field
          label="Application ID"
          hint="General Information · its name loads in automatically"
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
    );

    // The two URLs the owner pastes back into their app's portal settings.
    const portalUrls = (
      <>
        <CopyField label="OAuth2 → Redirects" value={callbackUrl} />
        <CopyField label="General Information → Interactions Endpoint URL" value={endpointUrl} />
      </>
    );

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
                      {item.verified ? (
                        <span
                          className={styles.chipOk}
                          title="DWEEB is receiving this app's interactions — it's wired up"
                        >
                          Connected
                        </span>
                      ) : (
                        <span
                          className={styles.chipWarn}
                          title="Use Check to finish pointing this app's Interactions Endpoint URL at DWEEB"
                        >
                          Setup
                        </span>
                      )}
                      {item.has_secret ? null : (
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
                    <a
                      className={styles.inviteLink}
                      href={customBotInviteUrl(item.application_id)}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Optional — lists the bot in your server and enables its own commands. Not needed for posting or interactive components."
                    >
                      Add to your server ↗
                    </a>
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    title="Finish setup / check this app is wired up to DWEEB"
                    onClick={() => openSetup(item.application_id, item.name)}
                  >
                    Check
                  </Button>
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

        {setupApp ? (
          // Persists past the quota flip: a freshly-registered app still has to
          // have its two URLs pasted into the portal, and this verifies it.
          <SetupStep
            app={setupApp}
            endpointUrl={endpointUrl}
            callbackUrl={callbackUrl}
            verify={verify}
            busy={busy}
            onCheck={() => void runVerify(setupApp.id)}
            onClose={closeSetup}
          />
        ) : freshRegister ? (
          <ol className={styles.guide}>
            <li className={styles.step}>
              <span className={styles.stepNum}>1</span>
              <div className={styles.stepBody}>
                <span className={styles.stepTitle}>Create your app</span>
                <span className={styles.stepHint}>
                  In Discord’s Developer Portal, click <strong>New Application</strong> and give it
                  a name.
                </span>
                <a
                  className={styles.portalBtn}
                  href="https://discord.com/developers/applications"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open Developer Portal ↗
                </a>
              </div>
            </li>

            <li className={styles.step}>
              <span className={styles.stepNum}>2</span>
              <div className={styles.stepBody}>
                <span className={styles.stepTitle}>Paste its details here</span>
                {formFields}
                <div className={styles.formActions}>
                  <Button size="sm" disabled={busy} onClick={() => void handleRegister()}>
                    Register
                  </Button>
                </div>
              </div>
            </li>

            <li className={styles.step}>
              <span className={styles.stepNum}>3</span>
              <div className={styles.stepBody}>
                <span className={styles.stepTitle}>Point it back at DWEEB</span>
                <span className={styles.stepHint}>
                  After registering, paste each into your app’s portal and save — Discord checks
                  them right away.
                </span>
                {portalUrls}
              </div>
            </li>
          </ol>
        ) : showForm ? (
          <section>
            <div className={styles.sectionHead}>
              <h3 className={styles.sectionTitle}>Update {editingName || "app"}</h3>
              <button type="button" className={styles.linkBtn} onClick={resetForm}>
                Cancel
              </button>
            </div>
            {formFields}
            <div className={styles.formActions}>
              <Button size="sm" disabled={busy} onClick={() => void handleRegister()}>
                Save changes
              </Button>
            </div>
            <details className={styles.setup}>
              <summary>Developer Portal URLs</summary>
              <div className={styles.urlRef}>{portalUrls}</div>
            </details>
          </section>
        ) : (
          <>
            <p className={styles.note}>
              {bots.items.length === 0
                ? "Registrations are closed on this deployment."
                : "Quota in use — higher limits arrive with server plans."}
            </p>
            <details className={styles.setup}>
              <summary>Developer Portal URLs</summary>
              <div className={styles.urlRef}>{portalUrls}</div>
            </details>
          </>
        )}

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

/**
 * The "Point it back at DWEEB" step, kept on screen after a registration until
 * the bot is actually wired up. "Check connection" re-pulls the registry and
 * reads the dispatcher's `verified` flag — green only once Discord has
 * delivered a real signed interaction for the app, which proves its
 * Interactions Endpoint URL points here with the right public key. A failed
 * fetch is explained as "couldn't check", never as "not connected", and
 * "Close" leaves the panel without forcing a green result.
 */
function SetupStep({
  app,
  endpointUrl,
  callbackUrl,
  verify,
  busy,
  onCheck,
  onClose,
}: {
  app: { id: string; name: string };
  endpointUrl: string;
  callbackUrl: string;
  verify: VerifyState;
  busy: boolean;
  onCheck: () => void;
  onClose: () => void;
}) {
  const done = verify.kind === "done" ? verify : null;
  const connected = done?.connected ?? false;
  const name = app.name || `App ${app.id}`;
  const checkLabel =
    verify.kind === "checking"
      ? "Checking…"
      : verify.kind === "idle"
        ? "Check connection"
        : "Check again";

  return (
    <section className={styles.setupStep}>
      <div className={styles.sectionHead}>
        <h3 className={styles.sectionTitle}>
          {connected ? "Setup complete" : "Finish setup — point it back at DWEEB"}
        </h3>
        <button type="button" className={styles.linkBtn} onClick={onClose}>
          {connected ? "Done" : "Close"}
        </button>
      </div>

      {connected ? (
        <p className={styles.successNote}>
          ✓ {name} is connected — DWEEB is receiving its interactions, so its buttons and menus
          work.
        </p>
      ) : (
        <>
          <p className={styles.stepHint}>
            In <strong>{name}</strong>’s Developer Portal, set the Interactions Endpoint URL and
            save — Discord pings DWEEB the instant you do — then check the connection here.
          </p>
          <div className={styles.urlRef}>
            <CopyField
              label="General Information → Interactions Endpoint URL"
              value={endpointUrl}
              status={done ? (connected ? "connected" : "waiting") : undefined}
            />
            <CopyField label="OAuth2 → Redirects" value={callbackUrl} />
          </div>
          <p className={styles.footnote}>
            The redirect URL is only for one-click webhook creation — Discord checks it when you
            create a webhook, so it isn’t part of this connection check.
          </p>
        </>
      )}

      {verify.kind === "unreachable" ? (
        <p className={styles.error}>{verify.message}</p>
      ) : done && !connected ? (
        <div className={styles.waiting}>
          <p className={styles.note}>
            Nothing’s reached DWEEB from {name} yet. Re-saving the same URL won’t help — Discord
            only re-checks when the URL actually changes. Do one of these, then check again:
          </p>
          <ul className={styles.tips}>
            <li>In the portal: clear the endpoint URL, save, paste it back, and save again.</li>
            <li>Or click any button or menu on one of the bot’s messages.</li>
          </ul>
        </div>
      ) : null}

      {!connected ? (
        <div className={styles.formActions}>
          <Button size="sm" disabled={busy || verify.kind === "checking"} onClick={onCheck}>
            {checkLabel}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/**
 * One labeled, copy-to-clipboard URL row — used for the redirect and
 * interactions-endpoint values a beginner has to paste back into their app's
 * Developer Portal. The value is long and copy-paste-only, so a one-click Copy
 * beats asking them to select it by hand. Renders nothing when the URL is empty
 * (no proxy configured). An optional `status` shows the live connection check
 * result for this URL ("connected" once interactions are flowing, "waiting"
 * while none have arrived yet).
 */
function CopyField({
  label,
  value,
  status,
}: {
  label: ReactNode;
  value: string;
  status?: "connected" | "waiting";
}) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  const onCopy = async () => {
    if (await copyText(value)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };
  return (
    <div className={styles.copyField}>
      <span className={styles.copyLabel}>
        <span>{label}</span>
        {status === "connected" ? (
          <span className={styles.chipOk}>Connected</span>
        ) : status === "waiting" ? (
          <span className={styles.chipWarn}>Waiting</span>
        ) : null}
      </span>
      <div className={styles.copyRow}>
        <code className={styles.copyValue}>{value}</code>
        <Button size="sm" variant="ghost" onClick={() => void onCopy()}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}
