export {
  AccountError,
  AgentAccessError,
  BankConnectionError,
  BudgetError,
  ConfigError,
  CsvImportError,
  DomainError,
  HouseholdAccessError,
  LastOwnerError,
  MembershipError,
  InviteError,
  InvalidAuthEmailError,
  InvalidCategoryError,
  PayeeCategoryRuleError,
  InvalidEstimateError,
  InvalidHistoryError,
  InvalidMoneyError,
  InvalidSetupTokenError,
  MailDeliveryError,
  ProviderAuthError,
  ProviderClaimError,
  ProviderError,
  ProviderNetworkError,
  ProviderSyncError,
  RateLimitedError,
  SplitImbalanceError,
  TokenEncryptionError,
  TransactionError,
  RecurringError,
  UnverifiedEmailError,
  UsedSetupTokenError,
} from "./errors";
export type { InviteFailureReason } from "./errors";

export {
  FORGOT_PASSWORD_FLOOR_MS,
  FORGOT_PASSWORD_MESSAGE,
  GENERIC_SIGN_IN_MESSAGE,
  RESEND_VERIFICATION_MESSAGE,
  RESEND_WINDOW_MS,
  UNVERIFIED_SIGN_IN_MESSAGE,
  consumeRateLimit,
  cooldownCopy,
  isAuthEmail,
  normalizeAuthEmail,
  rateLimitAddress,
  requestPasswordResetNotice,
  resendLimitRules,
  resendVerificationNotice,
  resetPasswordFailure,
  signInFailureFromCode,
  type LimitRule,
  type RateBucket,
  type RateLimitStore,
  type SignInFailure,
} from "./auth/recovery";

export {
  CREDIT_OWED_HINT,
  DELETE_BLOCKED_MESSAGE,
  accountAcceptsCorrection,
  accountAcceptsNewEntry,
  accountBalanceCents,
  accountTypes,
  accountsForActiveLists,
  accountsForHistory,
  archiveAccount,
  defineAccount,
  deleteAccount,
  editOpeningBalance,
  homeAccountTotalCents,
  isAccountType,
  openingBalanceCents,
  openingBalanceFields,
  renameAccount,
  unarchiveAccount,
  type AccountType,
  type LedgerAccount,
  type OpeningBalanceInput,
} from "./accounts/ledger";

export {
  acceptedMailDelivery,
  hidesSetupDetail,
  type MailDeliveryResult,
  MEMBER_MAIL_FAILURE,
  MEMBER_MAIL_READY,
  MEMBER_RESET_MAIL_FAILURE,
  MEMBER_SETUP_FAILURE,
  memberFacingMessage,
  planVerificationMail,
  rejectedMailDelivery,
  resolveGoogleSignIn,
  verificationHelpForMember,
  type GoogleSignInDecision,
  type MemberMailState,
  type VerificationMailPlan,
} from "./setup/config";

export {
  categoryBooksEffect,
  categoryKindLabel,
  categoryKinds,
  defineCategory,
  defineCategoryGroup,
  isCategoryKind,
  type CategoryBooksEffect,
  type CategoryKind,
  type DefinedCategory,
  type DefinedCategoryGroup,
} from "./categories/define";

export {
  categoryMenuSections,
  type CategoryMenuEntry,
  type CategoryMenuSection,
} from "./categories/menu";

export {
  compareCatalogOrder,
  moveCategory,
  removeCategoryGroup,
  renameCategoryGroup,
  reorderCategories,
  reorderGroups,
  shiftCategory,
  shiftGroup,
  type CatalogDirection,
  type CategoryCatalog,
  type OrganizedCategory,
  type OrganizedGroup,
} from "./categories/organize";

export {
  TRANSFER_KIND_HELP,
  categoryKindChangeWarning,
  changeCategoryKind,
  type CategoryKindChange,
  type KindChangeWarningInput,
} from "./categories/kind";

