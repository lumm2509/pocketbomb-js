import { useApp } from "pocketbomb-detonator/react";
import { data, useLoaderData } from "react-router";
import type { Route } from "./+types/app.record";
import { authenticate } from "../detonator.server";

// note: the dashboard record action launch (POST /app/record) is handled by server.ts

export async function loader({ request }: Route.LoaderArgs) {
  const { admin, record } = await authenticate.admin(request);
  if (!record) {
    throw data("This page is opened from a record action.", { status: 400 });
  }

  // the launched record, read with the online token (staff ∩ grant)
  const item = await admin.collection(record.collection).getOne(record.id);

  return {
    record: { collection: record.collection, id: item.id, title: String(item.title ?? "") },
  };
}

export default function RecordPage() {
  const app = useApp();
  const { record } = useLoaderData<typeof loader>();

  return (
    <main>
      <h1>Record action</h1>
      <p>
        <span id="record-collection">{record.collection}</span> /{" "}
        <span id="record-id">{record.id}</span>: <span id="record-title">{record.title}</span>
      </p>
      <p id="record-extension">{app.extension}</p>
    </main>
  );
}
