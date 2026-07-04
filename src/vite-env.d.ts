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
  /** Feedback forum webhook URL — quick-feedback posts go here. Empty → feature off. */
  readonly VITE_FEEDBACK_WEBHOOK_URL?: string;
  /** Dev only: local origin for the modal-form plugin's config UI (default `http://localhost:8090`). */
  readonly VITE_DEV_MODAL_FORM_ORIGIN?: string;
  /** Dev only: local origin for the ping-pong plugin's config UI (default `http://localhost:8091`). */
  readonly VITE_DEV_PING_PONG_ORIGIN?: string;
  /** Dev only: local origin for the self-role plugin's config UI (default `http://localhost:8092`). */
  readonly VITE_DEV_SELF_ROLE_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  /**
   * In-flight short-link resolution started by the inline early-resolve
   * script in `index.html`, consumed (once) by `shortlink.ts`.
   */
  __dweebShortLink?: Promise<Response>;
}

// Treat default-imported CSS Modules as a string->string lookup so e.g.
// `import styles from "./Foo.module.css"; styles.bar` type-checks.
declare module "*.module.css" {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}
