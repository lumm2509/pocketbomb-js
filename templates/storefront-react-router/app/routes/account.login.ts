import type { Route } from "./+types/account.login";

// redirects to the hosted login page (PKCE; the login state is in the httpOnly session cookie)
export async function loader({ request, context }: Route.LoaderArgs) {
  const returnTo = new URL(request.url).searchParams.get("returnTo") || "/account";
  return context.customer.loginRedirect({ returnTo });
}
