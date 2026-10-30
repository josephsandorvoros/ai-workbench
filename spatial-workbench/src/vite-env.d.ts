/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_COMPAT_API_BASE_URL?: string;
  readonly VITE_DIRECT_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}