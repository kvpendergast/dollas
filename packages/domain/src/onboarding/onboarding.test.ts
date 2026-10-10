import { describe, expect, it } from "vitest";

const assert = {
  equal: (a: unknown, b: unknown, _m?: string) => expect(a).toBe(b),
  deepEqual: (a: unknown, b: unknown) => expect(a).toEqual(b),
  ok: (a: unknown) => expect(a).toBeTruthy(),
};
import { buildOnboardingChecklist, type OnboardingStepId } from "./checklist";
import { isFallbackCategory, needsStarterCategories, planStarterCategories, STARTER_CATEGORIES } from "./starter";

const at = new Date("2026-10-10T15:00:00Z");
const done = (...ids: OnboardingStepId[]) => Object.fromEntries(ids.map((id) => [id, at]));

describe("buildOnboardingChecklist", () => {
  it("starts with five visible steps; the invite waits for the first account", () => {
    const list = buildOnboardingChecklist({ completed: {}, dismissedAt: null });
    assert.equal(list.state, "checklist");
    assert.deepEqual(list.steps.map((step) => step.id), ["account", "categories", "transactions", "budget", "recurring"]);
    assert.deepEqual(list.waiting.map((row) => row.id), ["invite"]);
    assert.equal(list.requiredTotal, 4);
    assert.equal(list.requiredDone, 0);
    assert.equal(list.nextStep, "account");
  });

  it("offers the invite once the first account exists", () => {
    const list = buildOnboardingChecklist({ completed: done("account"), dismissedAt: null });
    assert.ok(list.steps.some((step) => step.id === "invite"));
    assert.deepEqual(list.waiting, []);
    assert.equal(list.requiredTotal, 5);
    assert.equal(list.requiredDone, 1);
    assert.equal(list.nextStep, "categories");
  });

  it("shows a joined partner as done even before an account", () => {
    const list = buildOnboardingChecklist({ completed: done("invite"), dismissedAt: null });
    assert.equal(list.steps.find((step) => step.id === "invite")?.done, true);
  });

  it("each step completes on its own stamp", () => {
    for (const id of ["account", "categories", "transactions", "budget", "invite", "recurring"] as const) {
      const list = buildOnboardingChecklist({ completed: { account: at, [id]: at }, dismissedAt: null });
      assert.equal(list.steps.find((step) => step.id === id)?.done, true, id);
      assert.equal(list.steps.find((step) => step.id === id)?.completedAt, at, id);
    }
  });

  it("is complete when the five required steps are done; the recurring bill is optional", () => {
    const list = buildOnboardingChecklist({ completed: done("account", "categories", "transactions", "budget", "invite"), dismissedAt: null });
    assert.equal(list.state, "complete");
    assert.equal(list.requiredDone, 5);
    assert.equal(list.nextStep, "recurring");
  });

  it("dismissed wins over checklist and complete, and keeps progress", () => {
    const list = buildOnboardingChecklist({ completed: done("account"), dismissedAt: at });
    assert.equal(list.state, "dismissed");
    assert.equal(list.requiredDone, 1);
    assert.equal(list.dismissedAt, at);
  });
});

describe("starter categories", () => {
  it("are needed with no categories or only the fallbacks", () => {
    assert.equal(needsStarterCategories([]), true);
    assert.equal(needsStarterCategories([{ name: "Uncategorized", kind: "expense" }, { name: "Uncategorized income", kind: "income" }]), true);
    assert.equal(needsStarterCategories([{ name: "Uncategorized", kind: "expense" }, { name: "Groceries", kind: "expense" }]), false);
    assert.equal(isFallbackCategory({ name: "Uncategorized", kind: "income" }), false);
  });

  it("plans the whole set for an empty household", () => {
    const plan = planStarterCategories({ groups: [], categories: [] });
    assert.equal(plan.groups.length, STARTER_CATEGORIES.length);
    assert.equal(plan.categories.length, STARTER_CATEGORIES.reduce((sum, group) => sum + group.categories.length, 0));
    assert.equal(plan.skipped, 0);
    assert.ok(plan.categories.some((row) => row.name === "Paychecks" && row.kind === "income" && row.groupName === "Income"));
  });

  it("is idempotent: after adding it, nothing is planned", () => {
    const first = planStarterCategories({ groups: [], categories: [] });
    const again = planStarterCategories({ groups: first.groups.map((name) => ({ name })), categories: first.categories });
    assert.deepEqual(again.groups, []);
    assert.deepEqual(again.categories, []);
    assert.equal(again.skipped, first.categories.length);
  });

  it("skips names that already exist case-insensitively and reuses existing groups", () => {
    const plan = planStarterCategories({ groups: [{ name: "food" }], categories: [{ name: "groceries" }] });
    assert.ok(!plan.groups.includes("Food"));
    assert.ok(!plan.categories.some((row) => row.name === "Groceries"));
    assert.ok(plan.categories.some((row) => row.name === "Dining out" && row.groupName === "Food"));
    assert.equal(plan.skipped, 1);
  });
});
