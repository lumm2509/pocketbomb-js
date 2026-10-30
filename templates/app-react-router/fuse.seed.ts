// The fuse seed of `detonator dev`: the "orders" collection of the manifest scopes and a few orders.
import type { FuseSeedContext } from "@pocketbomb/fuse/node";

export default async function seed(context: FuseSeedContext): Promise<Record<string, string>> {
  const pb = await context.signInOwner();

  const orders = await pb.collections.create({
    name: "orders",
    type: "base",
    fields: [
      { name: "title", type: "text", required: true },
      { name: "total", type: "number" },
    ],
    listRule: "",
    viewRule: "",
  });

  for (let i = 1; i <= 3; i++) {
    await pb.collection("orders").create({ title: "Order " + i, total: i * 25 });
  }

  return { ORDERS_COLLECTION_ID: orders.id };
}
