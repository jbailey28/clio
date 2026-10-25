import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  // A test build can go elsewhere, so building never touches the folder a
  // running app is serving from.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
