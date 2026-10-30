// pocketbomb-detonator/react
//
// The React context of a launched application page (like the Shopify AppProvider): the staff member,
// the installation, the launched extension and record, provided from the loader data. SSR-safe.
import { createContext, useContext, type ReactNode } from "react";

/**
 * The browser-safe application context (no token or secret).
 */
export interface AppContextValue {
  /** The application handle. */
  handle: string;
  /** The staff member that launched the application. */
  staff: { id: string; roles: Array<string> };
  /** The installation (no credentials). */
  installation: { id: string; issuer: string; url: string; scopes: Array<string> };
  /** The launched extension handle. */
  extension: string;
  /** The record of a record action launch. */
  record: { collection: string; id: string } | null;
}

const AppContext = createContext<AppContextValue | null>(null);

/**
 * Returns the browser-safe app context of an admin context (`authenticate.admin()` /
 * `authenticate.launch()`), for the loader data of the app pages.
 */
export function appContextOf(
  handle: string,
  context: {
    staff: AppContextValue["staff"];
    installation: { id: string; issuer: string; url: string; scopes: Array<string> };
    extension: string;
    record: AppContextValue["record"];
  },
): AppContextValue {
  return {
    handle,
    staff: { id: context.staff.id, roles: [...context.staff.roles] },
    installation: {
      id: context.installation.id,
      issuer: context.installation.issuer,
      url: context.installation.url,
      scopes: [...context.installation.scopes],
    },
    extension: context.extension,
    record: context.record ? { ...context.record } : null,
  };
}

/**
 * Provides the application context to the app pages.
 */
export function AppProvider({ app, children }: { app: AppContextValue; children?: ReactNode }) {
  return <AppContext.Provider value={app}>{children}</AppContext.Provider>;
}

/**
 * Returns the application context (inside an {@link AppProvider}).
 */
export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) {
    throw new Error("useApp() must be used inside an <AppProvider>.");
  }
  return value;
}
