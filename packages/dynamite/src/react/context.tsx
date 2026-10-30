import type { AccountCallbackResult, AccountLoginOptions, AuthRecord } from "@pocketbomb/primer";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { createStorefrontClient, type StorefrontClient } from "../client/storefront";
import {
  createCustomerAccountClient,
  type CustomerAccountClient,
  type CustomerAccountClientOptions,
} from "../customer-account/customer-account";

/**
 * The customer account of a server rendered app: the account pages are server routes
 * (`loginRedirect()`, `callbackRedirect()`, `logoutRedirect()`) and the customer is
 * provided by the server (`initialCustomer`).
 */
export interface CustomerRoutes {
  login: string;
  signup?: string;
  logout: string;
}

export interface DynamiteProviderProps {
  /** The PocketBomb URL used by the browser (e.g. `import.meta.env.POCKETBOMB_URL`). */
  url: string;

  /** The browser-safe public key. */
  publicKey: string;

  /**
   * The customer account: the account routes of a server rendered app or the options of
   * a browser account client (SPA; `url` and `publicKey` default to the provider ones).
   */
  customer?:
    | { routes: CustomerRoutes }
    | (Omit<CustomerAccountClientOptions, "url" | "requestContext"> & { url?: string });

  /** The signed in customer rendered by the server (SSR). */
  initialCustomer?: AuthRecord;

  /**
   * Navigation function of the account routes (default to `window.location.assign`).
   */
  navigate?: (url: string) => void;

  children?: ReactNode;
}

export interface DynamiteContextValue {
  storefront: StorefrontClient;
  customerClient: CustomerAccountClient | null;
  customerRoutes: CustomerRoutes | null;
  initialCustomer: AuthRecord;
  navigate: (url: string) => void;
}

const DynamiteContext = createContext<DynamiteContextValue | null>(null);

function defaultNavigate(url: string): void {
  window.location.assign(url);
}

/**
 * Provides the browser storefront client (public key) and the customer account to the
 * dynamite hooks and components. SSR-safe (the clients don't access `window` until used).
 */
export function DynamiteProvider(props: DynamiteProviderProps) {
  const { url, publicKey, customer, initialCustomer, navigate, children } = props;

  const clients = useMemo(() => {
    const storefront = createStorefrontClient({ url, publicKey });

    let customerClient: CustomerAccountClient | null = null;
    let customerRoutes: CustomerRoutes | null = null;
    if (customer && "routes" in customer) {
      customerRoutes = customer.routes;
    } else if (customer) {
      customerClient = createCustomerAccountClient({
        publicKey,
        ...customer,
        url: customer.url || url,
      });
    }

    return { storefront, customerClient, customerRoutes };
  }, [url, publicKey, customer]);

  const value = useMemo<DynamiteContextValue>(
    () => ({
      ...clients,
      initialCustomer: initialCustomer ?? null,
      navigate: navigate || defaultNavigate,
    }),
    [clients, initialCustomer, navigate],
  );

  return <DynamiteContext.Provider value={value}>{children}</DynamiteContext.Provider>;
}

/**
 * @internal
 */
export function useDynamiteContext(): DynamiteContextValue {
  const value = useContext(DynamiteContext);
  if (!value) {
    throw new Error("The dynamite hooks must be used inside a <DynamiteProvider>.");
  }
  return value;
}

/**
 * Returns the browser storefront client (public key).
 */
export function useStorefront(): StorefrontClient {
  return useDynamiteContext().storefront;
}

export type { AccountCallbackResult, AccountLoginOptions };
