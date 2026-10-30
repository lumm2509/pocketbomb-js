// A browser-side search with the public storefront client (useStorefrontQuery).
import { useStorefront, useStorefrontQuery } from "@pocketbomb/dynamite/react";
import { useState } from "react";
import { PRODUCT_SEARCH } from "../lib/queries";
import { ProductCard } from "./ProductCard";

export function ProductSearch() {
  const storefront = useStorefront();
  const [term, setTerm] = useState("");

  const { data, loading, error } = useStorefrontQuery(PRODUCT_SEARCH, {
    variables: { filter: storefront.client.filter("title ~ {:term}", { term }) },
    skip: term.trim() === "",
  });

  return (
    <section className="search">
      <label>
        Search{" "}
        <input
          name="search"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Product name"
        />
      </label>
      {term && loading && <p>Searching…</p>}
      {error && <p role="alert">{error.message}</p>}
      {term && !loading && data && (
        <div className="search-results">
          {data.products?.nodes.length ? (
            data.products.nodes.map((product, i) => <ProductCard key={i} product={product} />)
          ) : (
            <p>No results</p>
          )}
        </div>
      )}
    </section>
  );
}
