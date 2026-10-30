import { useApp } from "pocketbomb-detonator/react";

export default function Additional() {
  const app = useApp();

  return (
    <main>
      <h1>Additional page</h1>
      <p>
        Launched from the <code>{app.extension}</code> extension by <code>{app.staff.id}</code>.
      </p>
    </main>
  );
}
