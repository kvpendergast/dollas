import { toIsoDate } from "@dollas/domain";
import { checkToolList, type DollasTool } from "@dollas/mcp";
import { accountTools } from "@/slices/accounts/tools";
import { csvImportTools } from "@/slices/activity/csv-import-tools";
import { payeeRuleTools } from "@/slices/activity/payee-rule-tools";
import { transactionTools } from "@/slices/activity/transaction-tools";
import { booksTools } from "@/slices/books/tools";
import { categoryTools } from "@/slices/categories/tools";
import { connectionTools } from "@/slices/connections/tools";
import { householdTools } from "@/slices/household/tools";
import { planTools } from "@/slices/plan/tools";
import { recurringTools } from "@/slices/recurring/tools";
import { spendingTools } from "@/slices/spending/tools";
import { onboardingTools } from "@/slices/onboarding/tools";
import { settingsTools } from "@/slices/settings/tools";
import { tool, type AgentToolContext } from "./tool-kit";

/**
 * Every tool on /api/mcp. Each slice keeps its tools in a tools.ts next to
 * its services; add a slice's list here. src/slices/parity.ts maps every web
 * action and page to these names, and the parity test fails on a gap.
 */

const agentTools = [
  tool({
    name: "whoami",
    title: "Who am I",
    description: "The member this agent acts as, their household (name, currency, timezone, today's date there), and whether the agent can read or also write.",
    access: "read",
    input: {},
    async run(_args, { books, grant }) {
      const today = toIsoDate(books.asOf);
      return {
        ok: true,
        value: {
          member: { name: books.userName, role: books.role },
          household: { name: books.householdName, currency: books.currency, timezone: books.timezone, today },
          access: grant.access,
        },
        summary: `${books.userName} (${books.role}) in ${books.householdName}; ${grant.access === "write" ? "read and write" : "read only"}.`,
      };
    },
  }),
];

export const DOLLAS_TOOLS: readonly DollasTool<AgentToolContext>[] = [
  ...agentTools,
  ...booksTools,
  ...accountTools,
  ...transactionTools,
  ...payeeRuleTools,
  ...csvImportTools,
  ...categoryTools,
  ...planTools,
  ...recurringTools,
  ...spendingTools,
  ...onboardingTools,
  ...householdTools,
  ...settingsTools,
  ...connectionTools,
];

checkToolList(DOLLAS_TOOLS as readonly DollasTool<never>[]);

export function dollasTool(name: string): DollasTool<AgentToolContext> | undefined {
  return DOLLAS_TOOLS.find((item) => item.name === name);
}
