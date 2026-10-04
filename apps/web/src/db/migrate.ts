import { migrateWithUrl, publicErrorText } from "./apply-migrations";
import { loadEnv, requiredEnv } from "./env";

async function main() {
  loadEnv();
  const url = requiredEnv("DATABASE_MIGRATE_URL");
  const result = await migrateWithUrl(url);
  for (const id of result.skipped) console.log(`skip ${id}`);
  for (const id of result.applied) console.log(`applied ${id}`);
}

main().catch((error: unknown) => {
  console.error(publicErrorText(error));
  process.exit(1);
});
