import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PGlite loads its WASM PostgreSQL build from node_modules at runtime
  serverExternalPackages: ["@electric-sql/pglite"],
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: process.env.FRONTEND_ORIGIN ?? "" },
          { key: "Access-Control-Allow-Methods", value: "GET, POST, PUT, OPTIONS" },
          {
            key: "Access-Control-Allow-Headers",
            value: "Content-Type, Authorization, Idempotency-Key, X-Correlation-Id, X-Tenant-Id, X-Branch-Id, X-Actor-Id, X-Actor-Role",
          },
          { key: "Access-Control-Expose-Headers", value: "X-Correlation-Id, X-Total-Count" },
        ],
      },
    ];
  },
};

export default nextConfig;
