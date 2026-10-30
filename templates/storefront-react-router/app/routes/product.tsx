import { data } from "react-router";
import { PRODUCT_BY_HANDLE } from "../lib/queries";
import type { Route } from "./+types/product";

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: loaderData?.product?.title ?? "Product" }];
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const { product } = await context.storefront.query(PRODUCT_BY_HANDLE, {
    variables: { handle: params.handle },
  });
  if (!product) {
    throw data("Product not found", { status: 404 });
  }
  return { product };
}

export default function Product({ loaderData }: Route.ComponentProps) {
  const { product } = loaderData;

  return (
    <article className="product">
      <h1>{product.title}</h1>
      <p className="price">{product.price ?? "—"} €</p>
      <p>{product.description}</p>
    </article>
  );
}
