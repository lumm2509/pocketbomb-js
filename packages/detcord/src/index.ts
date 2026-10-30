// pocketbomb-detcord
//
// The App Bridge of the PocketBomb embedded applications (browser only, no dependencies).
import { installDetcord, type Detcord } from "./runtime";

export type { Detcord, DetcordRecord } from "./runtime";
export { installDetcord };

/**
 * The classic script form of detcord (e.g. inlined in the document head of an SSR app).
 */
export const detcordScript: string = "(" + installDetcord.toString() + ")(window);";

/**
 * Installs detcord in the current browser window (the same instance as `window.detcord`).
 *
 * @throws {Error} outside of a browser.
 */
export function getDetcord(): Detcord {
  if (typeof window === "undefined") {
    throw new Error("detcord works only in a browser.");
  }

  return installDetcord(window);
}

/**
 * The detcord instance of the current browser window (null outside of a browser).
 */
export const detcord: Detcord | null = typeof window === "undefined" ? null : getDetcord();
