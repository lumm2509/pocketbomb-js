// End-to-end smoke test of the application template (Playwright + fuse + the built dashboard):
// `detonator dev` boots (fuse -> import -> app -> install) -> the installation is stored -> the staff member
// signs in to the real dashboard and opens the navigation extension: the app renders INSIDE the dashboard iframe (no
// new tab, the URL stays on the dashboard), no cookies, session token bounce, bearer on the app fetch requests, navigation
// sync + reload, session renewal after 60s (injected clock), record action, frame-src CSP -> the app proxy (signed,
// sandboxed) -> a record create delivers the managed webhook -> a secret rotation is handled -> the uninstall
// is handled, the CSP is back and the old credentials get 401. Also the production build leak check.
//
// Usage: node tests/smoke.ts   (POCKETBOMB_SRC or POCKETBOMB_BIN is required by fuse)
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAdminClient } from "pocketbomb-detonator";
import { SqliteSessionStorage } from "pocketbomb-detonator/session-storage";
import { freePort, signInStaff } from "pocketbomb-fuse/node";
import { chromium, type Browser, type Frame, type Page } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const detonatorBin = path.join(root, "node_modules", ".bin", "detonator");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "app-template-smoke-"));
const dbFile = path.join(tmp, "detonator.sqlite");
const envFile = path.join(tmp, "dev.env");
const HANDLE = "pocketbomb-app";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error("app smoke assertion failed: " + message);
  }
}

function readDir(dir: string): string {
  let result = "";
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) {
      result += fs.readFileSync(path.join(entry.parentPath, entry.name), "utf8") + "\n";
    }
  }
  return result;
}

/** The `detonator dev` output, with waiters for a line matching a pattern. */
class Output {
  text = "";
  private waiters: Array<{
    pattern: RegExp;
    from: number;
    resolve: (m: RegExpMatchArray) => void;
  }> = [];

  push(chunk: string) {
    this.text += chunk;
    for (const w of this.waiters.slice()) {
      const match = this.text.substring(w.from).match(w.pattern);
      if (match) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(match);
      }
    }
  }

  /** Resolves with the first match after the current output (or rejects after the timeout). */
  waitFor(pattern: RegExp, timeout = 60000, from = this.text.length): Promise<RegExpMatchArray> {
    const existing = this.text.substring(from).match(pattern);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timeout waiting for " + pattern + "\n" + this.text)),
        timeout,
      );
      this.waiters.push({
        pattern,
        from,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }
}

const steps: Array<string> = [];
const step = (name: string) => {
  steps.push(name);
  console.log("• " + name);
};

let dev: ChildProcess | null = null;
let browser: Browser | null = null;
const output = new Output();

// the app frame after a click in the dashboard (it never opens a new tab)
async function appFrame(page: Page): Promise<Frame> {
  const handle = await page.waitForSelector("iframe.application-frame", { timeout: 20000 });
  const frame = await handle.contentFrame();
  assert(frame, "the application iframe");
  return frame!;
}

const CSP_BASE =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' http://127.0.0.1:* https://tile.openstreetmap.org data: blob:; connect-src 'self' http://127.0.0.1:* https://nominatim.openstreetmap.org; script-src 'self' http://127.0.0.1:*; frame-ancestors 'none'";

