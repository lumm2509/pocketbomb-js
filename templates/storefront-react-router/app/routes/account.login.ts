import { loginOptionsFromURL } from "pocketbomb-dynamite/customer-account";
import type { Route } from "./+types/account.login";

// redirects to the hosted login page (PKCE; the login state is in the httpOnly session cookie)
export async function loader({ request, context }: Route.LoaderArgs) {
  return context.customer.loginRedirect({
    returnTo: "/account",
    ...loginOptionsFromURL(request.url),
  });
}
