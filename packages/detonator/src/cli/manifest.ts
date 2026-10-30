import fs from "node:fs";
import { parse } from "smol-toml";

/**
 * A PocketBomb application manifest (`pocketbomb.app.toml`; the snake_case keys of the server
 * manifest format).
 */
export interface AppManifest {
  [key: string]: any;
  handle: string;
  name?: string;
  version?: string;
  application_url?: string;
  install_url?: string;
  uninstall_url?: string;
  access?: { scopes?: Array<string>; optional_scopes?: Array<string> };
  webhooks?: { subscriptions?: Array<{ topics: Array<string>; uri: string }> };
  extensions?: Array<{
    type: string;
    handle: string;
    label: string;
    path: string;
    collection?: string;
  }>;
  app_proxy?: { url: string; prefix: string; subpath: string };
}

/**
 * Reads and parses a TOML manifest file.
 *
 * @throws {Error} for a missing file or an invalid TOML/manifest.
 */
export function loadManifest(file: string): AppManifest {
  const manifest = parse(fs.readFileSync(file, "utf8")) as unknown as AppManifest;
  if (!manifest || typeof manifest.handle !== "string" || !manifest.handle) {
    throw new Error("The manifest " + file + " has no handle.");
  }
  return manifest;
}

function resolveURL(value: string | undefined, base: string): string | undefined {
  if (!value) {
    return value;
  }
  return new URL(value, base).toString();
}

/**
 * Returns a copy of the manifest with the application URL (optionally replaced, e.g. the dev URL)
 * and the install/uninstall/webhook URLs resolved against it (the manifest may use paths).
 *
 * @throws {Error} without an application URL.
 */
export function resolveManifest(manifest: AppManifest, appUrl?: string): AppManifest {
  const result: AppManifest = structuredClone(manifest);
  const base = (appUrl || result.application_url || "").replace(/\/+$/, "");
  if (!base) {
    throw new Error("The manifest has no application_url (pass --app-url).");
  }

  result.application_url = base;
  result.install_url = resolveURL(result.install_url, base + "/");
  result.uninstall_url = resolveURL(result.uninstall_url, base + "/");
  for (const subscription of result.webhooks?.subscriptions || []) {
    subscription.uri = resolveURL(subscription.uri, base + "/")!;
  }

  if (result.app_proxy) {
    result.app_proxy.url = resolveURL(result.app_proxy.url, base + "/")!;
  }

  return result;
}

/**
 * Converts the manifest scopes to an installation grant:
 * read_{c} -> list/view, write_{c} -> list/view/create/update/delete (the collection must exist),
 * system:{read|write}_{resource} -> the resource level, write_app_proxy -> the app proxy resource.
 *
 * @throws {Error} for a scope of a missing collection.
 */
export function scopesToPermissions(
  scopes: Array<string>,
  collections: Array<{ id: string; name: string }>,
): { collections: Record<string, Array<string>>; system: Record<string, string> } {
  const result = {
    collections: {} as Record<string, Array<string>>,
    system: {} as Record<string, string>,
  };

  for (const scope of scopes) {
    if (scope === "write_app_proxy") {
      result.system.app_proxy = "write";
      continue;
    }

    const system = scope.match(/^system:(read|write)_(.+)$/);
    if (system) {
      const [, level, resource] = system;
      if (result.system[resource] !== "write") {
        result.system[resource] = level;
      }
      continue;
    }

    const match = scope.match(/^(read|write)_(.+)$/);
    if (!match) {
      throw new Error("Invalid scope " + scope + ".");
    }

    const [, kind, name] = match;
    const collection = collections.find((c) => c.name === name);
    if (!collection) {
      throw new Error("The scope " + scope + " refers to the missing collection " + name + ".");
    }

    const actions = new Set(result.collections[collection.id] || []);
    actions.add("list").add("view");
    if (kind === "write") {
      actions.add("create").add("update").add("delete");
    }
    result.collections[collection.id] = [...actions];
  }

  return result;
}

/**
 * Deploys (imports) the manifest to a PocketBomb instance (`POST /api/applications/manifests`)
 * with a staff access token that has the applications write permission.
 *
 * @throws {Error} for the API errors.
 */
export async function deployManifest(options: {
  url: string;
  token: string;
  manifest: AppManifest;
  fetch?: typeof fetch;
}): Promise<{ created: boolean; unchanged: boolean; application: any; version: any }> {
  const response = await (options.fetch || fetch)(
    options.url.replace(/\/+$/, "") + "/api/applications/manifests",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: options.token.startsWith("Bearer ")
          ? options.token
          : "Bearer " + options.token,
      },
      body: JSON.stringify(options.manifest),
    },
  );

  let body: any = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    const details = body?.data ? " " + JSON.stringify(body.data) : "";
    throw new Error(
      "The manifest deploy failed (" + response.status + "): " + (body?.message || "") + details,
    );
  }

  return body;
}

/**
 * Serializes env variables (`KEY=value` lines; the values are quoted when needed).
 */
export function formatEnv(values: Record<string, string>): string {
  return (
    Object.entries(values)
      .map(([k, v]) => k + "=" + (/^[\w./:@+-]*$/.test(v) ? v : JSON.stringify(v)))
      .join("\n") + "\n"
  );
}

/**
 * Updates the provided keys of an env file (the other lines are kept, the new keys are appended).
 */
export function updateEnvFile(file: string, values: Record<string, string>): void {
  const lines = fs.existsSync(file)
    ? fs.readFileSync(file, "utf8").replace(/\n+$/, "").split("\n")
    : [];
  const remaining = { ...values };

  const result = lines
    .filter((line) => line !== "" || lines.length > 1)
    .map((line) => {
      const key = line.split("=")[0].trim();
      if (key in remaining) {
        const replaced = formatEnv({ [key]: remaining[key] }).trimEnd();
        delete remaining[key];
        return replaced;
      }
      return line;
    });

  for (const key in remaining) {
    result.push(formatEnv({ [key]: remaining[key] }).trimEnd());
  }

  fs.writeFileSync(file, result.join("\n") + "\n");
}
