import { flattenConnection } from "@pocketbomb/dynamite";
import { headers } from "next/headers";
import { ProductSearch } from "../components/ProductSearch";
import { requestContext, storefront } from "../lib/pocketbomb.server";
import { PRODUCTS } from "../lib/queries";

// a server component: the private storefront client with the end-user IP
export default async function Home() {
  const context = requestContext({ headers: await headers() });
  const data = await storefront(context).query(PRODUCTS, { variables: { first: 10 } });

  return (
    <>
      <h1>Products</h1>
      <p id="total">{data.products?.totalCount ?? 0} products</p>
      <ul className="products">
        {flattenConnection(data.products).map((p) => (
          <li key={p.id}>{p.title}</li>
        ))}
      </ul>
      <ProductSearch />
    </>
  );
}
