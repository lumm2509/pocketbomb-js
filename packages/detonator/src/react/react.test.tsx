// @vitest-environment happy-dom
import { act } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, assert, describe, test } from "vitest";
import { appContextOf, AppProvider, useApp } from "./index";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function Staff() {
  const app = useApp();
  return (
    <p id="staff">{[app.handle, app.staff.id, app.extension, app.record?.id ?? "-"].join(":")}</p>
  );
}

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
});

describe("AppProvider / useApp", function () {
  const context = {
    staff: { id: "staff1", roles: ["Manager"] },
    installation: {
      id: "inst1",
      issuer: "https://pb/oauth2/_applicationInstallations",
      url: "https://pb",
      scopes: ["read_orders"],
      clientSecret: "never-in-the-browser",
      webhookSecret: "never-either",
    },
    extension: "order-inspect",
    record: { collection: "orders", id: "o1" },
    session: { accessToken: "online-token" },
  };

  test("appContextOf() keeps only the browser-safe fields", function () {
    const app = appContextOf("my-app", context);
    const json = JSON.stringify(app);
    assert.notInclude(json, "never-in-the-browser");
    assert.notInclude(json, "never-either");
    assert.notInclude(json, "online-token");
    assert.deepEqual(app.installation, {
      id: "inst1",
      issuer: "https://pb/oauth2/_applicationInstallations",
      url: "https://pb",
      scopes: ["read_orders"],
    });
    assert.isNull(appContextOf("my-app", { ...context, record: null }).record);
  });

  test("SSR render + hydration", async function () {
    const element = (
      <AppProvider app={appContextOf("my-app", context)}>
        <Staff />
      </AppProvider>
    );
    const html = renderToString(element);
    assert.include(html, "my-app:staff1:order-inspect:o1");

    const container = document.createElement("div");
    container.innerHTML = html;
    const errors: Array<unknown> = [];
    await act(async () => {
      root = hydrateRoot(container, element, { onRecoverableError: (e) => errors.push(e) });
    });
    assert.deepEqual(errors, []);
    assert.equal(container.querySelector("#staff")?.textContent, "my-app:staff1:order-inspect:o1");
  });

  test("useApp() outside the provider throws", function () {
    assert.throws(() => renderToString(<Staff />), /inside an <AppProvider>/);
  });
});
