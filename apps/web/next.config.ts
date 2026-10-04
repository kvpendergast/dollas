import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@dollas/domain"],
  outputFileTracingRoot: path.join(path.dirname(fileURLToPath(import.meta.url)), "../.."),
  outputFileTracingIncludes: {
    "/*": ["./src/db/migrations/**/*"],
  },
};

export default nextConfig;
