import { confirmInput, pageInput, paginate, readPage } from "@dollas/mcp";
import { z } from "zod";
import { answer, plural, tool, uuidInput } from "@/slices/agents/tool-kit";
import { applyPayeeRule, deletePayeeRule, listPayeeRules, previewPayeeRuleApply, savePayeeRule } from "./payee-rule-service";
import { PAYEE_RULES_APPLY_TO, type PayeeRuleApplyCounts } from "./payee-rule-copy";

const patternInput = z.string().min(1).max(120).describe("Payee text to match. A payee containing it (case-insensitive) matches.");

type CountsValue = PayeeRuleApplyCounts;

function counts(value: CountsValue) {
  return {
    pattern: value.pattern,
    category_name: value.categoryName,
    change_count: value.changeCount,
    skipped_split_count: value.skippedSplitCount,
    skipped_without_category_count: value.skippedWithoutCategoryCount,
    sample_payees: (value.samplePayees ?? []).map((item) => ({ payee: item.payee, transactions: item.count })),
    conflicting_rules: (value.conflicts ?? []).map((item) => ({
      rule_id: item.ruleId,
      pattern: item.pattern,
      category_id: item.categoryId,
      same_category: item.sameCategory,
      wins_on_import: item.winsOnImport,
      shared_payees: item.sharedPayees,
    })),
  };
}

export const payeeRuleTools = [
  tool({
    name: "list_payee_rules",
    title: "List payee rules",
    description: `Payee rules: payee text and the category it sets. ${PAYEE_RULES_APPLY_TO}`,
    access: "read",
    input: { ...pageInput(100) },
    async run(args, { books }) {
      return answer(
        await listPayeeRules(books),
        (rules) => `${plural(rules.length, "payee rule")}.`,
        (rules) =>
          paginate(
            rules.map((rule) => ({ id: rule.id, pattern: rule.pattern, category_id: rule.categoryId, category_name: rule.categoryName })),
            readPage(args, 100),
          ),
      );
    },
  }),
  tool({
    name: "create_payee_rule",
    title: "Create payee rule",
    description: `Add a rule that sets a category for matching payees. ${PAYEE_RULES_APPLY_TO} Set apply_to_existing to also move the existing matching transactions now (split ones are skipped); the result then carries the counts, as apply_payee_rule does.`,
    access: "write",
    input: {
      pattern: patternInput,
      category_id: uuidInput("Category"),
      apply_to_existing: z.boolean().optional().describe("Also apply the new rule to existing transactions. Default false."),
    },
    async run(args, { books }) {
      const saved = await savePayeeRule(books, { pattern: args.pattern, categoryId: args.category_id }, undefined, "mcp");
      if (!saved.ok || !args.apply_to_existing) {
        return answer(saved, (value) => `Added a rule for "${value.pattern}".`, (value) => ({ id: value.id, pattern: value.pattern, category_id: value.categoryId }));
      }
      const applied = await applyPayeeRule(books, saved.value.id, "mcp");
      if (!applied.ok) {
        return { ok: false, message: `Added the rule for "${saved.value.pattern}" (id ${saved.value.id}), but applying it failed: ${applied.memberMessage}` };
      }
      return answer(
        applied,
        (value) => `Added a rule for "${saved.value.pattern}". ${value.message}`,
        (value) => ({ id: saved.value.id, category_id: saved.value.categoryId, ...counts(value), applied: true }),
      );
    },
  }),
  tool({
    name: "update_payee_rule",
    title: "Update payee rule",
    description: "Change a rule's payee text and category. Existing transactions stay as they are.",
    access: "write",
    idempotent: true,
    input: { rule_id: uuidInput("Payee rule"), pattern: patternInput, category_id: uuidInput("Category") },
    async run(args, { books }) {
      const saved = await savePayeeRule(books, { pattern: args.pattern, categoryId: args.category_id }, args.rule_id, "mcp");
      return answer(saved, (value) => `Saved the rule for "${value.pattern}".`, (value) => ({ id: value.id, pattern: value.pattern, category_id: value.categoryId }));
    },
  }),
  tool({
    name: "delete_payee_rule",
    title: "Delete payee rule",
    description: "Remove a payee rule. New imports and syncs stop using it; existing transactions stay as they are.",
    access: "write",
    destructive: true,
    input: { rule_id: uuidInput("Payee rule"), confirm: confirmInput("remove this payee rule") },
    async run(args, { books }) {
      return answer(await deletePayeeRule(books, args.rule_id, "mcp"), (value) => `Removed the "${value.pattern}" rule.`);
    },
  }),
  tool({
    name: "preview_payee_rule_apply",
    title: "Preview applying a payee rule",
    description: "How many existing transactions a saved rule would move to its category, and how many split or uncategorized ones it would skip, plus sample_payees (the distinct payees it matches, most frequent first) and conflicting_rules (other rules that also match some of them; wins_on_import is true when the other, longer rule would beat this one on a new import or sync). Nothing is written.",
    access: "read",
    input: { rule_id: uuidInput("Payee rule") },
    async run(args, { books }) {
      return answer(
        await previewPayeeRuleApply(books, args.rule_id),
        (value) => `${plural(value.changeCount, "transaction")} would move to ${value.categoryName}.`,
        counts,
      );
    },
  }),
  tool({
    name: "apply_payee_rule",
    title: "Apply payee rule to existing transactions",
    description: "Move existing matching transactions to the rule's category in one step. Split transactions are skipped. Preview first with preview_payee_rule_apply.",
    access: "write",
    idempotent: true,
    input: { rule_id: uuidInput("Payee rule") },
    async run(args, { books }) {
      return answer(await applyPayeeRule(books, args.rule_id, "mcp"), (value) => value.message, counts);
    },
  }),
];
