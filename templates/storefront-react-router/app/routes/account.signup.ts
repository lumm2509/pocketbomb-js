import { loginOptionsFromURL } from "pocketbomb-dynamite/customer-account";
import type { Route } from "./+types/account.signup";

// redirects to the hosted signup page (prompt=create)
export async function loader({ request, context }: Route.LoaderArgs) {
  return context.customer.loginRedirect({
    returnTo: "/account",
    ...loginOptionsFromURL(request.url),
    prompt: "create",
  });
}
