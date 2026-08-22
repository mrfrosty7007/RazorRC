/// <reference types="vite/client" />

/**
 * Typed view of the build-time environment.
 *
 * Only `VITE_`-prefixed values reach the browser bundle, which is why the
 * Razorpay and Copilot credentials in `.env` are deliberately *not* listed
 * here: they are read by the Rust process, never by the webview.
 */
interface ImportMetaEnv {
  /** Force the seeded browser dataset even when running inside Tauri. */
  readonly VITE_FORCE_SEED?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
