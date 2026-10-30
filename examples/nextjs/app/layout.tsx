import { headers } from "next/headers";
import { AccountButton } from "../components/AccountButton";
import { Providers } from "../components/Providers";
import { browserConfig, customer, requestContext } from "../lib/pocketbomb.server";

export const metadata = { title: "PocketBomb Next.js shop" };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const h = await headers();
  const context = requestContext({ headers: h });
  const account = customer(context, "http://" + (h.get("host") || "localhost"));
  const initialCustomer = account.isLoggedIn() ? account.client.authStore.record : null;
  const config = browserConfig();

  return (
    <html lang="en">
      <body>
        <Providers url={config.url} publicKey={config.publicKey} initialCustomer={initialCustomer}>
          <header>
            <a href="/">Shop</a> · <AccountButton />
          </header>
          <main>{children}</main>
        </Providers>
      </body>
    </html>
  );
}
