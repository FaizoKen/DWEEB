/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

// App build version, inlined at build time via Vite's `define` (see
// vite.config.ts). Read by the crash reporter to pin a report to a deploy.
declare const __APP_VERSION__: string;

// Build-time configuration for the optional DWEEB proxy (see `server/` and
// `.env.example`). Both are optional: with no base URL the guild features stay
// dormant and the app behaves as a pure client-side builder.
interface ImportMetaEnv {
  /** Proxy origin, e.g. `https://api.dweeb.example.com`. */
  readonly VITE_PROXY_BASE_URL?: string;
  /** Discord application (client) id — public; used for the bot-invite link. */
  readonly VITE_DISCORD_CLIENT_ID?: string;
  /** Canonical web-app URL used by the Activity's Open-on-web hand-off. */
  readonly VITE_WEB_APP_URL?: string;
  /** Public Discord interactions endpoint shown during custom-bot setup. */
  readonly VITE_INTERACTIONS_URL?: string;
  /** Stripe publishable key (`pk_live_…`/`pk_test_…`) for the in-app embedded
   *  Checkout. Empty → the pricing modal is informational only (no checkout). */
  readonly VITE_STRIPE_PUBLISHABLE_KEY?: string;
  /** Interactive-component lifetime; blank uses the dispatcher default. */
  readonly VITE_COMPONENT_TTL_DAYS?: string;
  /** Dev only: local origin for the modal-form plugin's config UI (default `http://localhost:8090`). */
  readonly VITE_DEV_MODAL_FORM_ORIGIN?: string;
  /** Dev only: local origin for the ping-pong plugin's config UI (default `http://localhost:8091`). */
  readonly VITE_DEV_PING_PONG_ORIGIN?: string;
  /** Dev only: local origin for the self-role plugin's config UI (default `http://localhost:8092`). */
  readonly VITE_DEV_SELF_ROLE_ORIGIN?: string;
  /** Dev only: local origin for the tickets plugin's config UI (default `http://localhost:8093`). */
  readonly VITE_DEV_TICKETS_ORIGIN?: string;
  /** Dev only: local origin for the giveaway plugin's config UI (default `http://localhost:8094`). */
  readonly VITE_DEV_GIVEAWAY_ORIGIN?: string;
  /** Dev only: local origin for quick replies (default `http://localhost:8096`). */
  readonly VITE_DEV_QUICK_REPLIES_ORIGIN?: string;
  /** Dev only: local origin for the picker plugin's config UI (default `http://localhost:8097`). */
  readonly VITE_DEV_PICKER_ORIGIN?: string;
  /** Dev only: local origin for the poll plugin's config UI (default `http://localhost:8098`). */
  readonly VITE_DEV_POLL_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  /**
   * In-flight short-link resolution started by the inline early-resolve
   * script in `index.html`, consumed (once) by `shortlink.ts`.
   */
  __dweebShortLink?: Promise<Response | null>;
}

// Treat default-imported CSS Modules as a string->string lookup so e.g.
// `import styles from "./Foo.module.css"; styles.bar` type-checks.
declare module "*.module.css" {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}
