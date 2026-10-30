import { customer, requestContext } from "../../../lib/pocketbomb.server";

// signs out (POST) and redirects to the issuer end_session page
export async function POST(request: Request) {
  const origin = new URL(request.url).origin;
  return customer(requestContext(request), origin).logoutRedirect();
}
