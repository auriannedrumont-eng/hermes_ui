import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  /* Le type-check strict s'applique au build (P1 : les erreurs ne passent plus). */
  typescript: {
    ignoreBuildErrors: false,
  },
  reactStrictMode: true,
  devIndicators: false,
};

export default nextConfig;
