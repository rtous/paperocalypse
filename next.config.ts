import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The MCP SDK and DB drivers are server-only; keep them out of client bundles.
  serverExternalPackages: ["ws"],
  poweredByHeader: false,
};

export default nextConfig;