export {
  assertCents,
  expenseMagnitude,
  formatCents,
  incomeMagnitude,
  isCents,
  parseDollarInput,
  type Cents,
} from "./money/cents";

export {
  authorizeHouseholdAccess,
  emailCountsAsVerified,
  type Actor,
  type AuthProvider,
  type HouseholdGrant,
  type HouseholdRole,
  type Membership,
} from "./household/access";

export {
  DELETE_CONFIRMATION_MESSAGE,
  LAST_OWNER_MESSAGE,
  NOT_A_MEMBER_MESSAGE,
  householdRowsInScope,
  planDeleteHousehold,
  planLeaveHousehold,
  planProfileName,
  planTransferOwnership,
  signInMethod,
  type HouseholdSeat,
  type ScopedHouseholdRow,
  type SignInMethod,
} from "./household/membership";

export {
  buildSpendingHistory,
  daysInMonth,
  isPartialMonth,
  spendDirection,
  type CivilDate,
  type ExpenseLine,
  type HistoryColumn,
  type MonthChange,
  type SpendDirection,
  type YearOverYear,
} from "./history/columns";

export {
  canAddSplit,
  MAX_TRANSACTION_SPLITS,
  SPLIT_CONTROL_COPY,
  SPLIT_LIMIT_MESSAGE,
  validateSplits,
  type BalancedSplit,
  type SplitDraft,
} from "./activity/splits";

export {
  directionCategoryNotice,
  directionDefaultForKind,
  type DirectionCategoryNotice,
  type TransactionDirection,
} from "./activity/direction";

export {
  amendTransactionEntry,
  defineTransactionEntry,
  PAYEE_MAX_LENGTH,
  type TransactionEntry,
  type TransactionEntryInput,
  type TransactionEntryPatch,
} from "./activity/entry";

export {
  deleteTransaction,
  restoreTransaction,
  retainedImportFingerprints,
  type StoredTransaction,
} from "./activity/delete";

export {
  CSV_IMPORT_MAX_CHARS,
  csvTooLargeMessage,
  importCsv,
  previewCsvImport,
  resolveCsvRows,
  type CsvLedger,
  type CsvPreview,
  type CsvPreviewRow,
  type CsvRowStatus,
  type PlannedCsvRow,
  type ResolvedCsvRow,
} from "./import/csv";

export { transactionsKeptByUndo, transactionsRemovedByUndo, type ImportBatchTransaction } from "./import/undo";

export {
  inspectCsvImport,
  lookupSavedMapping,
  mappingSignature,
  parseCsvAmount,
  type AccountMode,
  type AmountMode,
  type ColumnMapping,
  type CsvInspection,
  type DateOrder,
  type SavedCsvMapping,
} from "./import/mapping";

export {
  commitMappedImport,
  previewMappedImport,
  proposeCsvMapping,
  type CommitMappedImportResult,
} from "./import/service";

export type { CsvImportStore, ImportWrite, ImportWriteResult, MappingWrite } from "./import/store";

export {
  mappedTransactionSchema,
  validateMappedImport,
  type BankBackedCharge,
  type CellError,
  type CommitCsvRow,
  type MappedField,
  type MappedImportContext,
  type MappedPreviewRow,
  type MappedValidation,
} from "./import/validate";

export {
  definePayeeCategoryRule,
  matchingPayeeRule,
  payeeRuleKey,
  type PayeeCategoryRule,
} from "./rules/payee-category";

export {
  PACE_MIN_HISTORY_DAYS,
  PACE_TRAILING_DAYS,
  buildSpendEstimate,
  estimateWindowStart,
  type EstimateCategory,
  type EstimateCategoryLine,
  type EstimateMonth,
  type EstimatePace,
  type EstimateRecurringItem,
  type EstimateSplit,
  type PaceBasis,
  type SpendEstimate,
} from "./projection/spend-estimate";

export {
  budgetStanding,
  summarizeCategoryMonth,
  planSoFar,
  type PlanSoFar,
  type BudgetStanding,
  type CategoryMonth,
} from "./plan/budget-status";

