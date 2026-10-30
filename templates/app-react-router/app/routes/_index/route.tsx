export function meta() {
  return [{ title: "PocketBomb app" }];
}

// the public landing page (the app pages are launched from the PocketBomb dashboard)
export default function Index() {
  return (
    <main>
      <h1>PocketBomb app</h1>
      <p>Install the application in a PocketBomb instance and open it from the dashboard.</p>
    </main>
  );
}
