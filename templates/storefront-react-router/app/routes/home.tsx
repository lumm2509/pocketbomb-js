import { ProductCard } from "../components/ProductCard";
import { ProductSearch } from "../components/ProductSearch";
import { FEATURED_PRODUCTS } from "../lib/queries";
import type { Route } from "./+types/home";

export function meta() {
  return [{ title: "PocketBomb Storefront" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  // the private storefront client (server-only key + the buyer IP), cached
  const { products } = await context.storefront.query(FEATURED_PRODUCTS);
  return { products };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { products } = loaderData;

  return (
    <>
      <h1>Featured products</h1>
      <p>{products?.totalCount ?? 0} products in the catalog</p>
      <div className="grid featured">
        {products?.nodes.map((product, i) => (
          <ProductCard key={i} product={product} />
        ))}
      </div>
      <ProductSearch />
    </>
  );
}
