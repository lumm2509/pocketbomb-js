import type { Route } from "./+types/account.callback";

// completes the sign-in (code exchange) and returns to the `returnTo` page
export async function loader({ request, context }: Route.LoaderArgs) {
  return context.customer.callbackRedirect({ url: request.url, successRedirect: "/account" });
}
