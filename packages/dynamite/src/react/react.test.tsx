// @vitest-environment happy-dom
import { AuthStore } from "pocketbomb-primer";
import { act, useState } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, assert, beforeEach, describe, test } from "vitest";
import { gql } from "../graphql/graphql";
import {
  DynamiteProvider,
  FileImage,
  getPaginationURL,
  getPaginationVariables,
  Pagination,
  useCustomer,
  useStorefront,
  useStorefrontQuery,
} from "./index";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const URL_ = "http://pb.local";
const PUBLIC_KEY = "pb_pk_1";

type Product = { id: string; title: string };

let container: HTMLElement;
let root: Root | null = null;
let recoverableErrors: Array<unknown> = [];
const originalFetch = globalThis.fetch;
let requests: Array<{ url: string; body: any }> = [];

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  recoverableErrors = [];
  requests = [];
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  globalThis.fetch = originalFetch;
});

/** Server render, then hydrate the same tree in the "browser". */
async function ssrAndHydrate(element: React.ReactElement): Promise<string> {
  const html = renderToString(element);
  container.innerHTML = html;
  await act(async () => {
    root = hydrateRoot(container, element, {
      onRecoverableError: (err) => recoverableErrors.push(err),
    });
  });
  return html;
}

/** Mocks the GraphQL endpoint (records the requests). */
function mockGraphQL(respond: (body: any) => any) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}"));
    requests.push({ url: String(input), body });
    return new Response(JSON.stringify(respond(body)), { status: 200 });
  }) as typeof fetch;
}

describe("Pagination", function () {
  const connection = {
    nodes: [
      { id: "1", title: "A" },
      { id: "2", title: "B" },
    ],
    pageInfo: { hasNextPage: true, hasPreviousPage: true, startCursor: "S", endCursor: "E" },
  };

  function List(props: { url?: string; conn?: any }) {
    return (
      <Pagination<Product> connection={"conn" in props ? props.conn : connection} url={props.url}>
        {({ nodes, NextLink, PreviousLink, hasNextPage }) => (
          <div>
            <PreviousLink>Prev</PreviousLink>
            <ul>
              {nodes.map((n) => (
                <li key={n.id}>{n.title}</li>
              ))}
            </ul>
            <NextLink className="next">More</NextLink>
            <span data-has-next={String(hasNextPage)} />
          </div>
        )}
      </Pagination>
    );
  }

  test("SSR render + hydration with URL cursor links", async function () {
    const html = await ssrAndHydrate(
      <DynamiteProvider url={URL_} publicKey={PUBLIC_KEY}>
        <List url="/products?sort=title&cursor=old&direction=next" />
      </DynamiteProvider>,
    );

    assert.include(html, "<li>A</li><li>B</li>");
    assert.include(html, 'href="/products?sort=title&amp;cursor=E&amp;direction=next"');
    assert.include(html, 'href="/products?sort=title&amp;cursor=S&amp;direction=previous"');
    assert.deepEqual(recoverableErrors, [], "no hydration mismatch");
    assert.equal(container.querySelector("a.next")?.getAttribute("rel"), "next");
    assert.equal(container.querySelector("a.next")?.textContent, "More");
  });

  test("first/last page and an empty connection", function () {
    const html = renderToString(
      <List
        url="/p"
        conn={{
          nodes: [{ id: "1", title: "A" }],
          pageInfo: { hasNextPage: false, hasPreviousPage: false },
        }}
      />,
    );
    assert.notInclude(html, "<a");
    assert.include(html, 'data-has-next="false"');

    assert.include(renderToString(<List url="/p" conn={null} />), "<ul></ul>");
  });

  test("getPaginationVariables() / getPaginationURL()", function () {
    assert.deepEqual(getPaginationVariables("http://x/p"), { first: 20, after: null });
    assert.deepEqual(getPaginationVariables("/p?cursor=C&direction=next", { pageBy: 5 }), {
      first: 5,
      after: "C",
    });
    assert.deepEqual(getPaginationVariables(new URL("http://x/p?cursor=C&direction=previous")), {
      last: 20,
      before: "C",
    });
    assert.equal(
      getPaginationURL("/p?a=1#top", "C", "previous"),
      "/p?a=1&cursor=C&direction=previous#top",
    );
  });
});

