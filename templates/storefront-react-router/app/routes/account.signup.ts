import type { Route } from "./+types/account.signup";

// redirects to the hosted signup page (prompt=create)
export async function loader({ context }: Route.LoaderArgs) {
  return context.customer.loginRedirect({ prompt: "create", returnTo: "/account" });
}
