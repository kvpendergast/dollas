import { categoryKinds } from "@dollas/domain";
import { z } from "zod";
import { answer, plural, tool, uuidInput } from "@/slices/agents/tool-kit";
import {
  changeKind,
  createCategory,
  createCategoryGroup,
  listCategories,
  moveCategoryToGroup,
  removeGroup,
  renameGroup,
  shiftCategoryOrder,
  shiftGroupOrder,
} from "./service";

const directionInput = z.enum(["up", "down"]).describe("Move one place up or down.");

export const categoryTools = [
  tool({
    name: "list_categories",
    title: "List categories",
    description:
      "Every category group in order with its categories (id, name, kind: income, expense, or transfer; budget_count is how many months have a budget), plus ungrouped categories. The whole catalog in one response.",
    access: "read",
    input: {},
    async run(_args, { books }) {
      return answer(
        await listCategories(books),
        (catalog) =>
          `${plural(catalog.groups.length, "group")}, ${plural(
            catalog.groups.reduce((sum, group) => sum + group.categories.length, 0) + catalog.ungrouped.length,
            "category",
            "categories",
          )}.`,
        (catalog) => {
          const shown = (row: { id: string; name: string; kind: string; budgetCount: number }) => ({
            id: row.id,
            name: row.name,
            kind: row.kind,
            budget_count: row.budgetCount,
          });
          return {
            groups: catalog.groups.map((group) => ({ id: group.id, name: group.name, categories: group.categories.map(shown) })),
            ungrouped: catalog.ungrouped.map(shown),
          };
        },
      );
    },
  }),
  tool({
    name: "create_category_group",
    title: "Create category group",
    description: "Add a category group at the end of the list.",
    access: "write",
    input: { name: z.string().min(1).max(60).describe("Group name.") },
    async run(args, { books }) {
      return answer(await createCategoryGroup(books, args.name, "mcp"), (value) => `Added the ${value.name} group.`);
    },
  }),
  tool({
    name: "rename_category_group",
    title: "Rename category group",
    description: "Rename a category group.",
    access: "write",
    idempotent: true,
    input: { group_id: uuidInput("Group"), name: z.string().min(1).max(60).describe("New name.") },
    async run(args, { books }) {
      return answer(await renameGroup(books, args.group_id, args.name, "mcp"), () => `Renamed the group to ${args.name}.`);
    },
  }),
  tool({
    name: "remove_category_group",
    title: "Remove category group",
    description:
      "Remove a category group. If it still has categories, say where they go: destination_group_id, or ungrouped: true. Categories and their transactions are kept.",
    access: "write",
    input: {
      group_id: uuidInput("Group"),
      destination_group_id: uuidInput("Group that receives its categories").optional(),
      ungrouped: z.boolean().optional().describe("Leave its categories ungrouped instead."),
    },
    async run(args, { books }) {
      if (args.destination_group_id && args.ungrouped) return { ok: false, message: "Choose a destination group or ungrouped, not both." };
      const destination = args.destination_group_id ?? (args.ungrouped ? null : undefined);
      return answer(await removeGroup(books, args.group_id, destination, "mcp"), () => "Removed that group.");
    },
  }),
  tool({
    name: "create_category",
    title: "Create category",
    description: "Add a category to a group. Kind is income, expense (budgetable spending), or transfer (moves between accounts; not income or spending).",
    access: "write",
    input: {
      name: z.string().min(1).max(60).describe("Category name."),
      kind: z.enum(categoryKinds).describe("income, expense, or transfer."),
      group_id: uuidInput("Group"),
    },
    async run(args, { books }) {
      const created = await createCategory(books, { name: args.name, kind: args.kind, groupId: args.group_id }, "mcp");
      return answer(created, (value) => `Added ${value.name}.`, (value) => ({ id: value.id, name: value.name, kind: value.kind, group_id: value.groupId }));
    },
  }),
  tool({
    name: "move_category",
    title: "Move category",
    description: "Move a category to another group, or out of every group with ungrouped: true.",
    access: "write",
    idempotent: true,
    input: {
      category_id: uuidInput("Category"),
      group_id: uuidInput("Destination group").optional(),
      ungrouped: z.boolean().optional().describe("Move it out of every group."),
    },
    async run(args, { books }) {
      if (Boolean(args.group_id) === Boolean(args.ungrouped)) return { ok: false, message: "Give group_id or ungrouped: true." };
      return answer(await moveCategoryToGroup(books, args.category_id, args.group_id ?? null, "mcp"), () => "Moved that category.");
    },
  }),
  tool({
    name: "reorder_category_group",
    title: "Reorder category group",
    description: "Move a category group one place up or down in the list.",
    access: "write",
    input: { group_id: uuidInput("Group"), direction: directionInput },
    async run(args, { books }) {
      return answer(await shiftGroupOrder(books, args.group_id, args.direction, "mcp"), () => `Moved that group ${args.direction}.`);
    },
  }),
  tool({
    name: "reorder_category",
    title: "Reorder category",
    description: "Move a category one place up or down within its group.",
    access: "write",
    input: { category_id: uuidInput("Category"), direction: directionInput },
    async run(args, { books }) {
      return answer(await shiftCategoryOrder(books, args.category_id, args.direction, "mcp"), () => `Moved that category ${args.direction}.`);
    },
  }),
  tool({
    name: "change_category_kind",
    title: "Change category kind",
    description:
      "Change a category between income, expense, and transfer. Only expense categories have budgets; leaving expense removes its budgets and needs confirm_budget_removal: true.",
    access: "write",
    idempotent: true,
    input: {
      category_id: uuidInput("Category"),
      kind: z.enum(categoryKinds),
      confirm_budget_removal: z.boolean().optional().describe("Set true, after asking the member, to remove this category's budgets."),
    },
    async run(args, { books }) {
      const changed = await changeKind(
        books,
        { categoryId: args.category_id, kind: args.kind, confirmBudgetRemoval: args.confirm_budget_removal === true },
        "mcp",
      );
      return answer(changed, (value) => `Changed that category to ${args.kind}.${value.removedBudgets ? " Its budgets were removed." : ""}`, (value) => ({
        removed_budgets: value.removedBudgets,
      }));
    },
  }),
];
