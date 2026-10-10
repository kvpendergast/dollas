import { ONBOARDING_STEPS } from "@dollas/domain";
import { answer, tool } from "@/slices/agents/tool-kit";
import { addStarterCategories, dismissOnboarding, getOnboardingStatus, resumeOnboarding, type OnboardingStatus } from "./service";

function shown(status: OnboardingStatus) {
  return {
    state: status.state,
    required_done: status.requiredDone,
    required_total: status.requiredTotal,
    next_step: status.nextStep,
    steps: status.steps.map((step) => ({
      id: step.id,
      title: step.title,
      done: step.done,
      optional: step.optional,
      completed_at: step.completedAt?.toISOString() ?? null,
      web_path: step.href,
    })),
    waiting: status.waiting,
    dismissed_at: status.dismissedAt?.toISOString() ?? null,
    offer_starter_categories: status.offerStarterCategories,
  };
}

function summary(status: OnboardingStatus): string {
  const head = `Setup: ${status.requiredDone} of ${status.requiredTotal} steps done`;
  const next = status.nextStep ? ONBOARDING_STEPS.find((step) => step.id === status.nextStep)?.title : null;
  if (status.state === "dismissed") return `${head}; the checklist is hidden (resume_onboarding brings it back).`;
  if (status.state === "complete") return `${head}; the household is set up.${next ? ` Optional: ${next}.` : ""}`;
  return `${head}. Next: ${next ?? "nothing"}.`;
}

export const onboardingTools = [
  tool({
    name: "get_onboarding_status",
    title: "Get onboarding status",
    description:
      "The household's setup checklist, as on Home: add your first account, set up categories, add or import transactions, set a budget, invite your partner (offered once the first account exists; listed under waiting until then), and an optional recurring bill. Steps complete on their own from real data. state is checklist, complete, or dismissed (skipped; resume_onboarding brings it back). offer_starter_categories is true while the household has no categories of its own (see add_starter_categories).",
    access: "read",
    input: {},
    async run(_args, { books }) {
      return answer(await getOnboardingStatus(books), summary, shown);
    },
  }),
  tool({
    name: "dismiss_onboarding",
    title: "Skip the setup checklist",
    description: "Hide the setup checklist on Home for everyone in the household (Skip for now). Progress is kept; resume_onboarding brings it back.",
    access: "write",
    idempotent: true,
    input: {},
    async run(_args, { books }) {
      return answer(await dismissOnboarding(books, "mcp"), summary, shown);
    },
  }),
  tool({
    name: "resume_onboarding",
    title: "Resume the setup checklist",
    description: "Show the setup checklist on Home again, with progress as it is.",
    access: "write",
    idempotent: true,
    input: {},
    async run(_args, { books }) {
      return answer(await resumeOnboarding(books, "mcp"), summary, shown);
    },
  }),
  tool({
    name: "add_starter_categories",
    title: "Add starter categories",
    description:
      "Add a starter set of category groups and categories (Income: Paychecks, Other income; Home; Food; Getting around; Health; Fun; Giving and gifts). Anything already there by name is skipped, so running it again adds nothing. Members can rename or remove any of them after.",
    access: "write",
    idempotent: true,
    input: {},
    async run(_args, { books }) {
      return answer(
        await addStarterCategories(books, "mcp"),
        (value) =>
          value.categoriesAdded.length === 0
            ? "Those categories are already here; nothing added."
            : `Added ${value.categoriesAdded.length} categories in ${value.groupsAdded.length} new groups${value.skipped ? `; skipped ${value.skipped} already here` : ""}.`,
        (value) => ({
          groups_added: value.groupsAdded,
          categories_added: value.categoriesAdded.map((row) => ({ name: row.name, kind: row.kind, group: row.groupName })),
          skipped: value.skipped,
        }),
      );
    },
  }),
];
