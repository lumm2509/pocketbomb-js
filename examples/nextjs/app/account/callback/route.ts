import { customer, requestContext } from "../../../lib/pocketbomb.server";

// completes the sign-in and returns to the account page
export async function GET(request: Request) {
  const origin = new URL(request.url).origin;
  return customer(requestContext(request), origin).callbackRedirect({
    successRedirect: "/account",
  });
}
