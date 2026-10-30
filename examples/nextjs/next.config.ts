import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // the PocketBomb keys are read from process.env at request time by the server code only
  // (no NEXT_PUBLIC_* variable: the browser gets the public key through the props)
  poweredByHeader: false,
};

export default nextConfig;
