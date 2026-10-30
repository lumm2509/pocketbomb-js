// Headless driver of the PocketBomb hosted OAuth2 pages (login, signup, consent and logout
// forms) for the integration suite, the example fixtures and the mobile smoke test.
// It plays the role of the browser (or of the in-app authentication session on mobile).

/**
 * Minimal cookie jar for the hosted pages (name => value; the paths are ignored).
 */
export class CookieJar {
  cookies = new Map<string, string>();

  store(response: Response): void {
    for (const raw of response.headers.getSetCookie()) {
      const [pair, ...attrs] = raw.split(";");
      const idx = pair.indexOf("=");
      const name = pair.substring(0, idx).trim();
      const value = pair.substring(idx + 1).trim();
      const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === "";
      if (expired) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }

  header(): string {
    return Array.from(this.cookies, ([k, v]) => k + "=" + v).join("; ");
  }
}

function inputValue(html: string, name: string): string {
  const match = html.match(new RegExp(`name="${name}"\\s+value="([^"]*)"`));
  return match ? decodeEntities(match[1]) : "";
}

function decodeEntities(v: string): string {
  return v
    .replace(/&#43;/g, "+")
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function formAction(html: string, marker: RegExp): string {
  const forms = html.match(/<form[^>]*action="([^"]+)"[^>]*>[\s\S]*?<\/form>/g) || [];
  for (const f of forms) {
    if (marker.test(f)) {
      return decodeEntities(f.match(/action="([^"]+)"/)![1]);
    }
  }
  return "";
}

/**
 * Follows a hosted OAuth2 flow without a browser (redirects + the password login
 * and consent form posts) until the browser would be redirected to `redirectPrefix`.
 *
 * Returns the final redirect URL (e.g. the authorization response callback URL).
 */
export async function followHostedFlow(
  startURL: string,
  redirectPrefix: string,
  credentials?: { identity: string; password: string },
  jar = new CookieJar(),
): Promise<string> {
  let url = startURL;
  let method = "GET";
  let body: string | undefined;

  for (let step = 0; step < 20; step++) {
    if (url.startsWith(redirectPrefix)) {
      return url;
    }

    const requestHeaders: { [key: string]: string } = { cookie: jar.header() };
    if (method === "POST") {
      requestHeaders["content-type"] = "application/x-www-form-urlencoded";
      requestHeaders["origin"] = new URL(url).origin;
    }

    const init: RequestInit = { method, redirect: "manual", headers: requestHeaders };
    if (method === "POST") {
      init.body = body;
    }

    const response = await fetch(url, init);
    jar.store(response);

    if (response.status >= 300 && response.status < 400) {
      url = new URL(response.headers.get("location")!, url).toString();
      method = "GET";
      body = undefined;
      continue;
    }

    const html = await response.text();
    if (response.status >= 400) {
      throw new Error(`hosted flow failed at ${url} (${response.status}): ${html}`);
    }

    const signupAction = formAction(html, /name="passwordConfirm"/);
    const passwordAction = formAction(html, /name="password"/);
    const consentAction = formAction(html, /name="decision"/);
    const logoutAction = formAction(html, /csrf/);

    let action = "";
    const values = new URLSearchParams();
    if (signupAction && credentials) {
      action = signupAction; // the hosted signup page (prompt=create)
      values.set("email", credentials.identity);
      values.set("password", credentials.password);
      values.set("passwordConfirm", credentials.password);
    } else if (passwordAction && credentials) {
      action = passwordAction;
      values.set("identity", credentials.identity);
      values.set("password", credentials.password);
    } else if (consentAction) {
      action = consentAction;
      values.set("decision", "allow");
    } else if (logoutAction) {
      action = logoutAction; // e.g. the logout confirmation
      for (const name of ["id_token_hint", "post_logout_redirect_uri", "client_id", "state"]) {
        const v = inputValue(html, name);
        if (v) {
          values.set(name, v);
        }
      }
    } else {
      throw new Error(`unexpected hosted page at ${url}: ${html.substring(0, 500)}`);
    }

    const authState = inputValue(html, "auth_state");
    if (authState) {
      values.set("auth_state", authState);
    }
    values.set("csrf", inputValue(html, "csrf"));

    url = new URL(action, url).toString();
    method = "POST";
    body = values.toString();
  }

  throw new Error("too many hosted flow steps");
}
