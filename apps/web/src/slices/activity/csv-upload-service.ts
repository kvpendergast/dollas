import { createHash } from "node:crypto";
import { CSV_IMPORT_MAX_CHARS, csvTooLargeMessage } from "@dollas/domain";
import { and, asc, eq, lt } from "drizzle-orm";
import { withActor } from "@/db/actor";
import { csvUpload } from "@/db/schema";
import { UUID, failure, refuse, succeed, type ServiceActor, type ServiceResult } from "@/lib/service-result";

/**
 * Staged CSV uploads (PEN-278). The agent sends the file once, gets an id, and
 * every later step (inspect, preview, commit) names the id. The stored text is
 * immutable and hashed, so a later step can never see different bytes than the
 * first one did, and nothing has to be pasted again.
 */

export const STAGED_CSV_TTL_HOURS = 24;
/** Staged files kept per household. Staging more drops the oldest. */
export const STAGED_CSV_MAX_PER_HOUSEHOLD = 10;

export type StagedCsv = {
  id: string;
  sha256: string;
  charCount: number;
  lineCount: number;
  expiresAt: string;
};

const EXPIRED = "That staged file was not found or has expired. Stage the CSV again.";

export function csvSha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function countLines(text: string): number {
  return text.split(/\r\n|\r|\n/).filter((line) => line.trim().length > 0).length;
}

export async function stageCsvUpload(actor: ServiceActor, csv: string): Promise<ServiceResult<StagedCsv>> {
  if (csv.length === 0) return refuse("Choose a CSV file.");
  if (csv.length > CSV_IMPORT_MAX_CHARS) return refuse(csvTooLargeMessage());
  try {
    const expiresAt = new Date(Date.now() + STAGED_CSV_TTL_HOURS * 3_600_000);
    const sha256 = csvSha256(csv);
    const row = await withActor(actor.userId, async (tx) => {
      const mine = eq(csvUpload.householdId, actor.householdId);
      await tx.delete(csvUpload).where(and(mine, lt(csvUpload.expiresAt, new Date())));
      const [created] = await tx
        .insert(csvUpload)
        .values({ householdId: actor.householdId, content: csv, contentSha256: sha256, charCount: csv.length, expiresAt })
        .returning({ id: csvUpload.id });
      if (!created) throw new Error("Could not stage that CSV.");
      const kept = await tx
        .select({ id: csvUpload.id })
        .from(csvUpload)
        .where(mine)
        .orderBy(asc(csvUpload.createdAt), asc(csvUpload.id));
      for (const old of kept.slice(0, Math.max(0, kept.length - STAGED_CSV_MAX_PER_HOUSEHOLD))) {
        await tx.delete(csvUpload).where(and(mine, eq(csvUpload.id, old.id)));
      }
      return created;
    });
    return succeed({ id: row.id, sha256, charCount: csv.length, lineCount: countLines(csv), expiresAt: expiresAt.toISOString() });
  } catch (error) {
    return failure(error, "Could not stage that CSV.", { action: "stage-csv", householdId: actor.householdId });
  }
}

/** The staged text plus its hash. Another household's id, an expired id, and a made-up id all look the same. */
export async function loadStagedCsv(
  actor: ServiceActor,
  uploadId: string,
): Promise<ServiceResult<{ csv: string; sha256: string }>> {
  if (!UUID.test(uploadId)) return refuse(EXPIRED);
  try {
    const row = await withActor(actor.userId, async (tx) => {
      const [found] = await tx
        .select({ content: csvUpload.content, sha256: csvUpload.contentSha256, expiresAt: csvUpload.expiresAt })
        .from(csvUpload)
        .where(and(eq(csvUpload.id, uploadId), eq(csvUpload.householdId, actor.householdId)));
      return found ?? null;
    });
    if (!row || row.expiresAt.getTime() <= Date.now()) return refuse(EXPIRED);
    return succeed({ csv: row.content, sha256: row.sha256 });
  } catch (error) {
    return failure(error, "Could not load that staged file.", { action: "load-staged-csv", householdId: actor.householdId });
  }
}
