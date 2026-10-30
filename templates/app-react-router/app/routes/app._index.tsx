import { useApp } from "pocketbomb-detonator/react";
import { useLoaderData } from "react-router";
import type { Route } from "./+types/app._index";
import { authenticate } from "../detonator.server";

export async function loader({ request }: Route.LoaderArgs) {
  const { admin } = await authenticate.admin(request);

  // the effective permissions of the online token: the staff member ∩ the installation grant
  const me = await admin.send("/api/permissions/me", { requestKey: null });
  const orders = await admin.collection("orders").getList(1, 10, { sort: "title" });

  return {
    kind: me.kind as string,
    permissions: me.permissions,
    orders: orders.items.map((o) => ({ id: o.id, title: o.title as string })),
    totalOrders: orders.totalItems,
  };
}

export default function AppIndex() {
  const app = useApp();
  const data = useLoaderData<typeof loader>();

  return (
    <main>
      <h1>PocketBomb app</h1>
      <dl>
        <dt>Staff member</dt>
        <dd id="staff-id">{app.staff.id}</dd>
        <dt>Acting as</dt>
        <dd id="actor-kind">{data.kind}</dd>
        <dt>Installation</dt>
        <dd id="installation-id">{app.installation.id}</dd>
        <dt>Granted scopes</dt>
        <dd id="scopes">{app.installation.scopes.join(", ")}</dd>
        <dt>Effective permissions (staff ∩ grant)</dt>
        <dd id="permissions">{JSON.stringify(data.permissions)}</dd>
      </dl>
      <h2>
        Orders (<span id="orders-total">{data.totalOrders}</span>)
      </h2>
      <ul id="orders">
        {data.orders.map((o) => (
          <li key={o.id}>{o.title}</li>
        ))}
      </ul>
    </main>
  );
}
