import { gql } from "@pocketbomb/dynamite";

export type Product = { id: string; title: string; handle: string };

export const PRODUCT_FIELDS = gql(`fragment ProductFields on Product { id title handle }`);

/**
 * The first products sorted by handle (cursor pagination).
 */
export const PRODUCTS = gql<
  {
    products: {
      nodes: Array<Product>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      totalCount: number;
    };
  },
  { first: number; after?: string | null }
>(
  `query Products($first: Int, $after: String) {
    products(first: $first, after: $after, sort: "handle") {
      nodes { ...ProductFields }
      pageInfo { hasNextPage endCursor }
      totalCount
    }
  }`,
  [PRODUCT_FIELDS],
);
