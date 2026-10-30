import { detcordScript } from "pocketbomb-detcord";
import { AuthStore, base64Decode, Client } from "pocketbomb-primer";
import {
  applicationInstallationsCollection,
  baseURLFromIssuer,
  createAdminClient,
  exchangeLaunchToken,
} from "../admin";
import {
  ApplicationLaunchTokenType,
  ApplicationSessionTokenType,
  verifyApplicationJWT,
} from "../jwt";
import type { Installation, OnlineSession, SessionStorage } from "../session-storage/types";
import { verifyAppProxySignature } from "../app-proxy";
import { verifyWebhookSignature, WebhookHeaders } from "../webhooks";

/**
 * The application notification events (the `event` claim of the install/uninstall notifications).
 */
export const ApplicationEvents = {
  installed: "application.installed",
  credentialsRotated: "application.credentials_rotated",
  uninstalled: "application.uninstalled",
  appProxyUpdated: "application.app_proxy_updated",
} as const;

export interface DetonatorOptions {
  /**
   * The application URL (its origin hosts the install/uninstall/webhooks/extension routes).
   */
  appUrl: string;

  /**
   * The application handle of the manifest (the `aud` of the install notifications).
   */
  handle: string;

  /**
   * The installations, online sessions and used token ids storage.
   */
  sessionStorage: SessionStorage;

  /**
   * The allowed `_applicationInstallations` issuers (e.g. "https://shop.example.com/oauth2/_applicationInstallations").
   * When not set, any https issuer (or http on a loopback host) is accepted (catalog applications
   * installed by any PocketBomb instance).
   */
  allowedIssuers?: Array<string>;

  /**
   * The manifest scopes (informational; the effective scopes are the installation grant ones).
   */
  scopes?: Array<string>;

  /**
   * A custom application (single instance) installation provided with env variables instead of
   * the install notification: the PocketBomb URL and the installation client credentials.
   */
  url?: string;
  clientId?: string;
  clientSecret?: string;
  webhookSecret?: string;
  installationId?: string;

  /**
   * The JWT clock tolerance in seconds (default to 30).
   */
  clockTolerance?: number;

  /**
   * Optional fetch implementation (JWKS, token endpoint, API).
   */
  fetch?: typeof fetch;
}

export interface InstallContext {
  event: string;
  installation: Installation;
  claims: Record<string, any>;
  /** The 200 response to return to the PocketBomb server. */
  response: Response;
}

export interface WebhookContext {
  /** The delivery topic (`X-PB-Topic`, e.g. "orders.create"). */
  topic: string;
  /**
   * The delivered body (for the record topics `{action, collectionId, collectionName, record}`).
   */
  payload: any;
  /** The event id (`X-PB-Event-Id`; dedupe the at-least-once deliveries with it). */
  eventId: string;
  /** The webhook subscription id (`X-PB-Webhook-Id`). */
  webhookId: string;
  /** The event time (`X-PB-Triggered-At`) and API version (`X-PB-Api-Version`). */
  triggeredAt: string;
  apiVersion: string;
  installation: Installation;
  /** The offline admin client of the installation (client_credentials). */
  admin: Client;
}

export interface AdminContext {
  /** The online admin client (the staff member ∩ the installation grant; no refresh). */
  admin: Client;
  session: OnlineSession;
  staff: OnlineSession["staff"];
  installation: Installation;
  extension: string;
  /** The record of a record action. */
  record: { collection: string; id: string } | null;
}

export interface AppProxyContext {
  installation: Installation;
  /** The signed in customer id (`logged_in_customer_id`; empty for the guests). */
  customerId: string;
  /** The public proxy path of the installation (`path_prefix`). */
  pathPrefix: string;
  /** The offline admin client of the installation (client_credentials). */
  admin: Client;
}

export interface LaunchContext extends AdminContext {
  /**
   * Returns a 303 redirect to the provided location (default to the launched path) with the
   * issuer param, so that a reload doesn't repost the launch and the document gets its session token.
   */
  redirect(location?: string): Response;
}

