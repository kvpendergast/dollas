import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@dollas/domain"],
  outputFileTracingRoot: path.join(path.dirname(fileURLToPath(import.meta.url)), "../.."),
  outputFileTracingIncludes: {
    "/*": ["./drizzle/**/*.sql", "./drizzle/meta/_journal.json"],
  },
  async redirects() {
    // PEN-205: the page is called Spend estimate everywhere, so is its route.
    return [{ source: "/projection", destination: "/estimate", permanent: true }];
  },
};

export default nextConfig;