export {
  clearCategoryBudget,
  copyPreviousMonthBudgets,
  decideBudgetAmount,
  formatBudgetMonth,
  listMonthPlan,
  parseBudgetMonth,
  planSections,
  planThroughDate,
  previewCopyPreviousMonth,
  setCategoryBudget,
  shiftBudgetMonth,
  UNGROUPED_SECTION_ID,
  UNGROUPED_SECTION_NAME,
  type BudgetAmountDecision,
  type BudgetCategory,
  type BudgetMonth,
  type BudgetStore,
  type CopyBudgetLine,
  type CopyBudgetPreview,
  type CopyBudgetResult,
  type MonthPlan,
  type PlanCategoryLine,
  type PlanSection,
  type SpendSplit,
  type StoredBudget,
} from "./budget/service";

export { civilDateInTimeZone, monthLabel, shortMonthLabel, toIsoDate } from "./dates";

export {
  BANK_CONNECTION_KEYS_ENV,
  decryptToken,
  encryptToken,
  parseTokenKeyRing,
  reencryptToken,
  type EncryptedToken,
  type TokenAudience,
  type TokenKeyRing,
} from "./connections/token-cipher";

export {
  FAKE_BANK_PROVIDER_ID,
  createFakeBankProvider,
  createProviderRegistry,
  providerTransactionFingerprint,
  readProviderSetup,
  type BankProvider,
  type FakeBankProvider,
  type ProviderAccess,
  type ProviderAccount,
  type ProviderAccountType,
  type ProviderRegistry,
  type ProviderSetup,
  type ProviderSummary,
  type ProviderTransaction,
  type TransactionQuery,
} from "./connections/provider";

export {
  SIMPLEFIN_PROVIDER_ID,
  createSimpleFinProvider,
  providerDecimalToCents,
  type SimpleFinBooks,
  type SimpleFinProvider,
} from "./connections/simplefin";

export {
  PLAID_PROVIDER_ID,
  createPlaidProvider,
  plaidAmountToCents,
  plaidApiHost,
  plaidHistoryDays,
  resolvePlaidConfig,
  type PlaidConfigDecision,
  type PlaidCredentials,
  type PlaidEnv,
  type PlaidProvider,
  type PlaidSyncSnapshot,
} from "./connections/plaid";

export {
  defaultTransactionsSince,
  isIsoDate,
  planBankSync,
  planPlaidSync,
  type BankIdentity,
  type BankSyncPlan,
  type PlannedBankAccount,
  type PlannedBankLink,
  type SyncBookTransaction,
  type PlannedBankRemoval,
  type PlannedBankTransaction,
  type PlannedBankUpdate,
  type PlaidSyncPlan,
  type SyncLedgerAccount,
} from "./connections/sync";

export {
  BANK_MATCH_WINDOW_DAYS,
  civilDay,
  pairCharges,
  payeeSimilarity,
  planBankSeparation,
  shiftCivilDate,
  type BankSeparation,
  type ChargePair,
  type MatchedBookRow,
  type MatchCandidate,
  type MatchIncoming,
} from "./connections/match";

export {
  connectBank,
  createMemoryBankConnectionStore,
  createQueryBankConnectionStore,
  disconnectBank,
  toPublicBankConnection,
  type BankConnection,
  type BankConnectionQueries,
  type BankConnectionStore,
  type ConnectionDeps,
  type DisconnectResult,
  type MemoryBankConnectionStore,
  type PublicBankConnection,
} from "./connections/connect";

export {
  INVITE_MESSAGES,
  INVITE_TTL_DAYS,
  INVITE_TTL_MS,
  decideInviteAcceptance,
  deriveInviteToken,
  hashInviteToken,
  inviteError,
  inviteErrorFromText,
  inviteExpiresAt,
  inviteLinkPath,
  inviteTokenFromPaste,
  inviteState,
  isInviteToken,
  maskInviteEmail,
  planCreateInvite,
  planRevokeInvite,
  type InviteAcceptance,
  type InviteSeat,
  type InviteState,
  type InviteTimes,
  type PendingInviteRef,
} from "./household/invite";

