import { readFragment, type FragmentOf } from "pocketbomb-dynamite/graphql";
import { Link } from "react-router";
import { PRODUCT_CARD } from "../lib/queries";

export function ProductCard({ product }: { product: FragmentOf<typeof PRODUCT_CARD> }) {
  const p = readFragment(PRODUCT_CARD, product);

  return (
    <article className="product-card">
      <h3>
        <Link to={"/products/" + p.handle}>{p.title}</Link>
      </h3>
      <p className="price">{p.price ?? "—"} €</p>
    </article>
  );
}
