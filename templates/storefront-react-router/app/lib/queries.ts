// The storefront GraphQL documents (typed by gql.tada from the codegen schema).
import { graphql } from "@pocketbomb/dynamite/graphql";

export const PRODUCT_CARD = graphql(`
  fragment ProductCard on Product {
    id
    title
    handle
    price
  }
`);

export const FEATURED_PRODUCTS = graphql(
  `
    query FeaturedProducts {
      products(first: 3, sort: "-price") {
        nodes {
          ...ProductCard
        }
        totalCount
      }
    }
  `,
  [PRODUCT_CARD],
);

export const PRODUCTS_PAGE = graphql(
  `
    query ProductsPage($first: Int, $after: String, $last: Int, $before: String) {
      products(first: $first, after: $after, last: $last, before: $before, sort: "handle") {
        nodes {
          ...ProductCard
        }
        pageInfo {
          hasNextPage
          hasPreviousPage
          startCursor
          endCursor
        }
        totalCount
      }
    }
  `,
  [PRODUCT_CARD],
);

export const PRODUCT_BY_HANDLE = graphql(`
  query ProductByHandle($handle: String) {
    product(handle: $handle) {
      id
      title
      handle
      description
      price
    }
  }
`);

export const PRODUCT_SEARCH = graphql(
  `
    query ProductSearch($filter: String) {
      products(first: 5, filter: $filter, sort: "handle") {
        nodes {
          ...ProductCard
        }
      }
    }
  `,
  [PRODUCT_CARD],
);
