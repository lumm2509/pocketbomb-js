import type { Route } from "./+types/webhooks.orders.create";
import { authenticate } from "../detonator.server";

// the managed webhook of the manifest (HMAC verified with the installation webhook secret)
export async function action({ request }: Route.ActionArgs) {
  const { topic, payload, installation, eventId } = await authenticate.webhook(request);

  // the deliveries are at-least-once: dedupe by eventId for side effects
  console.log(`[webhook] ${topic} ${payload?.record?.id} ${installation.id} ${eventId}`);

  return new Response("ok");
}
