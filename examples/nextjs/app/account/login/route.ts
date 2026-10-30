import { customer, requestContext } from "../../../lib/pocketbomb.server";

// redirects to the hosted login page (PKCE; the login state is in the httpOnly session cookie)
export async function GET(request: Request) {
  const origin = new URL(request.url).origin;
  return customer(requestContext(request), origin).loginRedirect({ returnTo: "/account" });
}
