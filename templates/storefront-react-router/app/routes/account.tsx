import type { AccountSessionModel } from "@pocketbomb/primer";
import { Form, redirect } from "react-router";
import type { Route } from "./+types/account";

export function meta() {
  return [{ title: "Account" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  if (!(await context.customer.getAccessToken())) {
    throw redirect("/account/login?returnTo=/account");
  }

  const [me, sessions] = await Promise.all([
    context.customer.me(),
    context.customer.account.sessions.list(),
  ]);

  return { customer: me.record, sessions };
}

export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData();
  const id = String(form.get("session") || "");
  if (id) {
    await context.customer.account.sessions.end(id);
  }
  return redirect("/account");
}

function SessionRow({ session }: { session: AccountSessionModel }) {
  return (
    <li>
      {session.sso ? "Browser session" : session.clientName || session.clientId}
      {session.current ? " (current)" : ""} · {session.ip} · last used {session.lastUsedAt}
      {!session.current && (
        <Form method="post" style={{ display: "inline" }}>
          <input type="hidden" name="session" value={session.id} />
          <button type="submit">End</button>
        </Form>
      )}
    </li>
  );
}

export default function Account({ loaderData }: Route.ComponentProps) {
  const { customer, sessions } = loaderData;

  return (
    <>
      <h1>Account</h1>
      <p id="account-email">{customer?.email}</p>
      <h2>Sessions</h2>
      <ul className="sessions">
        {sessions.map((s) => (
          <SessionRow key={s.id} session={s} />
        ))}
      </ul>
      <Form method="post" action="/account/logout">
        <button type="submit">Sign out</button>
      </Form>
    </>
  );
}
