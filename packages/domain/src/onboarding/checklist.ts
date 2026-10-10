/**
 * The onboarding checklist on Home (PEN-204). Steps complete from real data:
 * database triggers stamp a time per step the first time the household does
 * it (any path: web, CSV, bank, MCP), so a step stays done even if that first
 * account is later archived. This module turns those stamps into what Home,
 * Settings, and the MCP tool show.
 */

export const ONBOARDING_STEP_IDS = ["account", "categories", "transactions", "budget", "invite", "recurring"] as const;
export type OnboardingStepId = (typeof ONBOARDING_STEP_IDS)[number];

export type OnboardingStepDefinition = {
  id: OnboardingStepId;
  title: string;
  detail: string;
  href: string;
  action: string;
  optional: boolean;
};

export const ONBOARDING_STEPS: readonly OnboardingStepDefinition[] = [
  {
    id: "account",
    title: "Add your first account",
    detail: "A checking account, card, or cash. Enter it by hand, link a bank, or import a CSV.",
    href: "/accounts",
    action: "Add an account",
    optional: false,
  },
  {
    id: "categories",
    title: "Set up categories",
    detail: "Groups and categories for where money goes. Start from a ready-made set and rename later.",
    href: "/categories",
    action: "Set up categories",
    optional: false,
  },
  {
    id: "transactions",
    title: "Add or import transactions",
    detail: "Type one in, import a CSV from your bank, or sync a linked bank.",
    href: "/activity",
    action: "Add transactions",
    optional: false,
  },
  {
    id: "budget",
    title: "Set a budget for this month",
    detail: "Give a few categories an amount. Home then shows spent against plan.",
    href: "/plan",
    action: "Open Plan",
    optional: false,
  },
  {
    id: "invite",
    title: "Invite your partner",
    detail: "They get their own login and see the same household.",
    href: "/household#invite",
    action: "Invite them",
    optional: false,
  },
  {
    id: "recurring",
    title: "Add a recurring bill",
    detail: "Rent, a paycheck, or a subscription, so matching transactions link to it.",
    href: "/recurring",
    action: "Add a recurring bill",
    optional: true,
  },
];

export type OnboardingRecord = {
  completed: Partial<Record<OnboardingStepId, Date | null>>;
  dismissedAt: Date | null;
};

export type OnboardingStep = OnboardingStepDefinition & { done: boolean; completedAt: Date | null };

/**
 * - checklist: show the steps on Home.
 * - complete: every required step is done; Home shows a short "set up" note until dismissed.
 * - dismissed: skipped ("Skip for now") or finished and closed; resumable from Home or Settings.
 */
export type OnboardingState = "checklist" | "complete" | "dismissed";

export type OnboardingChecklist = {
  state: OnboardingState;
  steps: OnboardingStep[];
  /** Steps hidden for now, with why (the invite waits for the first account). */
  waiting: Array<{ id: OnboardingStepId; reason: string }>;
  requiredDone: number;
  requiredTotal: number;
  nextStep: OnboardingStepId | null;
  dismissedAt: Date | null;
};

export const INVITE_WAITS_FOR = "Shown once the first account exists.";

export function buildOnboardingChecklist(record: OnboardingRecord): OnboardingChecklist {
  const at = (id: OnboardingStepId) => record.completed[id] ?? null;
  const all: OnboardingStep[] = ONBOARDING_STEPS.map((step) => ({ ...step, done: at(step.id) != null, completedAt: at(step.id) }));
  // The ticket: the invite is offered after the first account exists. A partner
  // who already joined (invite stamped) shows as done regardless.
  const inviteShown = at("account") != null || at("invite") != null;
  const steps = all.filter((step) => step.id !== "invite" || inviteShown);
  const waiting = inviteShown ? [] : [{ id: "invite" as const, reason: INVITE_WAITS_FOR }];
  const required = steps.filter((step) => !step.optional);
  const requiredDone = required.filter((step) => step.done).length;
  // "Complete" counts the invite even while it waits, so the household is not
  // called set up before the invite has been offered.
  const allRequiredDone = requiredDone === required.length && inviteShown;
  const nextStep = steps.find((step) => !step.done)?.id ?? null;
  const state: OnboardingState = record.dismissedAt ? "dismissed" : allRequiredDone ? "complete" : "checklist";
  return { state, steps, waiting, requiredDone, requiredTotal: required.length, nextStep, dismissedAt: record.dismissedAt };
}
