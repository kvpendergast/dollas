import {
  buildOnboardingChecklist,
  needsStarterCategories,
  planStarterCategories,
  type OnboardingChecklist,
  type OnboardingStepId,
} from "@dollas/domain";
import { and, desc, eq, isNull } from "drizzle-orm";
import { withActor } from "@/db/actor";
import type { AppTx } from "@/db/client";
import { category, categoryGroup, householdOnboarding, ledgerAccount, transaction } from "@/db/schema";
import { logInfo } from "@/lib/telemetry";
import { failure, succeed, type ServiceActor, type ServiceResult, type Via } from "@/lib/service-result";

/**
 * Onboarding (PEN-204), shared by Home, Settings, and the MCP tools. Step
 * stamps come from database triggers on the real tables (migration 0032), so
 * this reads them, adds the household's skip/resume choice, and offers the
 * starter categories while the household has none of its own.
 */

export type OnboardingStatus = OnboardingChecklist & {
  /** True while the household has no categories of its own (none, or only the fallbacks). */
  offerStarterCategories: boolean;
};

type Row = typeof householdOnboarding.$inferSelect;

const STAMP: Record<OnboardingStepId, keyof Row> = {
  account: "accountAt",
  categories: "categoriesAt",
  transactions: "transactionsAt",
  budget: "budgetAt",
  invite: "inviteAt",
  recurring: "recurringAt",
};

function toChecklist(row: Row | undefined): OnboardingChecklist {
  const completed = Object.fromEntries(
    (Object.keys(STAMP) as OnboardingStepId[]).map((id) => [id, (row?.[STAMP[id]] as Date | null | undefined) ?? null]),
  ) as Record<OnboardingStepId, Date | null>;
  return buildOnboardingChecklist({ completed, dismissedAt: row?.dismissedAt ?? null });
}

async function readStatus(tx: AppTx, householdId: string): Promise<OnboardingStatus> {
  const [row] = await tx.select().from(householdOnboarding).where(eq(householdOnboarding.householdId, householdId));
  const categories = await tx.select({ name: category.name, kind: category.kind }).from(category).where(eq(category.householdId, householdId));
  return { ...toChecklist(row), offerStarterCategories: needsStarterCategories(categories) };
}

export async function getOnboardingStatus(actor: ServiceActor): Promise<ServiceResult<OnboardingStatus>> {
  try {
    return succeed(await withActor(actor.userId, (tx) => readStatus(tx, actor.householdId)));
  } catch (error) {
    return failure(error, "Could not load the setup checklist.", { action: "get-onboarding", householdId: actor.householdId });
  }
}

async function setDismissed(actor: ServiceActor, dismissed: boolean, via: Via): Promise<ServiceResult<OnboardingStatus>> {
  const action = dismissed ? "dismiss-onboarding" : "resume-onboarding";
  try {
    const status = await withActor(actor.userId, async (tx) => {
      const values = { dismissedAt: dismissed ? new Date() : null, dismissedByUserId: dismissed ? actor.userId : null, updatedAt: new Date() };
      await tx
        .insert(householdOnboarding)
        .values({ householdId: actor.householdId, ...values })
        .onConflictDoUpdate({ target: householdOnboarding.householdId, set: values });
      return readStatus(tx, actor.householdId);
    });
    logInfo(dismissed ? "Skipped the setup checklist" : "Resumed the setup checklist", { action, via, householdId: actor.householdId });
    return succeed(status);
  } catch (error) {
    return failure(error, dismissed ? "Could not hide the setup checklist." : "Could not bring back the setup checklist.", {
      action,
      via,
      householdId: actor.householdId,
    });
  }
}

/** "Skip for now": hides the checklist for every member until someone resumes it. Progress is kept. */
export function dismissOnboarding(actor: ServiceActor, via: Via = "web") {
  return setDismissed(actor, true, via);
}

/** Brings the checklist back on Home, with progress as it is. */
export function resumeOnboarding(actor: ServiceActor, via: Via = "web") {
  return setDismissed(actor, false, via);
}

export type StarterCategoriesResult = {
  groupsAdded: string[];
  categoriesAdded: Array<{ name: string; kind: string; groupName: string }>;
  skipped: number;
};

/**
 * Adds the starter groups and categories. Idempotent: anything already there
 * by name (case-insensitive) is skipped, so a second run adds nothing.
 * New groups and categories go after the existing ones.
 */
export async function addStarterCategories(actor: ServiceActor, via: Via = "web"): Promise<ServiceResult<StarterCategoriesResult>> {
  try {
    const result = await withActor(actor.userId, async (tx) => {
      const groups = await tx
        .select({ id: categoryGroup.id, name: categoryGroup.name, sortOrder: categoryGroup.sortOrder })
        .from(categoryGroup)
        .where(eq(categoryGroup.householdId, actor.householdId))
        .orderBy(desc(categoryGroup.sortOrder));
      const categories = await tx
        .select({ name: category.name, sortOrder: category.sortOrder })
        .from(category)
        .where(eq(category.householdId, actor.householdId));
      const plan = planStarterCategories({ groups, categories });
      const groupId = new Map(groups.map((group) => [group.name.toLowerCase(), group.id]));
      let groupOrder = (groups[0]?.sortOrder ?? -1) + 1;
      for (const name of plan.groups) {
        const [row] = await tx
          .insert(categoryGroup)
          .values({ householdId: actor.householdId, name, sortOrder: groupOrder++ })
          .returning({ id: categoryGroup.id });
        if (!row) throw new Error("group insert returned no row");
        groupId.set(name.toLowerCase(), row.id);
      }
      // Fallbacks sit at 1000 so they stay last; start after the household's own.
      let order = Math.max(-1, ...categories.filter((row) => row.sortOrder < 1000).map((row) => row.sortOrder)) + 1;
      if (plan.categories.length > 0) {
        await tx.insert(category).values(
          plan.categories.map((row) => ({
            householdId: actor.householdId,
            groupId: groupId.get(row.groupName.toLowerCase()) ?? null,
            name: row.name,
            kind: row.kind,
            sortOrder: order++,
          })),
        );
      }
      return { groupsAdded: plan.groups, categoriesAdded: plan.categories, skipped: plan.skipped };
    });
    logInfo("Added starter categories", {
      action: "add-starter-categories",
      via,
      householdId: actor.householdId,
      added: String(result.categoriesAdded.length),
    });
    return succeed(result);
  } catch (error) {
    return failure(error, "Could not add the starter categories.", { action: "add-starter-categories", via, householdId: actor.householdId });
  }
}

export type FirstUseFacts = { hasAccounts: boolean; hasTransactions: boolean };

/** What empty states need to pick their next action: any active account, any live transaction. */
export async function loadFirstUseFacts(actor: ServiceActor): Promise<FirstUseFacts> {
  return withActor(actor.userId, async (tx) => {
    const [accounts] = await tx
      .select({ id: ledgerAccount.id })
      .from(ledgerAccount)
      .where(and(eq(ledgerAccount.householdId, actor.householdId), isNull(ledgerAccount.archivedAt)))
      .limit(1);
    const [live] = await tx
      .select({ id: transaction.id })
      .from(transaction)
      .where(and(eq(transaction.householdId, actor.householdId), isNull(transaction.deletedAt)))
      .limit(1);
    return { hasAccounts: accounts != null, hasTransactions: live != null };
  });
}
