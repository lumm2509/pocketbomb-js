import { gql } from "@pocketbomb/dynamite";

export type Product = { id: string; title: string; handle: string };

/** The products (typed without codegen: explicit result/variables types). */
export const PRODUCTS = gql<
  { products: { nodes: Array<Product>; totalCount: number } | null },
  { first: number; filter?: string }
>(`
  query Products($first: Int, $filter: String) {
    products(first: $first, filter: $filter, sort: "handle") {
      nodes { id title handle }
      totalCount
    }
  }
`);
