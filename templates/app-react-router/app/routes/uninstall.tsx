import type { Route } from "./+types/uninstall";
import { authenticate } from "../detonator.server";

// uninstall_url: application.uninstalled (the installation and its sessions are deleted)
export async function action({ request }: Route.ActionArgs) {
  const { event, installation, response } = await authenticate.install(request);
  console.log(`[install] ${event} ${installation.id} ${installation.issuer}`);
  return response;
}