function textResponse(status: number, body: string, headers: HeadersInit = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...headers },
  });
}

const RELAUNCH_PAGE = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Session expired</title></head>
  <body>
    <h1>Session expired</h1>
    <p id="detonator-relaunch">Your session with this application has expired.
    Open the application again from the PocketBomb dashboard.</p>
  </body>
</html>`;

/**
 * Returns the "open it again from the dashboard" page response.
 */
export function relaunchResponse(): Response {
  return new Response(RELAUNCH_PAGE, {
    status: 401,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

/**
 * The header of a 401 that detcord handles with a new session token and a single retry.
 */
export const ReauthorizeHeader = "X-Detcord-Reauthorize";

/**
 * The page of a document whose online session has ended (a 401 that tells the dashboard about it).
 */
function sessionEndedPage(): Response {
  return new Response(
    `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Session ended</title><script>${detcordScript}</script></head>
  <body>
    <p id="detonator-session-ended">Your session with this application has ended.</p>
    <script>window.detcord.sessionEnded();</script>
  </body>
</html>`,
    {
      status: 401,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        [ReauthorizeHeader]: "1",
      },
    },
  );
}

/**
 * The session token bounce: a document without a token loads detcord, gets
 * a session token from the dashboard and reloads with the `id_token` param.
 */
const BOUNCE_SCRIPT = `
if (window.detcord.embedded) {
  window.detcord.idToken().then(function (token) {
    var url = new URL(window.location.href);
    url.searchParams.set("id_token", token);
    window.location.replace(url.href);
  }, function () {
    document.getElementById("detonator-bounce").textContent = "Open the application from the PocketBomb dashboard.";
    window.detcord.sessionEnded();
  });
} else {
  document.getElementById("detonator-bounce").textContent = "Open the application from the PocketBomb dashboard.";
}`;

function escapeHTML(value: string): string {
  return value.replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");
}

function bounceResponse(headers: HeadersInit): Response {
  const body = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Loading</title><script>${detcordScript}</script></head>
  <body>
    <p id="detonator-bounce">Loading...</p>
    <script>${BOUNCE_SCRIPT}</script>
  </body>
</html>`;

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      ...headers,
    },
  });
}

/**
 * Returns the page of a request outside of the dashboard iframe (with a link back when the dashboard is known).
 */
export function outsideFrameResponse(dashboardURL?: string): Response {
  const link = dashboardURL
    ? `<a id="detonator-dashboard-link" href="${escapeHTML(dashboardURL)}">Open it in the dashboard</a>`
    : "Open it from the PocketBomb dashboard.";

  return new Response(
    `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Open in the dashboard</title></head>
  <body>
    <h1>This application runs inside the PocketBomb dashboard</h1>
    <p id="detonator-outside-frame">${link}</p>
  </body>
</html>`,
    {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    },
  );
}

/**
 * Returns the url without the `id_token` param (e.g. for the application logs).
 */
export function redactIdToken(url: string): string {
  return url.replace(/([?&]id_token=)[^&#]*/g, "$1REDACTED");
}

function decodeSegment(segment: string): Record<string, any> {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64Decode(segment)));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Returns the unverified header and claims of a JWT (to select the issuer and the key).
 */
export function decodeJWT(token: string): {
  header: Record<string, any>;
  claims: Record<string, any>;
} {
  const parts = (token || "").split(".");
  return {
    header: parts.length === 3 ? decodeSegment(parts[0]) : {},
    claims: parts.length === 3 ? decodeSegment(parts[1]) : {},
  };
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    hostname.endsWith(".localhost")
  );
}

/**
 * The PocketBomb Applications server toolkit (like `shopifyApp()`): the install notifications,
 * the managed webhooks, the embedded extensions (online staff sessions) and the offline admin clients.
 */