try {
  const port = await freePort("localhost");
  const appUrl = "http://localhost:" + port;

  step("detonator dev (fuse -> import -> app -> install)");
  dev = spawn(
    detonatorBin,
    [
      "dev",
      "--seed",
      "./fuse.seed.ts",
      "--entry",
      "server.ts",
      "--port",
      String(port),
      "--dotenv",
      envFile,
    ],
    { cwd: root, env: { ...process.env, DETONATOR_DB: dbFile }, stdio: ["ignore", "pipe", "pipe"] },
  );
  dev.stdout!.on("data", (c) => output.push(String(c)));
  dev.stderr!.on("data", (c) => output.push(String(c)));

  const ready = await output.waitFor(/Dashboard: (\S+)\/_\/\s+\((\S+) \/ (\S+)\)/, 240000, 0);
  const [, pbUrl, ownerEmail, ownerPassword] = ready;
  await output.waitFor(/\[install\] application\.installed (\w+)/, 10000, 0);

  const env = Object.fromEntries(
    fs
      .readFileSync(envFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => [l.substring(0, l.indexOf("=")), l.substring(l.indexOf("=") + 1)]),
  );
  const issuer = env.POCKETBOMB_ISSUER;
  const installationId = env.POCKETBOMB_INSTALLATION_ID;
  assert(issuer === pbUrl + "/oauth2/_applicationInstallations", "the issuer in the env file");
  assert(!env.POCKETBOMB_CLIENT_SECRET, "the notified credentials are not written to the env file");

  step("the installation is stored (node:sqlite)");
  const storage = new SqliteSessionStorage(dbFile);
  const installation = await storage.loadInstallation(issuer, installationId);
  assert(
    installation && installation.clientSecret && installation.webhookSecret,
    "the stored installation",
  );
  assert(
    installation.handle === HANDLE &&
      installation.scopes.includes("write_orders") &&
      installation.proxyPathPrefix === "/apps/pocketbomb-app",
    "the installation grant",
  );

  step("production build leak check (no secret in the client assets)");
  execFileSync(path.join(root, "node_modules", ".bin", "react-router"), ["build"], {
    cwd: root,
    env: { ...process.env, ...env, POCKETBOMB_CLIENT_SECRET: installation.clientSecret },
    stdio: "pipe",
  });
  const assets = readDir(path.join(root, "build/client"));
  for (const secret of [installation.clientSecret, installation.webhookSecret]) {
    assert(!assets.includes(secret), "a secret value in the client assets");
  }
  for (const marker of [
    "node:sqlite",
    "detonator_installations",
    "client_secret",
    "POCKETBOMB_CLIENT_SECRET",
  ]) {
    assert(!assets.includes(marker), "server-only code in the client assets: " + marker);
  }

  const owner = await signInStaff(pbUrl, ownerEmail, ownerPassword);
  const ownerId = owner.authStore.record!.id;
  const firstOrder = await owner
    .collection("orders")
    .getFirstListItem(owner.filter("title = {:t}", { t: "Order 1" }));

  step("dashboard CSP: frame-src with exactly the app origin");
  const cspBase = CSP_BASE.replace(
    "script-src 'self' http://127.0.0.1:*",
    "script-src 'nonce-X' 'strict-dynamic'",
  );
  const dashboardCSP = async () =>
    ((await fetch(pbUrl + "/_/")).headers.get("content-security-policy") || "").replace(
      /'nonce-[A-Za-z0-9]+'/,
      "'nonce-X'",
    );
  assert(
    (await dashboardCSP()) === cspBase + "; frame-src " + appUrl,
    "the frame-src of the active installation: " + (await dashboardCSP()),
  );

  step("staff signs in to the dashboard: the app renders in the iframe, no new tab");
  browser = await chromium.launch();
  const context = await browser.newContext();
  const dashboard = await context.newPage();
  let newTabs = 0;
  context.on("page", () => newTabs++);
  const sessionTokens: Array<string> = [];
  dashboard.on("request", (r) => {
    if (r.url().endsWith("/session-token")) {
      sessionTokens.push(r.url());
    }
  });
  const frameRequests: Array<{ url: string; authorization: string }> = [];
  dashboard.on("request", async (r) => {
    if (r.url().startsWith(appUrl)) {
      frameRequests.push({
        url: r.url(),
        authorization: (await r.allHeaders()).authorization || "",
      });
    }
  });

  const cspViolations: Array<string> = [];
  dashboard.on("console", (m) => {
    if (m.text().includes("Content Security Policy")) {
      cspViolations.push(m.text());
    }
  });

  await dashboard.goto(pbUrl + "/_/");
  await dashboard.waitForURL(/\/oauth2\/_superusers\/login/);
  await dashboard.fill('form input[name="identity"]', ownerEmail);
  await dashboard.fill('form input[name="password"]', ownerPassword);
  await dashboard.click('form button[type="submit"]:has-text("Sign in")');
  await dashboard.waitForURL(new RegExp("^" + pbUrl + "/_/"));
  await dashboard.goto(pbUrl + "/_/#/applications");

  newTabs = 0;
  const navItem = `.applications-sidebar .application-extension-nav-item[data-application="${HANDLE}"][data-handle="home"]`;
  await dashboard.waitForSelector(navItem, { timeout: 20000 });
  await dashboard.click(navItem);

  const frame = await appFrame(dashboard);
  await frame.waitForSelector("#staff-id", { timeout: 30000 });

  assert(newTabs === 0, "no new tab");
  assert(
    dashboard.url().startsWith(pbUrl + "/_/#/apps/" + HANDLE),
    "the URL stays on the dashboard: " + dashboard.url(),
  );
  assert(frame.url().startsWith(appUrl + "/app"), "the app in the frame: " + frame.url());
  assert(!frame.url().includes("id_token"), "the id_token is stripped: " + frame.url());
  const frameSandbox = await dashboard.getAttribute("iframe.application-frame", "sandbox");
  assert(
    frameSandbox ===
      "allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals",
    "the iframe sandbox: " + frameSandbox,
  );
  assert(
    (await dashboard.getAttribute("iframe.application-frame", "referrerpolicy")) === "no-referrer",
    "the iframe referrer policy",
  );

  assert((await frame.textContent("#staff-id")) === ownerId, "the launching staff member");
  assert(
    (await frame.textContent("#actor-kind")) === "staff",
    "the online token acts as the staff member",
  );
  assert((await frame.textContent("#installation-id")) === installationId, "the installation");
  assert((await frame.textContent("#scopes"))!.includes("read_orders"), "the granted scopes");
  assert(
    (await frame.textContent("#orders-total")) === "3",
    "the orders via the online admin client",
  );
  const permissions = JSON.parse((await frame.textContent("#permissions")) || "{}");
  assert(
    Object.keys(permissions.collections || {}).length === 1,
    "the effective permissions are the staff ∩ grant (orders only): " + JSON.stringify(permissions),
  );
  const pageHTML = await frame.content();
  assert(
    !pageHTML.includes(installation.clientSecret) && !pageHTML.includes(installation.webhookSecret),
    "no secret in the app page",
  );
  assert((await context.cookies(appUrl)).length === 0, "no app cookies");
  const onlineSession = await storage.loadSession(
    issuer +
      "\n" +
      installationId +
      "\n" +
      JSON.parse(
        atob((await frame.evaluate(() => (window as any).detcord.idToken())).split(".")[1]),
      ).sid,
  );
  assert(
    onlineSession && !pageHTML.includes(onlineSession.accessToken),
    "the online token stays server-side",
  );
  assert(
    sessionTokens.length >= 1 && frameRequests.some((r) => r.url.includes("id_token=")),
    "the session token bounce",
  );

  step("the document has the frame-ancestors of the dashboard");
  const documentResponse = await fetch(frame.url(), {
    headers: {
      "sec-fetch-dest": "iframe",
      authorization: "Bearer " + (await frame.evaluate(() => (window as any).detcord.idToken())),
    },
  });
  assert(
    documentResponse.headers.get("content-security-policy") === "frame-ancestors " + pbUrl,
    "the document frame-ancestors: " + documentResponse.headers.get("content-security-policy"),
  );

  step("bearer session token on the app fetch requests");
  const fetched = await frame.evaluate(async () => {
    const res = await fetch("/app/additional.data");
    return res.status;
  });
  assert(fetched === 200, "the same origin fetch with the session token: " + fetched);
  assert(
    frameRequests.some(
      (r) => r.url.includes("/app/additional.data") && r.authorization.startsWith("Bearer "),
    ),
    "the bearer on the app fetch: " + JSON.stringify(frameRequests.slice(-3)),
  );

  step("navigation sync, toast and title bar");
  await frame.click("text=Additional page");
  await frame.waitForSelector("h1:has-text('Additional page')");
  await dashboard.waitForFunction(
    () => location.hash.startsWith("#/apps/pocketbomb-app/app/additional"),
    undefined,
    { timeout: 10000 },
  );

  await frame.evaluate(() => {
    const d = (window as any).detcord;
    d.toast.show("Hello from the app");
    d.titleBar.set("Custom title");
  });
  await dashboard.waitForSelector(".toast:has-text('Hello from the app')");
  await dashboard.waitForSelector(".application-frame-title:has-text('Custom title')");

  step("reload keeps the app at the synced path");
  await dashboard.reload();
  const reloaded = await appFrame(dashboard);
  await reloaded.waitForSelector("h1:has-text('Additional page')", { timeout: 30000 });
  assert(
    reloaded.url().startsWith(appUrl + "/app/additional"),
    "the reloaded path: " + reloaded.url(),
  );
  assert(newTabs === 0, "no new tab after the reload");

  step("back: the iframe history stays in sync with the hash");
  await reloaded.click("text=Home");
  await reloaded.waitForSelector("#staff-id");
  await dashboard.waitForFunction(() => location.hash.startsWith("#/apps/pocketbomb-app/app?"));
  await dashboard.goBack();
  await reloaded.waitForSelector("h1:has-text('Additional page')");
  await dashboard.waitForFunction(() => location.hash.includes("/app/additional"));

  step("session renewal after 60s (injected clock)");
  // note: the clock is per context
  const clockContext = await browser.newContext({ storageState: await context.storageState() });
  const clockPage = await clockContext.newPage();
  const clockTokens: Array<string> = [];
  clockPage.on("request", (r) => {
    if (r.url().endsWith("/session-token")) {
      clockTokens.push(r.url());
    }
  });
  await clockPage.clock.install();
  await clockPage.goto(dashboard.url());
  const renewed = await appFrame(clockPage);
  await renewed.waitForSelector("h1:has-text('Additional page')", { timeout: 30000 });
  const firstToken = await renewed.evaluate(() => (window as any).detcord.idToken());
  await clockPage.clock.fastForward(61000);
  const before = clockTokens.length;
  const secondToken = await renewed.evaluate(() => (window as any).detcord.idToken());
  assert(firstToken !== secondToken, "a renewed session token");
  assert(clockTokens.length === before + 1, "one session token request");
  const renewedFetch = await renewed.evaluate(
    async () => (await fetch("/app/additional.data")).status,
  );
  assert(renewedFetch === 200, "the app fetch after the renewal: " + renewedFetch);
  await clockContext.close();
  step(
    "the built dashboard works with the nonce policy (lazy routes, lazy scripts, no violations)",
  );
  await dashboard.goto(pbUrl + "/_/#/settings/graphql");
  await dashboard.waitForSelector(".graphql-settings-form");
  const lazyScript = await dashboard.evaluate(
    () =>
      new Promise((resolve) => {
        const script = document.createElement("script");
        script.src = "./libs/tinymce/tinymce.min.js";
        script.onload = () => resolve(typeof (window as any).tinymce);
        script.onerror = () => resolve("blocked");
        document.head.appendChild(script);
      }),
  );
  assert(lazyScript === "object", "the lazy tinymce script: " + lazyScript);
  assert(cspViolations.length === 0, "no CSP violations: " + cspViolations.join("; "));

  await dashboard.close();

  step("record action from the record panel");
  const recordPage = await context.newPage();
  await recordPage.goto(pbUrl + `/_/#/collections?collection=orders&record=${firstOrder.id}`);
  const actionSelector = `.application-record-action[data-application="${HANDLE}"][data-handle="order-inspect"]`;
  await recordPage.waitForSelector(actionSelector, { timeout: 20000 });
  await recordPage.click(actionSelector);
  const recordFrame = await appFrame(recordPage);
  await recordFrame.waitForSelector("#record-id", { timeout: 30000 });
  assert(
    recordPage.url().startsWith(pbUrl + "/_/#/apps/" + HANDLE),
    "record action in the dashboard: " + recordPage.url(),
  );
  assert((await recordFrame.textContent("#record-id")) === firstOrder.id, "the launched record");
  assert(
    (await recordFrame.textContent("#record-title")) === "Order 1",
    "the record read with the online token",
  );
  assert(
    (await recordFrame.textContent("#record-extension")) === "order-inspect",
    "the record action extension",
  );
  assert(
    JSON.parse(await recordFrame.evaluate(() => JSON.stringify((window as any).detcord.record)))
      .id === firstOrder.id,
    "detcord.record",
  );

  step("TinyMCE on the built dashboard: full init with its plugins, type, save, no CSP violations");
  const articles = await owner.collections.create({
    name: "articles",
    type: "base",
    fields: [{ name: "body", type: "editor" }],
  });
  const article = await owner.collection("articles").create({ body: "<p>start</p>" });
  const editorPage = await context.newPage();
  const editorViolations: Array<string> = [];
  editorPage.on("console", (m) => {
    if (m.text().includes("Content Security Policy")) {
      editorViolations.push(m.text());
    }
  });
  await editorPage.goto(pbUrl + `/_/#/collections?collection=articles&record=${article.id}`);
  await editorPage.waitForSelector(".tox-tinymce", { timeout: 30000 });
  await editorPage.waitForFunction(
    () => {
      const editor = (window as any).tinymce?.activeEditor;
      return editor?.initialized && editor.getBody()?.textContent?.includes("start");
    },
    undefined,
    { timeout: 30000 },
  );
  const editorPlugins: Array<string> = await editorPage.evaluate(() =>
    Object.keys((window as any).tinymce.activeEditor.plugins),
  );
  for (const plugin of [
    "autolink",
    "code",
    "codesample",
    "image",
    "link",
    "lists",
    "media",
    "table",
  ]) {
    assert(editorPlugins.includes(plugin), "the TinyMCE plugin " + plugin + ": " + editorPlugins);
  }
  await editorPage.frameLocator(".tox-edit-area__iframe").locator("body").click();
  await editorPage.keyboard.press("Control+End");
  await editorPage.keyboard.press("Meta+ArrowDown");
  await editorPage.keyboard.type(" typed in the editor");
  await editorPage.waitForFunction(() =>
    (window as any).tinymce.activeEditor.getContent().includes("typed in the editor"),
  );
  const savedArticle = editorPage.waitForResponse(
    (r) =>
      r.url().includes("/api/collections/articles/records/") && r.request().method() === "PATCH",
  );
  await editorPage.click('.modal button:has-text("Save changes")');
  assert((await savedArticle).status() === 200, "the record save");
  const storedArticle = await owner.collection("articles").getOne(article.id);
  assert(
    String(storedArticle.body).includes("typed in the editor"),
    "the saved body: " + storedArticle.body,
  );
  assert(editorViolations.length === 0, "no CSP violations: " + editorViolations.join("; "));
  await editorPage.close();
  await owner.collections.delete(articles.id);

  step("outside of the iframe: a page linking back to the dashboard");
  const outside = await context.newPage();
  await outside.goto(appUrl + "/app");
  await outside.waitForSelector("#detonator-outside-frame");
  assert(
    (await outside.getAttribute("#detonator-dashboard-link", "href")) ===
      pbUrl + "/_/#/apps/" + HANDLE,
    "the link back to the dashboard",
  );
  await outside.close();

  step("app proxy: signed, verified by the template route and sandboxed");
  const proxied = await fetch(pbUrl + "/apps/pocketbomb-app/hello?a=1");
  assert(proxied.status === 200, "the proxied response: " + proxied.status);
  assert(
    proxied.headers.get("content-security-policy") ===
      "sandbox allow-scripts allow-forms allow-popups",
    "the forced sandbox",
  );
  const proxyData = await proxied.json();
  assert(proxyData.installation === installationId, "the verified installation");
  assert(proxyData.pathPrefix === "/apps/pocketbomb-app", "the path prefix");
  assert(proxyData.path === "/proxy/hello", "the proxied path");
  const forged = await fetch(
    appUrl +
      "/proxy/hello?issuer=" +
      encodeURIComponent(issuer) +
      "&path_prefix=/apps/pocketbomb-app&signature=x",
  );
  assert(forged.status === 401, "a forged proxy request: " + forged.status);

  step("a record create delivers the managed webhook (verified)");
  const created = await owner.collection("orders").create({ title: "Webhook order", total: 99 });
  await output.waitFor(
    new RegExp(`\\[webhook\\] orders\\.create ${created.id} ${installationId}`),
    30000,
    0,
  );

  step("secret rotation -> application.credentials_rotated");
  await owner.applications.rotateSecret(installationId);
  await output.waitFor(/\[install\] application\.credentials_rotated/, 30000, 0);
  const rotated = await storage.loadInstallation(issuer, installationId);
  assert(
    rotated && rotated.clientSecret !== installation.clientSecret,
    "the rotated client secret",
  );
  assert(rotated.webhookSecret !== installation.webhookSecret, "the rotated webhook secret");

  // the rotation ended the online sessions: a new launch works with the new credentials
  await recordPage.reload();
  const rotatedFrame = await appFrame(recordPage);
  await rotatedFrame.waitForSelector("#record-id", { timeout: 30000 });

  step("uninstall -> application.uninstalled and the admin calls 401");
  const offline = createAdminClient({
    url: pbUrl,
    clientId: rotated.clientId,
    clientSecret: rotated.clientSecret,
  });
  await offline.collection("orders").getList(1, 1);

  await owner.applications.uninstall(installationId);
  await output.waitFor(/\[install\] application\.uninstalled/, 30000, 0);
  assert(!(await storage.loadInstallation(issuer, installationId)), "the installation is deleted");

  let status = 0;
  await offline
    .collection("orders")
    .getList(1, 1)
    .catch((err) => (status = err.status));
  assert(status === 401, "the admin calls are rejected after the uninstall: " + status);
  assert(
    (await dashboardCSP()) === cspBase,
    "the CSP without the app origin: " + (await dashboardCSP()),
  );
  assert(
    (await fetch(pbUrl + "/apps/pocketbomb-app/hello")).status === 404,
    "the app proxy after the uninstall",
  );

  step("a just installed app: the loaded dashboard reloads once for its new frame-src");
  const stalePage = await context.newPage();
  await stalePage.goto(pbUrl + "/_/#/settings");
  await stalePage.waitForSelector(".page-application-settings, .page-header");
  const applications = await owner.send("/api/applications", {});
  const application = applications.items.find((a: any) => a.handle === HANDLE);
  const collections = await owner.collections.getFullList({ fields: "id,name" });
  const orders = collections.find((c: any) => c.name === "orders");
  const reinstalled = await owner.applications.install(application.id, {
    collections: { [orders!.id]: ["list", "view"] },
  });
  await stalePage.goto(pbUrl + "/_/#/apps/" + HANDLE);
  await stalePage
    .frameLocator("iframe.application-frame")
    .locator("#staff-id")
    .waitFor({ timeout: 30000 });

  step("detcord through the real package: modal and resize");
  const staleFrame = await appFrame(stalePage);
  await staleFrame.evaluate(() => {
    const d = (window as any).detcord;
    d.modal.open({ id: "m1", title: "Modal title", message: "Modal message" });
    d.resize(640);
  });
  await stalePage.waitForSelector(".application-frame-modal:has-text('Modal message')");
  await stalePage.waitForFunction(
    () =>
      (document.querySelector("iframe.application-frame") as HTMLElement).style.height === "640px",
  );
  await staleFrame.evaluate(() => (window as any).detcord.modal.close());
  await stalePage.waitForSelector(".application-frame-modal", { state: "detached" });

  step("a frame on a different origin is ignored by the dashboard host and by detcord");
  // note: inside of the app frame because the dashboard frame-src (correctly) blocks any other origin
  const rogueServer = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><script>
      window.received = [];
      addEventListener("message", (e) => window.received.push(e.data));
      const msg = (type, extra) => ({ source: "detcord", type, ...extra });
      window.attack = () => {
        for (const target of [window.parent, window.top]) {
          target.postMessage(msg("init", { payload: { record: { collection: "evil", id: "evil" } } }), "*");
          target.postMessage(msg("response", { id: 1, result: { token: "forged", expiresIn: 60 } }), "*");
          target.postMessage(msg("navigation.navigate", { payload: { path: "/evil" } }), "*");
          target.postMessage(msg("idToken", { id: 77 }), "*");
          target.postMessage(msg("hello"), "*");
          target.postMessage(msg("toast.show", { payload: { message: "Rogue toast" } }), "*");
          target.postMessage(msg("session.ended"), "*");
          target.postMessage({ marker: "rogue-done" }, "*");
        }
      };
    </script>`);
  });
  await new Promise<void>((r) => rogueServer.listen(0, "127.0.0.1", r));
  const rogueOrigin = "http://127.0.0.1:" + (rogueServer.address() as any).port;
  assert(rogueOrigin !== pbUrl && rogueOrigin !== appUrl, "a really different origin");

  const seen = () => {
    (window as any).__rogue = new Promise((resolve) => {
      addEventListener("message", (e) => {
        if (e.data?.marker === "rogue-done") {
          resolve(e.origin);
        }
      });
    });
  };
  await stalePage.evaluate(seen);
  await staleFrame.evaluate(seen);
  await staleFrame.evaluate((src) => {
    const rogue = document.createElement("iframe");
    rogue.id = "rogue-frame";
    rogue.src = src;
    document.body.appendChild(rogue);
    return new Promise((resolve) => (rogue.onload = resolve));
  }, rogueOrigin + "/rogue");
  const rogueFrame = await (await staleFrame.waitForSelector("#rogue-frame")).contentFrame();
  const tokenBefore = await staleFrame.evaluate(() => (window as any).detcord.idToken());
  const hashBefore = await stalePage.evaluate(() => location.hash);
  const titleBefore = await staleFrame.evaluate(() => location.href);
  await rogueFrame!.evaluate(() => (window as any).attack());

  // both listeners really got the attack, with the rogue origin
  assert(
    (await stalePage.evaluate(() => (window as any).__rogue)) === rogueOrigin,
    "the host got the rogue messages",
  );
  assert(
    (await staleFrame.evaluate(() => (window as any).__rogue)) === rogueOrigin,
    "detcord got the rogue messages",
  );

  // a real round trip through the host after them
  await staleFrame.evaluate(() => (window as any).detcord.toast.show("After the rogue frame"));
  await stalePage.waitForSelector(".toasts-container :text('After the rogue frame')");
  assert(
    !(await stalePage.$(".toasts-container :text('Rogue toast')")),
    "the host ignored the rogue toast",
  );
  assert(
    !(await stalePage.$(".application-frame-ended")),
    "the host ignored the rogue session end",
  );
  assert(
    (await stalePage.evaluate(() => location.hash)) === hashBefore,
    "the host hash is unchanged",
  );
  assert(
    (await rogueFrame!.evaluate(() => (window as any).received.length)) === 0,
    "no answer to the rogue frame",
  );
  assert(
    (await staleFrame.evaluate(() => (window as any).detcord.idToken())) === tokenBefore,
    "detcord ignored the forged token",
  );
  assert(
    (await staleFrame.evaluate(() => (window as any).detcord.record)) === null,
    "detcord ignored the forged init",
  );
  assert(
    (await staleFrame.evaluate(() => location.href)) === titleBefore,
    "detcord ignored the forged navigation",
  );

  step("a parent on a different origin can't embed the app document (frame-ancestors)");
  const evilPage = await context.newPage();
  await evilPage.goto(rogueOrigin + "/rogue");
  const evilLoaded = evilPage.waitForEvent("console", {
    predicate: (m) => m.text().includes("frame-ancestors"),
    timeout: 15000,
  });
  await evilPage.evaluate(
    (src) => {
      const evilFrame = document.createElement("iframe");
      evilFrame.src = src;
      document.body.appendChild(evilFrame);
    },
    appUrl + "/app?issuer=" + encodeURIComponent(issuer),
  );
  await evilLoaded;
  await evilPage.close();
  await new Promise((r) => rogueServer.close(r));

  step("an ended online session: 401 + reauthorize, one retry, the host shows the ended state");
  const staleSid = async () =>
    JSON.parse(
      atob((await staleFrame.evaluate(() => (window as any).detcord.idToken())).split(".")[1]),
    ).sid;
  const sid = await staleSid();
  const onlineId = issuer + "\n" + reinstalled.installation.id + "\n" + sid;

  // fresh and never exchanged tokens of the same dashboard session (the jti can't be what rejects them)
  const freshToken = () =>
    stalePage.evaluate(
      async ([id]) =>
        (
          await (window as any).app.pb.send(`/api/applications/installations/${id}/session-token`, {
            method: "POST",
            body: { extension: "home" },
            requestKey: null,
          })
        ).sessionToken,
      [reinstalled.installation.id],
    );
  const asData = (token: string) =>
    // note: the index loader uses the online admin client
    fetch(appUrl + "/app.data", {
      headers: { "sec-fetch-dest": "empty", authorization: "Bearer " + token },
    });

  // control: without a stored online session a fresh token exchanges fine while the session is alive
  await storage.deleteSession(onlineId);
  const controlToken = await freshToken();
  assert((await asData(controlToken)).status === 200, "a fresh token before the logout");
  assert(await storage.loadSession(onlineId), "the exchanged online session");

  const unusedToken = await freshToken();
  const appRequests: Array<string> = [];
  stalePage.on("request", (r) => {
    if (r.url().includes("/app/additional.data") || r.url().endsWith("/app.data")) {
      appRequests.push(r.url());
    }
  });

  const dashboardSession = JSON.parse(
    await stalePage.evaluate(() => JSON.stringify((window as any).app.pb.authStore.token)),
  );
  const sessionToEnd = JSON.parse(atob(dashboardSession.split(".")[1])).sid;
  // like the staff logout: the root SSO session with its children
  const childSession = await owner.collection("_authSessions").getOne(sessionToEnd);
  await owner.send("/api/sessions/" + childSession.parent + "/end", { method: "POST" });

  // the logout alone: the token is unused, valid and unexpired
  const afterEnd = await asData(unusedToken);
  assert(afterEnd.status === 401, "a fresh unused token after the session end: " + afterEnd.status);
  assert(afterEnd.headers.get("x-detcord-reauthorize") === "1", "the reauthorize header");
  assert(!(await storage.loadSession(onlineId)), "the stored online session is deleted");

  // the real path, no stubs: the app fetch gets the 401 with exactly one retry and then the
  // dashboard own auth handling takes over (its token was rejected too): the user lands on the login
  const fetchStatus = await staleFrame.evaluate(async () => (await fetch("/app.data")).status);
  assert(fetchStatus === 401, "the app fetch after the end: " + fetchStatus);
  assert(appRequests.length === 2, "exactly one retry: " + appRequests.length);
  await stalePage.waitForURL(/\/oauth2\/_superusers\/login/, { timeout: 30000 });
  await stalePage.waitForSelector('form input[name="identity"]');
  assert(appRequests.length === 2, "no retry loop: " + appRequests.length);

  step(
    "nothing is broken: sign in again and the app opens; ended with a live dashboard -> the ended state",
  );
  await stalePage.fill('form input[name="identity"]', ownerEmail);
  await stalePage.fill('form input[name="password"]', ownerPassword);
  await stalePage.click('form button[type="submit"]:has-text("Sign in")');
  await stalePage.waitForURL(new RegExp("^" + pbUrl + "/_/"));
  await stalePage.goto(pbUrl + "/_/#/apps/" + HANDLE);
  await stalePage
    .frameLocator("iframe.application-frame")
    .locator("#staff-id")
    .waitFor({ timeout: 30000 });
  const liveFrame = await appFrame(stalePage);
  assert(
    (await liveFrame.evaluate(async () => (await fetch("/app.data")).status)) === 200,
    "the app fetch",
  );

  step(
    "a document load with an ended session: thrown 401 -> ErrorBoundary -> the host ended state",
  );
  // a token minted while the session is alive, the stored online session is still there
  const documentToken = await freshToken();
  assert(
    await storage.loadSession(
      issuer +
        "\n" +
        reinstalled.installation.id +
        "\n" +
        JSON.parse(atob(documentToken.split(".")[1])).sid,
    ),
    "the stored online session",
  );
  const liveChild = await owner
    .collection("_authSessions")
    .getOne(JSON.parse(atob(documentToken.split(".")[1])).sid);
  await owner.send("/api/sessions/" + liveChild.parent + "/end", { method: "POST" });
  const documentResponse2 = await liveFrame.goto(appUrl + "/app?id_token=" + documentToken);
  assert(
    documentResponse2!.status() === 401,
    "the document status: " + documentResponse2!.status(),
  );
  assert(
    documentResponse2!.headers()["x-detcord-reauthorize"] === "1",
    "the document reauthorize header",
  );
  // note: the frame is hidden by the host ended state
  await liveFrame.waitForSelector("#detonator-relaunch", { state: "attached" });
  await stalePage.waitForSelector(".application-frame-ended");
  assert(!liveFrame.url().includes("id_token"), "the id_token is stripped: " + liveFrame.url());

  // back to a live dashboard for the next step
  await stalePage.goto(pbUrl + "/_/#/settings");
  await stalePage.reload();
  await stalePage.waitForURL(/\/oauth2\/_superusers\/login/, { timeout: 30000 });
  await stalePage.fill('form input[name="identity"]', ownerEmail);
  await stalePage.fill('form input[name="password"]', ownerPassword);
  await stalePage.click('form button[type="submit"]:has-text("Sign in")');
  await stalePage.waitForURL(new RegExp("^" + pbUrl + "/_/"));
  await stalePage.goto(pbUrl + "/_/#/apps/" + HANDLE);
  await stalePage
    .frameLocator("iframe.application-frame")
    .locator("#staff-id")
    .waitFor({ timeout: 30000 });
  const endedFrame = await appFrame(stalePage);

  step("ended with a live dashboard (uninstall) -> the ended state stays");
  const uninstalledFrom = output.text.length;
  await owner.applications.uninstall(reinstalled.installation.id);
  await output.waitFor(/\[install\] application\.uninstalled/, 30000, uninstalledFrom);

  appRequests.length = 0;
  const liveEnded = await endedFrame.evaluate(async () => (await fetch("/app.data")).status);
  assert(liveEnded === 401, "the app fetch after the uninstall: " + liveEnded);
  assert(appRequests.length === 2, "exactly one retry: " + appRequests.length);
  await stalePage.waitForSelector(".application-frame-ended");
  assert(
    stalePage.url().startsWith(pbUrl + "/_/#/apps/" + HANDLE),
    "the dashboard stays: " + stalePage.url(),
  );
  assert(appRequests.length === 2, "no retry loop: " + appRequests.length);

  storage.close();
  console.log("app smoke OK (" + steps.length + " steps)");
} catch (err) {
  console.error("app smoke failed at step: " + steps[steps.length - 1]);
  console.error("detonator dev output:\n" + output.text);
  throw err;
} finally {
  await browser?.close();
  if (dev && dev.exitCode === null) {
    const exited = new Promise((r) => dev!.once("exit", r));
    dev.kill("SIGTERM");
    await exited;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