export {
  AGENT_ACCESS_TOKEN_TTL_SECONDS,
  AGENT_MESSAGES,
  AGENT_READ_SCOPE,
  AGENT_REFRESH_SCOPE,
  AGENT_REFRESH_TOKEN_TTL_SECONDS,
  AGENT_SCOPES,
  AGENT_WRITE_SCOPE,
  accessFromScopes,
  agentAccessError,
  agentChallengeScopes,
  decideAgentGrant,
  describeAgentAccess,
  grantedScopesFor,
  requestedAgentScopes,
  requireAgentAccess,
  type AgentAccess,
  type AgentGrant,
  type AgentScopeChoice,
  type AgentTokenClaims,
} from "./agents/access";

export {
  CADENCES,
  CADENCE_LABELS,
  addDays,
  cadencePeriodDays,
  isCadence,
  isCivilDate,
  nextOccurrences,
  occurrencesBetween,
  previousOccurrence,
  type Cadence,
  type RecurringSchedule,
} from "./recurring/schedule";

export {
  RECURRING_DEFAULTS,
  RECURRING_LIMITS,
  defineRecurringItem,
  type RecurringItemDefinition,
  type RecurringItemInput,
} from "./recurring/define";

export {
  amountMatchesItem,
  amountTolerance,
  occurrenceForManualLink,
  payeeMatchesItem,
  planRecurringLinks,
  type PlannedRecurringLink,
  type RecurringDismissal,
  type RecurringLinkPlan,
  type RecurringLinkRow,
  type RecurringMatchItem,
  type RecurringMatchTransaction,
} from "./recurring/match";

export {
  expectedRecurringAmounts,
  itemOccurrences,
  nextExpectedDate,
  occurrenceStatus,
  type ExpectedRecurring,
  type OccurrenceStatus,
  type RecurringOccurrence,
  type RecurringTotals,
  type StatusItem,
  type StatusLink,
} from "./recurring/status";

export { normalizedPayee, suggestRecurringItems, type RecurringSuggestion, type SuggestionTransaction } from "./recurring/suggest";
export {
  FILTER_SOURCES,
  MEMBER_ROLES,
  RANGE_LABELS,
  RANGE_PRESETS,
  RECURRING_CHOICES,
  SEARCH_MAX_LENGTH,
  SOURCE_LABELS,
  UNCATEGORIZED,
  UNKNOWN_MEMBER,
  SAVED_FILTER_NAME_MAX,
  activeFilterCount,
  defineSavedFilterName,
  centsToDollarText,
  defineSpendingFilter,
  emptySpendingFilter,
  filterFromSearchParams,
  filterHref,
  filterToSearchParams,
  parseDollarsToCents,
  resolveFilterRange,
  spendingFilterSchema,
  type FilterSource,
  type MemberRole,
  type RangePreset,
  type RecurringChoice,
  type SpendingFilter,
  type SpendingFilterInput,
} from "./filters/spending-filter";
export { buildSpendingTrend, trendUnit, type TrendBucket, type TrendUnit } from "./filters/trend";
export { buildSpendingBreakdown, type BreakdownLine, type BreakdownSlice, type SpendingBreakdown } from "./filters/breakdown";
export {
  buildOnboardingChecklist,
  INVITE_WAITS_FOR,
  ONBOARDING_STEP_IDS,
  ONBOARDING_STEPS,
  type OnboardingChecklist,
  type OnboardingRecord,
  type OnboardingState,
  type OnboardingStep,
  type OnboardingStepDefinition,
  type OnboardingStepId,
} from "./onboarding/checklist";
export {
  FALLBACK_CATEGORIES,
  isFallbackCategory,
  needsStarterCategories,
  planStarterCategories,
  STARTER_CATEGORIES,
  type StarterGroup,
  type StarterPlan,
} from "./onboarding/starter";