export function detonator(options: DetonatorOptions) {
  const storage = options.sessionStorage;
  const adminClients = new Map<string, Client>();

  if (!options.handle) {
    throw new Error("detonator() requires the application handle.");
  }

  // the custom application installation of the env credentials (if any)
  const staticInstallation: Installation | null =
    options.url && options.clientId && options.clientSecret
      ? {
          id: options.installationId || "custom",
          issuer: options.url.replace(/\/+$/, "") + "/oauth2/" + applicationInstallationsCollection,
          url: options.url.replace(/\/+$/, ""),
          handle: options.handle,
          clientId: options.clientId,
          clientSecret: options.clientSecret,
          webhookSecret: options.webhookSecret || "",
          scopes: options.scopes || [],
          version: "",
          installedAt: "",
          updatedAt: "",
        }
      : null;

  function isAllowedIssuer(issuer: unknown): issuer is string {
    if (typeof issuer !== "string" || !issuer) {
      return false;
    }

    if (options.allowedIssuers?.length) {
      return options.allowedIssuers.includes(issuer);
    }

    let parsed: URL;
    try {
      parsed = new URL(issuer);
    } catch {
      return false;
    }

    if (!parsed.pathname.endsWith("/oauth2/" + applicationInstallationsCollection)) {
      return false;
    }

    return (
      parsed.protocol === "https:" ||
      (parsed.protocol === "http:" && isLoopbackHost(parsed.hostname))
    );
  }

  async function allInstallations(): Promise<Array<Installation>> {
    const stored = await storage.listInstallations();
    if (
      staticInstallation &&
      !stored.some((i) => i.issuer === staticInstallation.issuer && i.id === staticInstallation.id)
    ) {
      stored.push(staticInstallation);
    }
    return stored;
  }

  async function findInstallation(issuer: string, id: string): Promise<Installation | undefined> {
    const stored = await storage.loadInstallation(issuer, id);
    if (stored) {
      return stored;
    }
    if (
      staticInstallation &&
      staticInstallation.issuer === issuer &&
      staticInstallation.id === id
    ) {
      return staticInstallation;
    }
    return undefined;
  }

  function offlineAdmin(installation: Installation): Client {
    const key = [
      installation.issuer,
      installation.id,
      installation.clientId,
      installation.clientSecret,
    ].join("\n");
    let client = adminClients.get(key);
    if (!client) {
      client = createAdminClient({
        url: installation.url,
        clientId: installation.clientId,
        clientSecret: installation.clientSecret,
        fetch: options.fetch,
      });
      adminClients.set(key, client);
    }
    return client;
  }

  async function verifyNotification(token: string, issuer: string) {
    return verifyApplicationJWT({
      token,
      issuer,
      audience: options.handle,
      clockTolerance: options.clockTolerance,
      fetch: options.fetch as any,
    });
  }

  /**
   * Handles a POST of the install_url/uninstall_url (the signed `application/jwt` notification):
   * application.installed (stores the installation and its secrets), application.credentials_rotated
   * (updates the secrets and ends the online sessions) and application.uninstalled (deletes it).
   *
   * @throws {Response} 401 for an invalid/forged/expired notification, 409 for a replay, 400 otherwise.
   */
  async function install(request: Request): Promise<InstallContext> {
    if (request.method !== "POST") {
      throw textResponse(405, "Method not allowed", { allow: "POST" });
    }

    const token = (await request.text()).trim();
    const { header, claims: unverified } = decodeJWT(token);

    if (header.typ === ApplicationLaunchTokenType) {
      throw textResponse(401, "Not an application notification.");
    }
    if (!isAllowedIssuer(unverified.iss)) {
      throw textResponse(401, "Untrusted issuer.");
    }

    let claims: Record<string, any>;
    try {
      claims = await verifyNotification(token, unverified.iss);
    } catch (err) {
      throw textResponse(401, "Invalid notification: " + (err as Error).message);
    }

    if (typeof claims.jti !== "string" || !claims.jti) {
      throw textResponse(401, "Invalid notification: missing jti.");
    }
    if (!(await storage.markTokenUsed(claims.jti, claims.exp))) {
      throw textResponse(409, "The notification was already processed.");
    }

    const issuer = claims.iss as string;
    const installationId = String(claims.installation_id || "");
    if (!installationId) {
      throw textResponse(400, "Missing installation_id.");
    }

    const now = new Date().toISOString();
    const existing = await storage.loadInstallation(issuer, installationId);

    let installation: Installation;
    switch (claims.event) {
      case ApplicationEvents.installed:
      case ApplicationEvents.credentialsRotated: {
        if (!claims.client_secret || !claims.webhook_secret) {
          throw textResponse(400, "Missing the installation secrets.");
        }

        installation = {
          id: installationId,
          issuer,
          url: baseURLFromIssuer(issuer),
          handle: options.handle,
          clientId: String(claims.client_id || existing?.clientId || ""),
          clientSecret: String(claims.client_secret),
          webhookSecret: String(claims.webhook_secret),
          scopes: Array.isArray(claims.scopes) ? claims.scopes : existing?.scopes || [],
          version: String(claims.version || existing?.version || ""),
          proxyPathPrefix: claims.app_proxy_path_prefix || existing?.proxyPathPrefix,
          installedAt: existing?.installedAt || now,
          updatedAt: now,
        };
        await storage.storeInstallation(installation);

        if (claims.event === ApplicationEvents.credentialsRotated) {
          // the server ended the installation sessions (new token key)
          await storage.deleteSessionsByInstallation(issuer, installationId);
        }
        break;
      }
      case ApplicationEvents.appProxyUpdated: {
        if (!existing) {
          throw textResponse(400, "Unknown installation.");
        }
        installation = {
          ...existing,
          proxyPathPrefix: claims.app_proxy_path_prefix || undefined,
          updatedAt: now,
        };
        await storage.storeInstallation(installation);
        break;
      }
      case ApplicationEvents.uninstalled: {
        installation = existing || {
          id: installationId,
          issuer,
          url: baseURLFromIssuer(issuer),
          handle: options.handle,
          clientId: String(claims.client_id || ""),
          clientSecret: "",
          webhookSecret: "",
          scopes: [],
          version: String(claims.version || ""),
          installedAt: "",
          updatedAt: now,
        };
        await storage.deleteInstallation(issuer, installationId);
        break;
      }
      default:
        throw textResponse(400, "Unsupported notification event " + claims.event + ".");
    }

    return { event: claims.event, installation, claims, response: textResponse(200, "ok") };
  }

  /**
   * Verifies a managed webhook delivery: the installation is identified by the delivery headers
   * (`X-PB-Issuer` + `X-PB-Application-Installation`) and the body signature (`X-PB-Hmac-Sha256`)
   * is verified with the webhook secret of that installation only.
   *
   * @throws {Response} 401 for a missing/unknown installation or an invalid signature.
   */
  async function webhook(request: Request): Promise<WebhookContext> {
    if (request.method !== "POST") {
      throw textResponse(405, "Method not allowed", { allow: "POST" });
    }

    const issuer = request.headers.get(WebhookHeaders.issuer) || "";
    const installationId = request.headers.get(WebhookHeaders.applicationInstallation) || "";
    if (!issuer || !installationId) {
      throw textResponse(401, "Not an application installation webhook.");
    }

    const installation = await findInstallation(issuer, installationId);
    if (!installation || !installation.webhookSecret) {
      throw textResponse(401, "Unknown application installation.");
    }

    const body = await request.text();
    if (
      !(await verifyWebhookSignature({
        secret: installation.webhookSecret,
        body,
        headers: request.headers,
      }))
    ) {
      throw textResponse(401, "Invalid webhook signature.");
    }

    let payload: any;
    try {
      payload = JSON.parse(body);
    } catch {
      throw textResponse(400, "Invalid webhook body.");
    }

    return {
      topic: request.headers.get(WebhookHeaders.topic) || "",
      payload,
      eventId: request.headers.get(WebhookHeaders.eventId) || "",
      webhookId: request.headers.get(WebhookHeaders.webhookId) || "",
      triggeredAt: request.headers.get(WebhookHeaders.triggeredAt) || "",
      apiVersion: request.headers.get(WebhookHeaders.apiVersion) || "",
      installation,
      admin: offlineAdmin(installation),
    };
  }

  /**
   * Finds the installation of a verified-next proxied request by (issuer, path_prefix). An instance
   * has at most one installation of the application, so a single one without that
   * path (env credentials, a missed path notification) is still a candidate of the signature check.
   */
  async function findProxyInstallation(
    issuer: string,
    pathPrefix: string,
  ): Promise<Installation | undefined> {
    const installations = (await allInstallations()).filter((i) => i.issuer === issuer);

    return (
      installations.find((i) => i.proxyPathPrefix === pathPrefix) ||
      (installations.length === 1 ? installations[0] : undefined)
    );
  }

  /**
   * Verifies a request forwarded by the PocketBomb app proxy: the signature over the raw query
   * (see {@link verifyAppProxySignature}), the body hash and the timestamp (±90s).
   *
   * @throws {Response} 401 for an invalid signature, body hash or timestamp and for an unknown installation.
   */
  async function appProxy(request: Request): Promise<AppProxyContext> {
    const query = new URL(request.url).searchParams;
    const issuer = query.get("issuer") || "";
    const pathPrefix = query.get("path_prefix") || "";

    if (!isAllowedIssuer(issuer) || !pathPrefix) {
      throw textResponse(401, "Not an application proxy request.");
    }

    const installation = await findProxyInstallation(issuer, pathPrefix);
    if (!installation || !installation.webhookSecret) {
      throw textResponse(401, "Unknown application installation.");
    }

    const valid = await verifyAppProxySignature({
      secret: installation.webhookSecret,
      query,
      body: await request.clone().arrayBuffer(),
    });
    if (!valid) {
      throw textResponse(401, "Invalid application proxy signature.");
    }

    if (installation.proxyPathPrefix !== pathPrefix) {
      installation.proxyPathPrefix = pathPrefix;
      if (await storage.loadInstallation(issuer, installation.id)) {
        await storage.storeInstallation(installation);
      }
    }

    return {
      installation,
      customerId: query.get("logged_in_customer_id") || "",
      pathPrefix,
      admin: offlineAdmin(installation),
    };
  }

  function onlineSessionId(issuer: string, installationId: string, sid: string): string {
    return issuer + "\n" + installationId + "\n" + sid;
  }

  // the concurrent loaders of a request must not exchange the same token twice (single use jti)
  const exchanges = new Map<string, Promise<OnlineSession>>();

  async function exchangeOnlineSession(
    installation: Installation,
    claims: Record<string, any>,
    token: string,
    sessionToken: boolean,
  ): Promise<OnlineSession> {
    const id = onlineSessionId(installation.issuer, installation.id, String(claims.sid || ""));

    const stored = await storage.loadSession(id);
    if (stored && stored.expiresAt > Math.floor(Date.now() / 1000)) {
      return stored;
    }

    let running = exchanges.get(id);
    if (!running) {
      running = (async () => {
        const online = await exchangeLaunchToken({
          url: installation.url,
          clientId: installation.clientId,
          clientSecret: installation.clientSecret,
          launchToken: token,
          sessionToken,
          fetch: options.fetch,
        });

        const session: OnlineSession = {
          id,
          issuer: installation.issuer,
          installationId: installation.id,
          accessToken: online.authStore.token,
          expiresAt: online.authStore.expiresAt,
          scope: online.authStore.scope,
          staff: {
            id: String(claims.sub),
            roles: online.authStore.meta.associatedUser?.roles || [],
          },
          createdAt: new Date().toISOString(),
        };
        await storage.storeSession(session);

        return session;
      })().finally(() => exchanges.delete(id));
      exchanges.set(id, running);
    }

    try {
      return await running;
    } catch (err) {
      // another process could have exchanged the same token
      const other = await storage.loadSession(id);
      if (other && other.expiresAt > Math.floor(Date.now() / 1000)) {
        return other;
      }
      throw err;
    }
  }

  function onlineAdmin(
    installation: Installation,
    session: OnlineSession,
    request: Request,
  ): Client {
    const store = new AuthStore();
    store.save(session.accessToken, null, {
      scope: session.scope,
      clientId: installation.clientId,
      expiresAt: session.expiresAt,
      associatedUser: session.staff,
    });

    const client = new Client(installation.url, {
      authStore: store,
      fetch: options.fetch,
      autoCancellation: false,
    });

    // the online session has ended (e.g. the staff logged out): liveness is detected on actual API use
    const send = client.send.bind(client);
    client.send = (async (path: string, sendOptions: any) => {
      try {
        return await send(path, sendOptions);
      } catch (err) {
        if ((err as { status?: number })?.status === 401) {
          await storage.deleteSession(session.id);
          throw sessionEndedResponse(request);
        }
        throw err;
      }
    }) as typeof client.send;

    return client;
  }

  function adminContext(
    installation: Installation,
    session: OnlineSession,
    claims: Record<string, any>,
    request: Request,
  ): AdminContext {
    return {
      admin: onlineAdmin(installation, session, request),
      session,
      staff: session.staff,
      installation,
      extension: String(claims.extension || ""),
      record: claims.record
        ? { collection: String(claims.record.collection), id: String(claims.record.id) }
        : null,
    };
  }

  /**
   * Handles an extension launch (the dashboard POSTs the `launch_token` form field to the extension URL
   * in its iframe): verifies the launch token (`typ`, `aud` = the installation client_id, single use)
   * and exchanges it for an online token (the staff member ∩ the installation grant).
   *
   * @throws {Response} 401 (the relaunch page) for an invalid, replayed or unknown installation launch.
   */
  async function launch(request: Request): Promise<LaunchContext> {
    if (request.method !== "POST") {
      throw textResponse(405, "Method not allowed", { allow: "POST" });
    }

    const form = await request.formData();
    const token = String(form.get("launch_token") || "");
    const { claims: unverified } = decodeJWT(token);

    if (!isAllowedIssuer(unverified.iss)) {
      throw relaunchResponse();
    }

    const installation = await findInstallation(
      unverified.iss,
      String(unverified.installation_id || ""),
    );
    if (!installation) {
      throw relaunchResponse();
    }

    let claims: Record<string, any>;
    try {
      claims = await verifyApplicationJWT({
        token,
        issuer: installation.issuer,
        audience: installation.clientId,
        type: ApplicationLaunchTokenType,
        clockTolerance: options.clockTolerance,
        fetch: options.fetch as any,
      });
    } catch {
      throw relaunchResponse();
    }

    if (!(await storage.markTokenUsed(String(claims.jti || ""), claims.exp)) || !claims.jti) {
      throw relaunchResponse();
    }

    let session: OnlineSession;
    try {
      session = await exchangeOnlineSession(installation, claims, token, false);
    } catch {
      throw relaunchResponse();
    }

    const launched = new URL(request.url);
    launched.searchParams.set("issuer", installation.issuer);

    return {
      ...adminContext(installation, session, claims, request),
      redirect(location = launched.pathname + launched.search) {
        return new Response(null, {
          status: 303,
          headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" },
        });
      },
    };
  }

  /** Returns the session token of the request (the Authorization header or the `id_token` param). */
  function requestToken(request: Request): string {
    const authorization = request.headers.get("authorization") || "";
    if (authorization.toLowerCase().startsWith("bearer ")) {
      return authorization.substring(7).trim();
    }
    return new URL(request.url).searchParams.get("id_token") || "";
  }

  async function verifySessionToken(
    token: string,
  ): Promise<{ installation: Installation; claims: Record<string, any> } | null> {
    if (!token) {
      return null;
    }

    const { claims: unverified } = decodeJWT(token);
    if (!isAllowedIssuer(unverified.iss)) {
      return null;
    }

    const installation = await findInstallation(
      unverified.iss,
      String(unverified.installation_id || ""),
    );
    if (!installation) {
      return null;
    }

    try {
      const claims = await verifyApplicationJWT({
        token,
        issuer: installation.issuer,
        audience: installation.clientId,
        type: ApplicationSessionTokenType,
        clockTolerance: options.clockTolerance,
        fetch: options.fetch as any,
      });
      return { installation, claims };
    } catch {
      return null;
    }
  }

  function isDocumentRequest(request: Request): boolean {
    const dest = request.headers.get("sec-fetch-dest");
    if (dest) {
      return dest === "document" || dest === "iframe" || dest === "frame";
    }
    return (
      request.method === "GET" &&
      (request.headers.get("accept") || "").includes("text/html") &&
      !request.headers.get("authorization")
    );
  }

  function isTopLevelRequest(request: Request): boolean {
    return request.headers.get("sec-fetch-dest") === "document";
  }

  /** Returns the issuer of the request `issuer` param, if it is one of the stored installations. */
  async function knownIssuer(request: Request): Promise<string> {
    const issuer = new URL(request.url).searchParams.get("issuer") || "";
    if (!issuer || !isAllowedIssuer(issuer)) {
      return "";
    }

    return (await allInstallations()).some((i) => i.issuer === issuer) ? issuer : "";
  }

  async function dashboardURLFor(request: Request): Promise<string | undefined> {
    let issuer = await knownIssuer(request);
    if (!issuer) {
      const installations = await allInstallations();
      if (installations.length !== 1) {
        return undefined;
      }
      issuer = installations[0].issuer;
    }

    return new URL(issuer).origin + "/_/#/apps/" + encodeURIComponent(options.handle);
  }

  function frameAncestors(issuer: string): Record<string, string> {
    return issuer ? { "content-security-policy": "frame-ancestors " + new URL(issuer).origin } : {};
  }

  function isDataRequest(request: Request): boolean {
    return !isTopLevelRequest(request) && !isDocumentRequest(request);
  }

  /** The 401 of a request whose online session ended (a new token is only retried once by detcord). */
  function sessionEndedResponse(request: Request): Response {
    if (isDataRequest(request)) {
      return textResponse(401, "The online session has ended.", { [ReauthorizeHeader]: "1" });
    }
    return sessionEndedPage();
  }

  /**
   * Returns the response of a request without a valid session token: the outside of an
   * iframe page, the bounce page (documents; once: a rejected `id_token` never bounces
   * again, so it can't loop) or a 401 with the reauthorize header.
   */
  async function missingTokenResponse(request: Request): Promise<Response> {
    if (isTopLevelRequest(request)) {
      return outsideFrameResponse(await dashboardURLFor(request));
    }

    if (isDocumentRequest(request)) {
      if (new URL(request.url).searchParams.has("id_token")) {
        return sessionEndedPage();
      }
      return bounceResponse(frameAncestors(await knownIssuer(request)));
    }

    return sessionEndedResponse(request);
  }

  /**
   * Returns the online admin context of the current request: the session token of the
   * `Authorization: Bearer` header (detcord patches the fetch requests) or of the `id_token` param
   * (after the bounce) is verified with the issuer JWKS; the online session is stored
   * by (installation, staff session) and it is exchanged when it is missing or expired.
   *
   * The returned admin client throws the same 401 `Response` (and deletes the stored online session)
   * when the instance rejects its token.
   *
   * @throws {Response} the bounce page (documents), a 401 with `X-Detcord-Reauthorize` (data requests
   * and ended sessions) or the page linking back to the dashboard (outside of an iframe).
   */
  async function admin(request: Request): Promise<AdminContext> {
    const verified = await verifySessionToken(requestToken(request));
    if (!verified) {
      throw await missingTokenResponse(request);
    }

    const { installation, claims } = verified;

    try {
      const session = await exchangeOnlineSession(
        installation,
        claims,
        requestToken(request),
        true,
      );
      return adminContext(installation, session, claims, request);
    } catch {
      // e.g. the staff logged out or the single use token was already exchanged
      throw sessionEndedResponse(request);
    }
  }

  /**
   * Sets the headers of an application document: `Content-Security-Policy: frame-ancestors {dashboard origin}`
   * from the verified session token or from the `issuer` param validated against the stored
   * installations, and `Referrer-Policy: no-referrer` (the first document has the `id_token` param).
   */
  async function addDocumentResponseHeaders(request: Request, headers: Headers): Promise<void> {
    headers.set("referrer-policy", "no-referrer");

    const verified = await verifySessionToken(requestToken(request));
    const issuer = verified?.installation.issuer || (await knownIssuer(request));
    if (issuer) {
      headers.set("content-security-policy", "frame-ancestors " + new URL(issuer).origin);
    }
  }

  /**
   * Returns the offline admin client of the installation of an instance (client_credentials with
   * auto re-fetch). The issuer may be omitted when there is a single installation.
   *
   * @throws {Error} for a missing (or ambiguous) installation.
   */
  async function unauthenticatedAdmin(
    issuer?: string,
  ): Promise<{ admin: Client; installation: Installation }> {
    const installations = (await allInstallations()).filter((i) => !issuer || i.issuer === issuer);
    if (installations.length !== 1) {
      throw new Error(
        installations.length
          ? "Multiple installations found: pass the issuer."
          : "No installation found" + (issuer ? " for " + issuer : "") + ".",
      );
    }

    return { admin: offlineAdmin(installations[0]), installation: installations[0] };
  }

  /**
   * Handles an extension launch before the app router (a framework middleware/custom server):
   * returns the launch redirect (or the relaunch page) for a POST with the `launch_token` form
   * field and `null` for any other request (the router handles it).
   *
   * The launch is a cross-site form POST from the dashboard: it is authenticated by the signed
   * single use token, so the framework CSRF origin checks don't apply to it.
   */
  async function handleLaunch(request: Request): Promise<Response | null> {
    const type = request.headers.get("content-type") || "";
    if (
      request.method !== "POST" ||
      !(
        type.startsWith("application/x-www-form-urlencoded") ||
        type.startsWith("multipart/form-data")
      )
    ) {
      return null;
    }

    let isLaunch = false;
    try {
      isLaunch = (await request.clone().formData()).has("launch_token");
    } catch {
      isLaunch = false;
    }
    if (!isLaunch) {
      return null;
    }

    try {
      return (await launch(request)).redirect();
    } catch (err) {
      if (err instanceof Response) {
        return err;
      }
      throw err;
    }
  }

  /**
   * Handles the embedded app paths before the app router: the launches (see `handleLaunch`)
   * and the requests without a valid session token or with an ended online session (bounce page,
   * 401 with `X-Detcord-Reauthorize` or the page linking back to the dashboard). Returns `null` for the requests that the router handles.
   */
  async function handleEmbeddedRequest(
    request: Request,
    config: { paths: Array<string> },
  ): Promise<Response | null> {
    const launched = await handleLaunch(request);
    if (launched) {
      return launched;
    }

    const { pathname } = new URL(request.url);
    if (
      !config.paths.some(
        (p) => pathname === p || pathname.startsWith(p + "/") || pathname === p + ".data",
      )
    ) {
      return null;
    }

    const token = requestToken(request);
    const verified = await verifySessionToken(token);
    if (!verified) {
      return missingTokenResponse(request);
    }

    try {
      await exchangeOnlineSession(verified.installation, verified.claims, token, true);
    } catch {
      return sessionEndedResponse(request);
    }

    return null;
  }

  return {
    sessionStorage: storage,
    handleLaunch,
    handleEmbeddedRequest,
    addDocumentResponseHeaders,
    authenticate: { install, webhook, launch, admin, public: { appProxy } },
    unauthenticated: { admin: unauthenticatedAdmin },
    isAllowedIssuer,
  };
}

export type Detonator = ReturnType<typeof detonator>;
