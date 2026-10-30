"use client";

// a client component with the browser public storefront client
import { useStorefront, useStorefrontQuery } from "pocketbomb-dynamite/react";
import { useState } from "react";
import { PRODUCTS } from "../lib/queries";

export function ProductSearch() {
  const storefront = useStorefront();
  const [term, setTerm] = useState("");
  const { data, loading } = useStorefrontQuery(PRODUCTS, {
    variables: { first: 5, filter: storefront.client.filter("title ~ {:term}", { term }) },
    skip: !term,
  });

  return (
    <section>
      <input
        name="search"
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        placeholder="Search"
      />
      {term && !loading && (
        <ul className="search-results">
          {data?.products?.nodes.map((p) => (
            <li key={p.id}>{p.title}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
