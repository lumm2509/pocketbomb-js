import type { Route } from "./+types/install";
import { authenticate } from "../detonator.server";

// install_url: application.installed and application.credentials_rotated (signed notifications)
export async function action({ request }: Route.ActionArgs) {
  const { event, installation, response } = await authenticate.install(request);
  console.log(`[install] ${event} ${installation.id} ${installation.issuer}`);
  return response;
}
