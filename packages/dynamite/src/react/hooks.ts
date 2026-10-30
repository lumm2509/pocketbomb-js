import type {
  AccountCallbackResult,
  AccountLoginOptions,
  AccountLogoutOptions,
  AuthRecord,
} from "@pocketbomb/primer";
import { useCallback, useEffect, useRef, useState } from "react";
import type { StorefrontQueryOptions } from "../client/storefront";
import type { DocumentInput, ResultOf, VariablesOf } from "../graphql/graphql";
import { useDynamiteContext } from "./context";

export interface CustomerState {
  /** The signed in customer record (null if signed out). */
  customer: AuthRecord;
  isLoggedIn: boolean;
  /** Whether a login/logout/restore is in progress. */
  loading: boolean;
  /** The last account error (e.g. a failed callback). */
  error: Error | null;
  /** Starts the login (server route navigation, browser redirect or mobile auth session). */
  login(options?: AccountLoginOptions): Promise<AccountCallbackResult | null>;
  /** Starts the signup (`prompt=create`). */
  signup(options?: Omit<AccountLoginOptions, "prompt">): Promise<AccountCallbackResult | null>;
  /** Signs out (server route navigation or the account logout). */
  logout(options?: AccountLogoutOptions): Promise<void>;
}

/**
 * Returns the customer account state and actions.
 *
 * - server rendered apps (`customer.routes`): the customer comes from `initialCustomer` and
 *   the actions navigate to the account routes
 * - browser apps (customer client options): the state follows the account auth store; on
 *   mount the session is restored and a pending authorization response is handled
 */
export function useCustomer(): CustomerState {
  const { customerClient, customerRoutes, initialCustomer, navigate } = useDynamiteContext();

  // the first render always uses the server value (hydration safe); the browser account
  // store state is applied by the effect
  const [customer, setCustomer] = useState<AuthRecord>(initialCustomer);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!customerClient) {
      setCustomer(initialCustomer);
      return;
    }

    const store = customerClient.client.authStore;
    const unsubscribe = store.onChange((_, record) => setCustomer(record), true);

    let active = true;
    setLoading(true);
    (async () => {
      if (customerClient.account.isCallbackURL()) {
        await customerClient.handleCallback();
      }
      await customerClient.account.restore();
    })()
      .catch((err) => active && setError(err))
      .finally(() => active && setLoading(false));

    return () => {
      active = false;
      unsubscribe();
    };
  }, [customerClient, initialCustomer]);

  const run = useCallback(async <T>(fn: () => Promise<T>): Promise<T> => {
    setLoading(true);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(err as Error);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const login = useCallback(
    (options?: AccountLoginOptions) =>
      run(async () => {
        if (customerRoutes) {
          navigate(customerRoutes.login);
          return null;
        }
        return customerClient ? customerClient.login(options) : null;
      }),
    [run, customerRoutes, customerClient, navigate],
  );

  const signup = useCallback(
    (options?: Omit<AccountLoginOptions, "prompt">) =>
      run(async () => {
        if (customerRoutes) {
          navigate(customerRoutes.signup || customerRoutes.login);
          return null;
        }
        return customerClient ? customerClient.signup(options) : null;
      }),
    [run, customerRoutes, customerClient, navigate],
  );

  const logout = useCallback(
    (options?: AccountLogoutOptions) =>
      run(async () => {
        if (customerRoutes) {
          navigate(customerRoutes.logout);
          return;
        }
        await customerClient?.logout(options);
      }),
    [run, customerRoutes, customerClient, navigate],
  );

  return {
    customer,
    isLoggedIn: !!customer,
    loading,
    error,
    login,
    signup,
    logout,
  };
}

export interface UseStorefrontQueryOptions<
  Doc extends DocumentInput,
> extends StorefrontQueryOptions<VariablesOf<Doc>> {
  /** The data rendered by the server (no request on mount). */
  initialData?: ResultOf<Doc>;
  /** Skip the request. */
  skip?: boolean;
}

export interface StorefrontQueryState<Data> {
  data: Data | undefined;
  error: Error | null;
  loading: boolean;
  refetch(): Promise<void>;
}

/**
 * Runs a storefront GraphQL query in the browser (public key) and re-runs it when the
 * variables change. The server rendered `initialData` is used for the first render.
 */
export function useStorefrontQuery<Doc extends DocumentInput>(
  document: Doc,
  options: UseStorefrontQueryOptions<Doc> = {},
): StorefrontQueryState<ResultOf<Doc>> {
  const storefront = useDynamiteContext().storefront;
  const { initialData, skip, ...queryOptions } = options;

  const variablesKey = JSON.stringify(queryOptions.variables ?? null);
  const [data, setData] = useState<ResultOf<Doc> | undefined>(initialData);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(!skip && initialData === undefined);

  // the initial data matches the initial variables (no refetch on hydration)
  const fetchedKey = useRef<string | null>(initialData !== undefined ? variablesKey : null);
  const optionsRef = useRef(queryOptions);
  optionsRef.current = queryOptions;

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await storefront.query(document, optionsRef.current));
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, [storefront, document]);

  useEffect(() => {
    if (skip || fetchedKey.current === variablesKey) {
      return;
    }
    fetchedKey.current = variablesKey;
    void fetchData();
  }, [skip, variablesKey, fetchData]);

  return { data, error, loading, refetch: fetchData };
}
