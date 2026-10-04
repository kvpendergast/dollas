import { loadEnv, requiredEnv } from "./env";
import { applyMigrations, createPostgresMigrationClient, loadMigrationFiles } from "./apply-migrations";

async function main() {
  loadEnv();
  const url = requiredEnv("DATABASE_MIGRATE_URL");
  const files = await loadMigrationFiles();
  const client = createPostgresMigrationClient(url);
  try {
    const result = await applyMigrations(client, files);
    for (const id of result.skipped) console.log(`skip ${id}`);
    for (const id of result.applied) console.log(`applied ${id}`);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
