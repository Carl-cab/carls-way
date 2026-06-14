import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // postgres.js requires Node.js runtime (not Edge); mark as external to avoid bundling issues
  serverExternalPackages: ['postgres'],
};

export default nextConfig;