describe("useCustomer", function () {
  function Account() {
    const { customer, isLoggedIn, login, logout, signup } = useCustomer();
    return (
      <div>
        <p id="who">{isLoggedIn ? customer?.email : "guest"}</p>
        <button id="login" onClick={() => void login()}>
          Login
        </button>
        <button id="signup" onClick={() => void signup()}>
          Signup
        </button>
        <button id="logout" onClick={() => void logout()}>
          Logout
        </button>
      </div>
    );
  }

  test("server rendered app: SSR + hydration with the server customer and the account routes", async function () {
    const navigations: Array<string> = [];
    const navigate = (u: string) => navigations.push(u);
    const routes = {
      login: "/account/login",
      signup: "/account/signup",
      logout: "/account/logout",
    };
    const customerOptions = { routes };

    const element = (
      <DynamiteProvider
        url={URL_}
        publicKey={PUBLIC_KEY}
        customer={customerOptions}
        initialCustomer={{ id: "u1", collectionId: "c", collectionName: "users", email: "c@x.y" }}
        navigate={navigate}
      >
        <Account />
      </DynamiteProvider>
    );

    const html = await ssrAndHydrate(element);
    assert.include(html, "c@x.y");
    assert.deepEqual(recoverableErrors, []);
    assert.equal(container.querySelector("#who")?.textContent, "c@x.y");

    await act(async () => (container.querySelector("#logout") as HTMLElement).click());
    await act(async () => (container.querySelector("#login") as HTMLElement).click());
    await act(async () => (container.querySelector("#signup") as HTMLElement).click());
    assert.deepEqual(navigations, ["/account/logout", "/account/login", "/account/signup"]);
  });

  test("server rendered app: the options travel in the account route URLs", async function () {
    const navigations: Array<string> = [];
    let actions: ReturnType<typeof useCustomer> | null = null;
    function Capture() {
      actions = useCustomer();
      return null;
    }

    const render = (routes: { login: string; signup?: string; logout: string }) => (
      <DynamiteProvider
        url={URL_}
        publicKey={PUBLIC_KEY}
        customer={{ routes }}
        navigate={(u: string) => navigations.push(u)}
      >
        <Capture />
      </DynamiteProvider>
    );

    await ssrAndHydrate(
      render({ login: "/account/login", signup: "/account/signup", logout: "/account/logout" }),
    );
    await act(async () => {
      await actions!.login({ returnTo: "/orders?x=1", loginHint: "a@b.c", maxAge: 60 });
      await actions!.signup({ returnTo: "/welcome" });
      await actions!.logout({ postLogoutRedirectUri: "http://shop.local/bye" });
    });
    assert.deepEqual(navigations, [
      "/account/login?returnTo=%2Forders%3Fx%3D1&maxAge=60&loginHint=a%40b.c",
      "/account/signup?returnTo=%2Fwelcome",
      "/account/logout?postLogoutRedirectUri=http%3A%2F%2Fshop.local%2Fbye",
    ]);

    // an option that can't travel in the URL is an error, not silently dropped
    navigations.length = 0;
    let failure: Error | null = null;
    await act(async () => {
      await actions!.login({ scopes: ["openid"] }).catch((err: Error) => (failure = err));
    });
    assert.match(String(failure), /scopes can't be sent through an account route URL/);
    await act(async () => {
      await actions!.logout({ redirect: false }).catch((err: Error) => (failure = err));
    });
    assert.match(String(failure), /redirect can't be sent/);
    assert.deepEqual(navigations, []);
  });

  test("server rendered app without a signup route: the login route with prompt=create", async function () {
    const navigations: Array<string> = [];
    let actions: ReturnType<typeof useCustomer> | null = null;
    function Capture() {
      actions = useCustomer();
      return null;
    }

    await ssrAndHydrate(
      <DynamiteProvider
        url={URL_}
        publicKey={PUBLIC_KEY}
        customer={{ routes: { login: "/in", logout: "/out" } }}
        navigate={(u: string) => navigations.push(u)}
      >
        <Capture />
      </DynamiteProvider>,
    );
    await act(async () => {
      await actions!.signup();
    });
    assert.deepEqual(navigations, ["/in?prompt=create"]);
  });

  test("browser app: hydration-safe, follows the account store and redirects to the hosted login", async function () {
    const navigations: Array<string> = [];
    // the login navigation happens after the PKCE S256 challenge (async WebCrypto digest that
    // resolves outside of React's act() queue): the test waits for the navigation itself
    let navigated: (url: string) => void = () => {};
    const navigation = new Promise<string>((r) => (navigated = r));
    const authStore = new AuthStore();
    const customerOptions = {
      collection: "users",
      clientId: "shop",
      redirectUri: "http://shop.local/callback",
      authStore,
      navigate: (u: string) => {
        navigations.push(u);
        navigated(u);
      },
    };

    const element = (
      <DynamiteProvider url={URL_} publicKey={PUBLIC_KEY} customer={customerOptions}>
        <Account />
      </DynamiteProvider>
    );

    const html = await ssrAndHydrate(element);
    assert.include(html, "guest");
    assert.deepEqual(recoverableErrors, []);

    await act(async () => {
      authStore.save("token", {
        id: "u2",
        collectionId: "c",
        collectionName: "users",
        email: "b@x.y",
      });
    });
    assert.equal(container.querySelector("#who")?.textContent, "b@x.y");

    await act(async () => authStore.clear());
    assert.equal(container.querySelector("#who")?.textContent, "guest");

    await act(async () => {
      (container.querySelector("#login") as HTMLElement).click();
      await navigation;
    });
    assert.lengthOf(navigations, 1);
    const authorize = new URL(navigations[0]);
    assert.equal(authorize.origin + authorize.pathname, URL_ + "/oauth2/users/authorize");
    assert.equal(authorize.searchParams.get("client_id"), "shop");
  });
});

describe("useStorefrontQuery / useStorefront / FileImage", function () {
  const PRODUCTS = gql<{ products: { nodes: Array<Product> } }, { first: number }>(
    "query P($first: Int) { products(first: $first) { nodes { id title } } }",
  );

  /**
   * Records the promises of the storefront queries of the browser client (the hook awaits
   * them first, so awaiting the same promise in act() resumes after the hook's state update).
   */
  let queries: Array<Promise<unknown>> = [];
  const spied = new WeakSet<object>();
  function QuerySpy() {
    const storefront = useStorefront();
    if (!spied.has(storefront)) {
      spied.add(storefront);
      const original = storefront.query.bind(storefront);
      storefront.query = ((...args: Parameters<typeof original>) => {
        const promise = original(...args);
        queries.push(promise);
        return promise;
      }) as typeof storefront.query;
    }
    return null;
  }

  function Products(props: { initial?: any }) {
    const [first, setFirst] = useState(1);
    const { data, loading } = useStorefrontQuery(PRODUCTS, {
      variables: { first },
      initialData: props.initial,
    });
    const text = loading ? "loading" : (data?.products.nodes.map((n) => n.title).join(",") ?? "");

    return (
      <div>
        <p id="state">{text}</p>
        <button id="more" onClick={() => setFirst(2)}>
          More
        </button>
      </div>
    );
  }

  test("the server initial data hydrates without a request; variable changes refetch with the public key", async function () {
    mockGraphQL((body) => ({
      data: {
        products: {
          nodes: Array.from({ length: body.variables.first }, (_, i) => ({
            id: String(i),
            title: "T" + i,
          })),
        },
      },
    }));

    const element = (
      <DynamiteProvider url={URL_} publicKey={PUBLIC_KEY}>
        <QuerySpy />
        <Products initial={{ products: { nodes: [{ id: "0", title: "SSR" }] } }} />
      </DynamiteProvider>
    );

    const html = await ssrAndHydrate(element);
    assert.include(html, "SSR");
    assert.deepEqual(recoverableErrors, []);
    assert.lengthOf(requests, 0, "no request on hydration");

    queries = [];
    await act(async () => {
      (container.querySelector("#more") as HTMLElement).click();
    });
    assert.lengthOf(queries, 1, "the variables change started a query");
    await act(async () => {
      await queries[0];
    });
    assert.equal(container.querySelector("#state")?.textContent, "T0,T1");
    assert.lengthOf(requests, 1);
    assert.equal(requests[0].url, URL_ + "/api/graphql");
    assert.deepEqual(requests[0].body.variables, { first: 2 });
  });

  test("without initial data the query runs on mount", async function () {
    mockGraphQL(() => ({ data: { products: { nodes: [{ id: "1", title: "Mounted" }] } } }));

    const element = (
      <DynamiteProvider url={URL_} publicKey={PUBLIC_KEY}>
        <QuerySpy />
        <Products />
      </DynamiteProvider>
    );
    queries = [];
    const html = await ssrAndHydrate(element);
    assert.include(html, "loading");
    assert.deepEqual(recoverableErrors, []);

    // the query starts on mount (no initial data)
    assert.lengthOf(queries, 1);
    await act(async () => {
      await queries[0];
    });
    assert.lengthOf(requests, 1);
    assert.equal(container.querySelector("#state")?.textContent, "Mounted");
  });

  test("FileImage and useStorefront", function () {
    function Probe() {
      const storefront = useStorefront();
      return <span id="pk">{storefront.getPublicHeaders()["X-PB-Public-Key"]}</span>;
    }

    const html = renderToString(
      <DynamiteProvider url={URL_} publicKey={PUBLIC_KEY}>
        <FileImage
          record={{ id: "r1", collectionName: "products" }}
          filename="a.png"
          thumb="100x100"
          alt="A"
          width={10}
        />
        <FileImage record={{ id: "r1", collectionName: "products" }} filename="" />
        <Probe />
      </DynamiteProvider>,
    );

    assert.include(
      html,
      '<img src="http://pb.local/api/files/products/r1/a.png?thumb=100x100" alt="A" width="10"/>',
    );
    assert.equal((html.match(/<img/g) || []).length, 1);
    assert.include(html, PUBLIC_KEY);

    assert.throws(() => renderToString(<Probe />), /inside a <DynamiteProvider>/);
  });
});
