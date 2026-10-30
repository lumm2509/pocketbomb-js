// Browser page: storefront GraphQL with the public key and the customer account login
// (redirect to the hosted login page, PKCE, callback handled on the same page).
import { createStorefrontClient, flattenConnection } from "@pocketbomb/dynamite";
import { createCustomerAccountClient } from "@pocketbomb/dynamite/customer-account";
import { PRODUCTS } from "./queries.ts";

const url = import.meta.env.VITE_POCKETBOMB_URL || "http://127.0.0.1:8090";
const publicKey = import.meta.env.VITE_POCKETBOMB_PUBLIC_KEY || "";
const clientId = import.meta.env.VITE_POCKETBOMB_CLIENT_ID || "example_shop";
const redirectUri = window.location.origin + "/account/callback";

const storefront = createStorefrontClient({ url, publicKey });
const customer = createCustomerAccountClient({
  url,
  collection: "users",
  clientId,
  redirectUri,
  publicKey,
  scopes: ["openid", "email", "offline_access"],
});

async function renderProducts(): Promise<void> {
  const list = document.querySelector("#products")!;
  const data = await storefront.query(PRODUCTS, { variables: { first: 10 } });

  list.replaceChildren(
    ...flattenConnection(data.products).map((product) => {
      const li = document.createElement("li");
      li.textContent = product.title;
      return li;
    }),
  );
}

async function renderAccount(): Promise<void> {
  const account = document.querySelector("#account")!;
  const login = document.querySelector<HTMLButtonElement>("#login")!;
  const logout = document.querySelector<HTMLButtonElement>("#logout")!;

  if (customer.account.isCallbackURL()) {
    await customer.handleCallback();
    window.history.replaceState(null, "", "/");
  }
  await customer.account.restore();

  const signedIn = customer.isLoggedIn();
  account.textContent = signedIn
    ? "Signed in as " + customer.client.authStore.record?.email
    : "Not signed in";
  login.hidden = signedIn;
  logout.hidden = !signedIn;

  login.onclick = () => void customer.login();
  logout.onclick = () => void customer.logout();
}

renderProducts().catch((err) => console.error("Failed to load the products:", err));
renderAccount().catch((err) => console.error("Failed to load the account:", err));
