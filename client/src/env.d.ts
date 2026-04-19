/// <reference types="vite/client" />

// Extend the Vite import.meta.env typing so missing env vars surface at
// compile time rather than as `undefined` at runtime.
interface ImportMetaEnv {
  readonly VITE_NAKAMA_HOST: string;
  readonly VITE_NAKAMA_PORT: string;
  readonly VITE_NAKAMA_SERVER_KEY: string;
  readonly VITE_NAKAMA_USE_SSL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
