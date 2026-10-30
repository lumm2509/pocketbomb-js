// Smoke test of the Next.js example against a real PocketBomb server (fuse):
// next build (+ no private key in the client assets), next start, then HTTP checks:
// server component with the private client, public key props for the client components,
// customer login (hosted page driven headlessly), account page and logout.
//
// Usage: node tests/smoke.ts   (POCKETBOMB_SRC or POCKETBOMB_BIN is required by fuse)
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CookieJar, followHostedFlow, freePort, startFuse, type Fuse } from "pocketbomb-fuse/node";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const next = path.join(root, "node_modules", ".bin", "next");
const seedModule = path.resolve(root, "../../scripts/example-fixtures.ts");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error("nextjs smoke assertion failed: " + message);
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

/** The app cookies of the "browser" (name -> value; cleared by Max-Age=0 or an empty value). */
class AppCookies {
  values = new Map<string, string>();
  store(response: Response) {
    for (const raw of response.headers.getSetCookie()) {
      const pair = raw.split(";")[0];
      const i = pair.indexOf("=");
      const name = pair.substring(0, i);
      const value = pair.substring(i + 1);
      if (!value || /max-age=0/i.test(raw)) this.values.delete(name);
      else this.values.set(name, value);
    }
  }
  header() {
    return Array.from(this.values, ([k, v]) => k + "=" + v).join("; ");
  }
}

let fuse: Fuse | null = null;
let server: ChildProcess | null = null;
let output = "";

try {
  const port = await freePort();
  const appURL = "http://localhost:" + port;

  console.log("• fuse with the example fixtures");
  fuse = await startFuse({ seed: seedModule });
  const env = { ...process.env, ...fuse.env, POCKETBOMB_CLIENT_ID: fuse.env.POCKETBOMB_CLIENT_ID };
  const { POCKETBOMB_PRIVATE_KEY: privateKey, POCKETBOMB_PUBLIC_KEY: publicKey } = fuse.env;

  // the fixtures client registers http://localhost:5173 only: add this app origin
  const owner = await (
    await import("pocketbomb-fuse/node")
  ).signInStaff(fuse.url, fuse.owner.email, fuse.owner.password);
  const client = await owner.oauth2Clients.getFirstListItem(
    owner.filter("clientId = {:id}", { id: fuse.env.POCKETBOMB_CLIENT_ID }),
  );
  await owner.oauth2Clients.update(client.id, {
    redirectURIs: [...client.redirectURIs, appURL + "/account/callback"],
    postLogoutRedirectURIs: [...client.postLogoutRedirectURIs, appURL + "/"],
  });

  console.log("• next build");
  execFileSync(next, ["build"], {
    cwd: root,
    env: { ...env, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: "pipe",
  });

  console.log("• no private key in the client assets");
  const assets = readDir(path.join(root, ".next/static"));
  assert(!assets.includes(privateKey), "the private key value");
  assert(!/pb_sk_[A-Za-z0-9_-]+/.test(assets), "no private key value at all");

  console.log("• next start");
  server = spawn(next, ["start", "-p", String(port), "-H", "localhost"], {
    cwd: root,
    env: { ...env, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout!.on("data", (c) => (output += c));
  server.stderr!.on("data", (c) => (output += c));
  const deadline = Date.now() + 30000;
  for (;;) {
    if (server.exitCode !== null) throw new Error("next start exited:\n" + output);
    try {
      await fetch(appURL + "/", { redirect: "manual" });
      break;
    } catch {
      if (Date.now() > deadline) throw new Error("next start didn't start:\n" + output);
      // poll interval of the startup readiness check
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  console.log("• server component (private client + buyer IP)");
  const home = await fetch(appURL + "/");
  const html = await home.text();
  assert(home.status === 200, "home status " + home.status);
  assert(
    html.includes("3<!-- --> products") || html.includes("3 products"),
    "the total count: " + html.slice(0, 3000),
  );
  for (const t of ["Product 1", "Product 2", "Product 3"]) assert(html.includes(t), t);
  assert(html.includes(publicKey), "the public key is passed to the client components");
  assert(!html.includes(privateKey), "no private key in the page");

  console.log("• customer login (hosted page)");
  const cookies = new AppCookies();
  const login = await fetch(appURL + "/account/login", { redirect: "manual" });
  cookies.store(login);
  assert(login.status === 302, "login redirect");
  assert(cookies.header().includes("shop_session_flow="), "the login flow cookie");

  const jar = new CookieJar();
  const callbackURL = await followHostedFlow(
    login.headers.get("location")!,
    appURL + "/account/callback",
    {
      identity: fuse.env.POCKETBOMB_CUSTOMER_EMAIL,
      password: fuse.env.POCKETBOMB_CUSTOMER_PASSWORD,
    },
    jar,
  );

  const callback = await fetch(callbackURL, {
    redirect: "manual",
    headers: { cookie: cookies.header() },
  });
  cookies.store(callback);
  assert(
    callback.status === 302 && callback.headers.get("location") === "/account",
    "callback redirect",
  );
  const sessionCookie = callback.headers.getSetCookie().find((c) => c.startsWith("shop_session="));
  assert(sessionCookie && /HttpOnly/i.test(sessionCookie), "the httpOnly session cookie");

  const account = await fetch(appURL + "/account", { headers: { cookie: cookies.header() } });
  const accountHTML = await account.text();
  assert(accountHTML.includes(fuse.env.POCKETBOMB_CUSTOMER_EMAIL), "the account email");

  console.log("• logout");
  const logout = await fetch(appURL + "/account/logout", {
    method: "POST",
    redirect: "manual",
    headers: { cookie: cookies.header(), origin: appURL },
  });
  cookies.store(logout);
  assert(
    logout.status === 302 && logout.headers.get("location")!.includes("/oauth2/users/logout?"),
    "logout redirect",
  );
  assert(!cookies.values.has("shop_session"), "the session cookie is cleared");

  const after = await fetch(appURL + "/account", {
    redirect: "manual",
    headers: { cookie: cookies.header() },
  });
  assert(
    after.status === 307 || after.status === 302 || after.status === 303,
    "signed out: " + after.status,
  );

  console.log("nextjs smoke OK");
} catch (err) {
  console.error("next output:\n" + output);
  throw err;
} finally {
  if (server && server.exitCode === null) {
    const exited = new Promise((r) => server!.once("exit", r));
    server.kill("SIGTERM");
    await exited;
  }
  await fuse?.stop();
}
