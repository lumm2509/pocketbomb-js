import type { Route } from "./+types/proxy.$";
import { authenticate } from "../detonator.server";

// The app proxy: the instance public /apps/pocketbomb-app/* requests, forwarded and signed by PocketBomb
// (the HTML responses are always sandboxed by the proxy; it has no access to the visitor cookies or tokens).
async function handle(request: Request) {
  const { installation, customerId, pathPrefix } = await authenticate.public.appProxy(request);

  return Response.json({
    installation: installation.id,
    customerId,
    pathPrefix,
    path: new URL(request.url).pathname,
  });
}

export const loader = ({ request }: Route.LoaderArgs) => handle(request);
export const action = ({ request }: Route.ActionArgs) => handle(request);
