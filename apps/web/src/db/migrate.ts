import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import postgres from "postgres";
import { loadEnv, requiredEnv } from "./env";

const execFileAsync = promisify(execFile);

async function main() {
  loadEnv();
  const url = requiredEnv("DATABASE_MIGRATE_URL");
  const directory = path.join(process.cwd(), "src/db/migrations");
  const files = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
  const sql = postgres(url, { max: 1 });
  await sql`
    create table if not exists schema_migration (
      id text primary key,
      applied_at timestamptz not null default now()
    )
  `;
  for (const file of files) {
    const existing = await sql<{ id: string }[]>`select id from schema_migration where id = ${file}`;
    if (existing.length > 0) {
      console.log(`skip ${file}`);
      continue;
    }
    const fullPath = path.join(directory, file);
    await execFileAsync("psql", [url, "-v", "ON_ERROR_STOP=1", "-f", fullPath], {
      env: process.env,
    });
    await sql`insert into schema_migration (id) values (${file})`;
    console.log(`applied ${file}`);
  }
  await sql.end();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
