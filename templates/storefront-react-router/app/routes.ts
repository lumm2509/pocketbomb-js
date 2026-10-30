import { index, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("products", "routes/products.tsx"),
  route("products/:handle", "routes/product.tsx"),
  route("account", "routes/account.tsx"),
  route("account/login", "routes/account.login.ts"),
  route("account/signup", "routes/account.signup.ts"),
  route("account/callback", "routes/account.callback.ts"),
  route("account/logout", "routes/account.logout.ts"),
] satisfies RouteConfig;
