import { sql } from "drizzle-orm";
import { withActor } from "@/db/actor";
import { failure, refuse, succeed, type ServiceResult } from "@/lib/service-result";

/**
 * UI-only. Starts a household for a verified login that has none. An agent
 * token is always scoped to an existing household, so there is no tool.
 */
export async function startHousehold(userId: string, rawName: string): Promise<ServiceResult<{ householdId: string }>> {
  const name = rawName.trim();
  if (name.length < 2) return refuse("Name the household you are starting.");
  try {
    const rows = await withActor(userId, (tx) => tx.execute(sql`select create_household(${name}) as id`));
    const id = Array.isArray(rows) && rows.length > 0 ? (rows[0] as { id?: unknown }).id : null;
    if (typeof id !== "string") return refuse("The household was not created.");
    return succeed({ householdId: id });
  } catch (error) {
    return failure(error, "Could not start that household.", { action: "create-household", userId });
  }
}
