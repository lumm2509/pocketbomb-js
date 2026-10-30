// The detonator setup of the application (like shopify.server.ts).
import { detonator } from "pocketbomb-detonator/server";
import { SqliteSessionStorage } from "pocketbomb-detonator/session-storage";

const app = detonator({
  appUrl: process.env.APP_URL || "http://localhost:3000",
  handle: process.env.POCKETBOMB_APP_HANDLE || "pocketbomb-app",
  // the installations, online sessions and used token ids (Node.js built-in node:sqlite)
  sessionStorage: new SqliteSessionStorage(process.env.DETONATOR_DB || "detonator.sqlite"),
  // a custom application of a single instance can pin its issuer
  allowedIssuers: process.env.POCKETBOMB_ISSUER ? [process.env.POCKETBOMB_ISSUER] : undefined,
  scopes: process.env.SCOPES?.split(","),
  // a custom application installed without install_url gets its credentials from the env
  url: process.env.POCKETBOMB_URL,
  clientId: process.env.POCKETBOMB_CLIENT_ID,
  clientSecret: process.env.POCKETBOMB_CLIENT_SECRET,
  webhookSecret: process.env.POCKETBOMB_WEBHOOK_SECRET,
  installationId: process.env.POCKETBOMB_INSTALLATION_ID,
});

export default app;
export const authenticate = app.authenticate;
export const unauthenticated = app.unauthenticated;
export const sessionStorage = app.sessionStorage;
export const APP_HANDLE = process.env.POCKETBOMB_APP_HANDLE || "pocketbomb-app";

/**
 * The embedded app paths: the launches (the dashboard POSTs the `launch_token` form in its iframe) and the
 * requests without a session token, handled by server.ts before the router.
 */
export const handleEmbeddedRequest = (request: Request) =>
  app.handleEmbeddedRequest(request, { paths: ["/app"] });

/**
 * The frame-ancestors and referrer policy of the documents.
 */
export const addDocumentResponseHeaders = app.addDocumentResponseHeaders;
