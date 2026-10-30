import { redirect } from "react-router";
import type { Route } from "./+types/account.logout";

// signs out (POST only): revokes the refresh token, clears the session cookie and
// redirects to the issuer end_session page (RP-initiated logout)
export async function action({ context }: Route.ActionArgs) {
  return context.customer.logoutRedirect();
}

export async function loader() {
  return redirect("/account");
}
