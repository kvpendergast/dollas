/**
 * UI ↔ MCP parity registry (PEN-207).
 *
 * Rule: anything a household member can do in the web app is also an MCP
 * tool on /api/mcp, calling the same slice service. Every exported server
 * action ("use server" files) and every page is listed here, mapped to the
 * tools that cover it or marked UI-only with the reason.
 *
 * src/slices/agents/parity.test.ts (run in CI) fails when an action or page
 * is missing here, an entry is stale, a named tool does not exist, or a tool
 * is not reachable from any entry. Adding a server action or page means
 * adding a line here; usually that means adding a tool next to its service.
 */

export type Parity = { tools: readonly string[] } | { uiOnly: string };

const SECRETS = "Handles a password, email, or sign-in method; agents never handle login secrets.";
const BANK_LOGIN = "Finishes a bank login with a SimpleFIN setup token or Plaid Link; agents never see bank secrets or provider tokens.";
const BEFORE_HOUSEHOLD =
  "Runs before the login has a household; an agent token is always scoped to one household, so there is nothing for it to act on.";
const SESSION = "Browser sign-in and session plumbing for the web app itself, not something a member does in their books.";
const AGENT_CONSENT = "Connecting or disconnecting an agent is the OAuth consent itself; an agent must not grant or revoke agent access.";

/** Exported server actions, by function name. */
export const ACTION_PARITY: Record<string, Parity> = {
  // accounts
  createAccountAction: { tools: ["create_account"] },
  updateAccountAction: { tools: ["update_account"] },
  archiveAccountAction: { tools: ["archive_account"] },
  unarchiveAccountAction: { tools: ["unarchive_account"] },
  deleteAccountAction: { tools: ["delete_account"] },
  // transactions
  createTransactionAction: { tools: ["create_transaction"] },
  updateTransactionAction: { tools: ["update_transaction", "categorize_transaction", "split_transaction"] },
  deleteTransactionAction: { tools: ["delete_transaction"] },
  restoreTransactionAction: { tools: ["restore_transaction"] },
  // payee rules
  createPayeeRuleAction: { tools: ["create_payee_rule"] },
  updatePayeeRuleAction: { tools: ["update_payee_rule"] },
  deletePayeeRuleAction: { tools: ["delete_payee_rule"] },
  previewPayeeRuleApplyAction: { tools: ["preview_payee_rule_apply"] },
  applyPayeeRuleAction: { tools: ["apply_payee_rule"] },
  // CSV import
  importCsvAction: { tools: ["inspect_csv", "preview_csv_import", "commit_csv_import"] },
  undoCsvImportAction: { tools: ["undo_csv_import"] },
  loadCsvImportPanel: { tools: ["list_csv_imports"] },
  // categories and groups
  createCategoryGroupAction: { tools: ["create_category_group"] },
  createCategoryAction: { tools: ["create_category"] },
  renameCategoryGroupAction: { tools: ["rename_category_group"] },
  moveCategoryAction: { tools: ["move_category"] },
  shiftCategoryGroupAction: { tools: ["reorder_category_group"] },
  shiftCategoryAction: { tools: ["reorder_category"] },
  changeCategoryKindAction: { tools: ["change_category_kind"] },
  removeCategoryGroupAction: { tools: ["remove_category_group"] },
  // plan
  setBudgetAction: { tools: ["set_budget", "clear_budget"] },
  copyPreviousMonthAction: { tools: ["copy_last_month"] },
  // household and invites
  createInviteAction: { tools: ["create_invite"] },
  copyInviteLinkAction: { tools: ["copy_invite_link"] },
  revokeInviteAction: { tools: ["revoke_invite"] },
  startHouseholdAction: { uiOnly: BEFORE_HOUSEHOLD },
  joinHouseholdAction: { uiOnly: BEFORE_HOUSEHOLD },
  acceptInviteAction: { uiOnly: BEFORE_HOUSEHOLD },
  signOutForInviteAction: { uiOnly: SESSION },
  // settings
  updateNameAction: { tools: ["update_my_name"] },
  transferOwnershipAction: { tools: ["transfer_ownership"] },
  leaveHouseholdAction: { tools: ["leave_household"] },
  deleteHouseholdAction: { tools: ["delete_household"] },
  changeEmailAction: { uiOnly: SECRETS },
  changePasswordAction: { uiOnly: SECRETS },
  // bank connections
  syncBankConnectionAction: { tools: ["sync_bank_connection"] },
  disconnectBankConnectionAction: { tools: ["disconnect_bank_connection"] },
  linkSimpleFinAction: { uiOnly: BANK_LOGIN },
  createPlaidLinkTokenAction: { uiOnly: BANK_LOGIN },
  linkPlaidAction: { uiOnly: BANK_LOGIN },
  // sign-in
  signInAction: { uiOnly: SECRETS },
  signUpAction: { uiOnly: SECRETS },
  requestPasswordResetAction: { uiOnly: SECRETS },
  resetPasswordAction: { uiOnly: SECRETS },
  resendVerificationAction: { uiOnly: SECRETS },
  signOutAction: { uiOnly: SESSION },
  readHouseholdIntent: { uiOnly: SESSION },
  clearHouseholdIntent: { uiOnly: SESSION },
  // agents
  connectAgentAction: { uiOnly: AGENT_CONSENT },
  revokeAgentAction: { uiOnly: AGENT_CONSENT },
};

/** Every page, by route (route groups removed). What a member can read there is a read tool. */
export const PAGE_PARITY: Record<string, Parity> = {
  "/": { tools: ["get_month_summary"] },
  "/accounts": { tools: ["list_accounts", "list_bank_connections"] },
  "/activity": { tools: ["list_transactions", "list_payee_rules", "list_csv_imports", "list_accounts", "list_categories"] },
  "/categories": { tools: ["list_categories"] },
  "/history": { tools: ["get_spending_history"] },
  "/household": { tools: ["list_household"] },
  "/plan": { tools: ["get_plan", "preview_copy_last_month"] },
  "/projection": { tools: ["get_spend_estimate"] },
  // The Connected agents card on this page is UI-only (AGENT_CONSENT).
  "/settings": { tools: ["get_my_profile"] },
  "/welcome": { uiOnly: BEFORE_HOUSEHOLD },
  "/invite/[token]": { uiOnly: BEFORE_HOUSEHOLD },
  "/connect-agent": { uiOnly: AGENT_CONSENT },
  "/sign-in": { uiOnly: SECRETS },
  "/sign-up": { uiOnly: SECRETS },
  "/forgot-password": { uiOnly: SECRETS },
  "/reset-password": { uiOnly: SECRETS },
  "/verify-email": { uiOnly: SECRETS },
};

/** Tools with no page or action counterpart, because only an agent needs them. */
export const AGENT_ONLY_TOOLS: Record<string, string> = {
  whoami: "Tells the agent who it acts as and with what access; the web app shows this in its chrome.",
};
