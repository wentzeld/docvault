/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Comma-separated list of project slugs to pin at the top of the picker. */
  readonly VITE_DOCVAULT_PINNED_PROJECTS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
