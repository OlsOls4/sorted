import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@paypal/agent-toolkit"],
  poweredByHeader: false,
};

export default nextConfig;
