// End-to-end smoke test of the storefront template against a real PocketBomb server (fuse):
// production build (+ no private key in the client assets), server.ts, then Playwright:
// browse, search (browser public client), paginate, product page, login via the hosted page,
// account (own sessions), logout.
//
// Usage: node tests/smoke.ts   (POCKETBOMB_SRC or POCKETBOMB_BIN is required by fuse)
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, startFuse, type Fuse } from "@pocketbomb/fuse/node";
import { chromium, type Browser, type Page } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = (name: string) => path.join(root, "node_modules", ".bin", name);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error("smoke assertion failed: " + message);
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

async function waitForServer(url: string, server: ChildProcess, output: () => string) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error("server.ts exited early:\n" + output());
    }
    try {
      const res = await fetch(url, { redirect: "manual" });
      if (res.status < 500) {
        return;
      }
    } catch {
      // not listening yet
    }
    // poll interval of the startup readiness check
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server.ts didn't start:\n" + output());
}

async function productTitles(page: Page, selector: string): Promise<Array<string>> {
  return page.locator(selector + " .product-card h3").allTextContents();
}

const steps: Array<string> = [];
const navigations: Array<string> = [];
const step = (name: string) => {
  steps.push(name);
  console.log("• " + name);
};

let fuse: Fuse | null = null;
let server: ChildProcess | null = null;
let browser: Browser | null = null;
let serverOutput = "";

