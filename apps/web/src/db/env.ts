import { existsSync } from "node:fs";
import path from "node:path";

export function loadEnv(): void {
  for (const name of [".env.local", ".env"]) {
    const file = path.resolve(process.cwd(), name);
    if (existsSync(file)) process.loadEnvFile(file);
  }
}

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
