import { DynamiteProvider } from "@pocketbomb/dynamite/react";
import {
  isRouteErrorResponse,
  Link,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteLoaderData,
} from "react-router";
import { AccountMenu } from "./components/AccountMenu";
import type { Route } from "./+types/root";

const CUSTOMER_ROUTES = {
  routes: { login: "/account/login", signup: "/account/signup", logout: "/account/logout" },
};

export async function loader({ context }: Route.LoaderArgs) {
  // the customer of the httpOnly session cookie (a refresh rotation updates the cookie)
  // (an expired access token is refreshed and the cookie updated)
  const token = await context.customer.getAccessToken();
  const customer = token ? context.customer.client.authStore.record : null;

  return { customer };
}

export function Layout({ children }: { children: React.ReactNode }) {
  const data = useRouteLoaderData<typeof loader>("root");
  const customer = data?.customer ?? null;

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {/* the browser storefront client: the public URL/key inlined by the dynamite Vite plugin */}
        <DynamiteProvider
          url={import.meta.env.POCKETBOMB_URL ?? ""}
          publicKey={import.meta.env.POCKETBOMB_PUBLIC_KEY ?? ""}
          customer={CUSTOMER_ROUTES}
          initialCustomer={customer}
        >
          <header>
            <nav>
              <Link to="/">Home</Link> · <Link to="/products">Products</Link> · <AccountMenu />
            </nav>
          </header>
          <main>{children}</main>
        </DynamiteProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const message = isRouteErrorResponse(error)
    ? error.status + " " + error.statusText
    : error instanceof Error
      ? error.message
      : "Unknown error";

  return (
    <section>
      <h1>Something went wrong</h1>
      <p>{message}</p>
    </section>
  );
}
