import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PGlite loads its WASM PostgreSQL build from node_modules at runtime
  serverExternalPackages: ["@electric-sql/pglite"],
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: process.env.FRONTEND_ORIGIN || "http://localhost:3000" },
          { key: "Access-Control-Allow-Methods", value: "GET, POST, PUT, OPTIONS" },
          {
            key: "Access-Control-Allow-Headers",
            value: "Content-Type, Authorization, Idempotency-Key, X-Correlation-Id, X-Tenant-Id, X-Actor-Id, X-Actor-Role, X-Branch-Id",
          },
          { key: "Access-Control-Expose-Headers", value: "X-Correlation-Id, X-Total-Count" },
        ],
      },
    ];
  },
};

export default nextConfig;
