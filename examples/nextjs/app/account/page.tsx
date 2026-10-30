import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { customer, requestContext } from "../../lib/pocketbomb.server";

// the customer account page (the session of the httpOnly cookie)
export default async function AccountPage() {
  const h = await headers();
  const account = customer(requestContext({ headers: h }), "http://" + h.get("host"));
  if (!account.isLoggedIn()) {
    redirect("/account/login");
  }

  const me = await account.me();

  return (
    <>
      <h1>Account</h1>
      <p id="account-email">{me.record?.email}</p>
      <form method="post" action="/account/logout">
        <button type="submit">Sign out</button>
      </form>
    </>
  );
}
