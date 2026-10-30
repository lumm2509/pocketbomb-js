/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The PocketBomb URL of the browser (inlined in the client modules by the dynamite plugin). */
  readonly POCKETBOMB_URL?: string;
  /** The browser-safe public key (inlined in the client modules by the dynamite plugin). */
  readonly POCKETBOMB_PUBLIC_KEY?: string;
}