try {
  const port = await freePort();
  const appURL = "http://localhost:" + port;
  process.env.APP_URL = appURL;

  step("fuse with the template seed");
  fuse = await startFuse({ seed: path.join(root, "fuse.seed.ts") });
  const env = { ...process.env, ...fuse.env };
  const privateKey = fuse.env.POCKETBOMB_PRIVATE_KEY;
  const publicKey = fuse.env.POCKETBOMB_PUBLIC_KEY;
  assert(privateKey && publicKey, "the seed keys");

  step("production build");
  execFileSync(bin("react-router"), ["build"], { cwd: root, env, stdio: "pipe" });

  step("no private key in the client assets");
  const clientAssets = readDir(path.join(root, "build/client"));
  assert(clientAssets.includes(publicKey), "the public key is inlined in the client bundle");
  assert(!clientAssets.includes(privateKey), "the private key value is not in the client assets");
  // (the "X-PB-Private-Key" header name is part of the primer transport; no header value may be)
  assert(!/pb_sk_[A-Za-z0-9_-]+/.test(clientAssets), "no private key value at all (pb_sk_...)");
  assert(!clientAssets.includes("POCKETBOMB_PRIVATE_KEY"), "no private key env reference");

  step("server.ts (production)");
  server = spawn(process.execPath, ["server.ts"], {
    cwd: root,
    env: { ...env, NODE_ENV: "production", PORT: String(port), HOST: "localhost" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout!.on("data", (c) => (serverOutput += c));
  server.stderr!.on("data", (c) => (serverOutput += c));
  await waitForServer(appURL + "/", server, () => serverOutput);

  browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("requestfailed", (req) =>
    navigations.push("FAILED " + req.url() + " " + req.failure()?.errorText),
  );
  page.on("response", (res) => {
    if (res.request().isNavigationRequest()) navigations.push(res.status() + " " + res.url());
  });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations.push(frame.url());
  });

  const browserApiRequests: Array<{ url: string; key: string | undefined }> = [];
  page.on("request", (req) => {
    if (req.url().startsWith(fuse!.url + "/api/")) {
      browserApiRequests.push({ url: req.url(), key: req.headers()["x-pb-public-key"] });
    }
  });

  step("home: featured products (server private client)");
  await page.goto(appURL + "/");
  await page.waitForSelector("h1:has-text('Featured products')");
  const featured = await productTitles(page, ".featured");
  assert(
    JSON.stringify(featured) === JSON.stringify(["Product 10", "Product 09", "Product 08"]),
    "featured: " + featured,
  );
  assert(await page.isVisible("text=10 products in the catalog"), "total count");
  assert(browserApiRequests.length === 0, "the SSR page needs no browser API request");

  step("search (browser public client)");
  await page.fill("input[name=search]", "Product 0");
  await page.waitForSelector(".search-results .product-card");
  const found = await productTitles(page, ".search-results");
  assert(found.length === 5 && found[0] === "Product 01", "search results: " + found);
  assert(browserApiRequests.length > 0, "the browser queried the GraphQL API");
  assert(
    browserApiRequests.every((r) => r.url === fuse!.url + "/api/graphql" && r.key === publicKey),
    "the browser requests use the public key",
  );

  step("pagination (URL cursors)");
  await page.goto(appURL + "/products");
  let titles = await productTitles(page, ".products");
  assert(titles.join(",") === "Product 01,Product 02,Product 03,Product 04", "page 1: " + titles);
  assert(!(await page.isVisible("a.previous")), "no previous link on the first page");

  await page.click("a.next");
  await page.waitForURL(/cursor=.*direction=next/);
  await page.waitForSelector(".products .product-card h3:has-text('Product 05')");
  titles = await productTitles(page, ".products");
  assert(titles.join(",") === "Product 05,Product 06,Product 07,Product 08", "page 2: " + titles);

  await page.click("a.next");
  await page.waitForSelector(".products .product-card h3:has-text('Product 09')");
  titles = await productTitles(page, ".products");
  assert(titles.join(",") === "Product 09,Product 10", "page 3: " + titles);
  assert(!(await page.isVisible("a.next")), "no next link on the last page");

  await page.click("a.previous");
  await page.waitForURL(/direction=previous/);
  await page.waitForSelector(".products .product-card h3:has-text('Product 05')");
  titles = await productTitles(page, ".products");
  assert(
    titles.join(",") === "Product 05,Product 06,Product 07,Product 08",
    "back to page 2: " + titles,
  );

  step("product page");
  await page.click("text=Product 06");
  await page.waitForURL(appURL + "/products/product-06");
  await page.waitForSelector("h1:has-text('Product 06')");
  assert(await page.isVisible("text=60 €"), "the product price");

  step("login via the hosted page");
  await page.click("button.login");
  await page.waitForURL(new RegExp("^" + fuse.url + "/oauth2/users/login"));
  await page.fill('form input[name="identity"]', fuse.env.DEMO_CUSTOMER_EMAIL);
  await page.fill('form input[name="password"]', fuse.env.DEMO_CUSTOMER_PASSWORD);
  await page.click('form button[type="submit"]:has-text("Sign in")');
  await page.waitForURL(appURL + "/account");
  await page.waitForSelector("#account-email");
  assert(
    (await page.textContent("#account-email")) === fuse.env.DEMO_CUSTOMER_EMAIL,
    "the account email",
  );
  assert(await page.isVisible(".sessions li:has-text('(current)')"), "the current session listed");
  assert(
    (await page.textContent("a.account-link")) === fuse.env.DEMO_CUSTOMER_EMAIL,
    "the header customer (useCustomer)",
  );

  const session = (await context.cookies(appURL)).find((c) => c.name === "storefront_session");
  assert(session && session.httpOnly, "the httpOnly session cookie");
  assert(!session.value.includes(privateKey), "no secret in the session cookie");

  step("logout");
  await page.click("button:has-text('Sign out')");
  await page.waitForURL((url) => url.href === appURL + "/" || url.href.startsWith(fuse!.url));
  if (page.url().startsWith(fuse.url)) {
    // the issuer logout confirmation page (if any)
    await page.click('form button[type="submit"]');
    await page.waitForURL(appURL + "/");
  }
  await page.waitForSelector("button.login");
  const after = (await context.cookies(appURL)).find((c) => c.name === "storefront_session");
  assert(!after || !after.value, "the session cookie is cleared");

  await page.goto(appURL + "/account");
  await page.waitForURL(new RegExp("^" + fuse.url + "/oauth2/users/login"));

  console.log("storefront smoke OK (" + steps.length + " steps)");
} catch (err) {
  console.error("smoke failed at step: " + steps[steps.length - 1]);
  console.error("server.ts output:\n" + serverOutput);
  console.error("navigations:\n" + navigations.join("\n"));
  throw err;
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    const exited = new Promise((r) => server!.once("exit", r));
    server.kill("SIGTERM");
    await exited;
  }
  await fuse?.stop();
}
