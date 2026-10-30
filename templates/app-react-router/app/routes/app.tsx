import { appContextOf, AppProvider } from "pocketbomb-detonator/react";
import { useEffect } from "react";
import {
  isRouteErrorResponse,
  Link,
  Outlet,
  useLoaderData,
  useNavigate,
  useRouteError,
} from "react-router";
import type { Route } from "./+types/app";
import { APP_HANDLE, authenticate } from "../detonator.server";

// note: the dashboard navigation extension launch (POST /app) is handled by server.ts

export async function loader({ request }: Route.LoaderArgs) {
  // the online session of the session token (the missing tokens are handled by server.ts)
  const context = await authenticate.admin(request);

  // only the browser-safe fields (no token or secret) are sent to the browser
  return { app: appContextOf(APP_HANDLE, context) };
}

export default function AppLayout() {
  const { app } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  // the dashboard back/forward and detcord.navigation.navigate() go through the router
  useEffect(
    () => (window as any).detcord?.navigation.onChange((path: string) => navigate(path)),
    [navigate],
  );

  return (
    <AppProvider app={app}>
      <nav>
        <Link to="/app">Home</Link> · <Link to="/app/additional">Additional page</Link>
      </nav>
      <Outlet />
    </AppProvider>
  );
}

// the session could end while the page is open (e.g. the staff logged out)
export function ErrorBoundary() {
  const error = useRouteError();
  const ended = isRouteErrorResponse(error) && error.status === 401;

  useEffect(() => {
    if (ended) {
      (window as any).detcord?.sessionEnded();
    }
  }, [ended]);

  if (isRouteErrorResponse(error) && error.status === 401) {
    return (
      <main>
        <h1>Session expired</h1>
        <p id="detonator-relaunch">Open the application again from the PocketBomb dashboard.</p>
      </main>
    );
  }
  throw error;
}
