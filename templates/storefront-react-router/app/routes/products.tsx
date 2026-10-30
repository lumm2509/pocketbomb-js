import { getPaginationVariables, Pagination } from "@pocketbomb/dynamite/react";
import { useLocation } from "react-router";
import { ProductCard } from "../components/ProductCard";
import { PRODUCTS_PAGE } from "../lib/queries";
import type { Route } from "./+types/products";

export function meta() {
  return [{ title: "Products" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const variables = getPaginationVariables(request.url, { pageBy: 4 });
  const { products } = await context.storefront.query(PRODUCTS_PAGE, { variables });
  return { products };
}

export default function Products({ loaderData }: Route.ComponentProps) {
  const location = useLocation();

  return (
    <>
      <h1>Products</h1>
      <Pagination connection={loaderData.products} url={location.pathname + location.search}>
        {({ nodes, NextLink, PreviousLink }) => (
          <>
            <PreviousLink className="previous">← Previous</PreviousLink>
            <div className="grid products">
              {nodes.map((product, i) => (
                <ProductCard key={i} product={product} />
              ))}
            </div>
            <NextLink className="next">Next →</NextLink>
          </>
        )}
      </Pagination>
    </>
  );
}
