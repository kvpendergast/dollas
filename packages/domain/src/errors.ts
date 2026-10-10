/**
 * Typed failures for household books. Domain code returns these inside
 * neverthrow Results. Callers outside the domain package unwrap them.
 */
export class DomainError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/**
 * Deployer detail for a missing or partial integration setting.
 * The message may name configuration keys. Members never see it;
 * callers map it through `memberFacingMessage` and log this object.
 */
export class ConfigError extends DomainError {
  constructor(message: string) {
    super("config", message);
  }
}

/** Provider delivery failed. Detail is for logs; members get a plain next step. */
export class MailDeliveryError extends DomainError {
  constructor(message: string) {
    super("mail_delivery", message);
  }
}

export class InvalidMoneyError extends DomainError {
  constructor(message: string) {
    super("invalid_money", message);
  }
}

export class UnverifiedEmailError extends DomainError {
  constructor(
    message = "Verify your email before opening household books. Google sign-in counts as verified.",
  ) {
    super("unverified_email", message);
  }
}

export class HouseholdAccessError extends DomainError {
  constructor(message = "You are not a member of this household.") {
    super("household_access_denied", message);
  }
}

/** A membership change the member can correct. The message is safe to show. */
export class MembershipError extends DomainError {
  constructor(message: string) {
    super("membership", message);
  }
}

/** The only owner tried to leave. Hand off or delete the household first. */
export class LastOwnerError extends DomainError {
  constructor(message = "You are the last owner. Hand ownership to another member, or delete the household, before you leave.") {
    super("last_owner", message);
  }
}

export class SplitImbalanceError extends DomainError {
  constructor(message: string) {
    super("split_imbalance", message);
  }
}

export class InvalidHistoryError extends DomainError {
  constructor(message: string) {
    super("invalid_history", message);
  }
}

export class InvalidEstimateError extends DomainError {
  constructor(message: string) {
    super("invalid_estimate", message);
  }
}

export class CsvImportError extends DomainError {
  constructor(message: string) {
    super("csv_import", message);
  }
}

export class InvalidCategoryError extends DomainError {
  constructor(message: string) {
    super("invalid_category", message);
  }
}

export class PayeeCategoryRuleError extends DomainError {
  constructor(message: string) {
    super("payee_category_rule", message);
  }
}

export class ProviderError extends DomainError {
  constructor(message: string, code = "provider") {
    super(code, message);
  }
}

export class InvalidSetupTokenError extends ProviderError {
  constructor(message = "That setup token is not valid. Paste a new one from your bank.") {
    super(message, "invalid_setup_token");
  }
}

export class UsedSetupTokenError extends ProviderError {
  constructor(message = "That setup token was already used. Create a new one and paste it again.") {
    super(message, "used_setup_token");
  }
}

export class ProviderClaimError extends ProviderError {
  constructor(
    message = "The bank could not finish linking. Wait a moment, then paste a new setup token.",
  ) {
    super(message, "provider_claim");
  }
}

export class ProviderAuthError extends ProviderError {
  constructor(
    message = "The bank rejected this connection. Disconnect it and link SimpleFIN again with a new setup token.",
  ) {
    super(message, "provider_auth");
  }
}

export class ProviderNetworkError extends ProviderError {
  constructor(message = "Could not reach the bank. Try syncing again.") {
    super(message, "provider_network");
  }
}

export class ProviderSyncError extends ProviderError {
  constructor(message = "The bank sent accounts Dollas could not read. Try syncing again.") {
    super(message, "provider_sync");
  }
}

export class TokenEncryptionError extends DomainError {
  constructor(message: string) {
    super("token_encryption", message);
  }
}

export class BankConnectionError extends DomainError {
  constructor(message: string) {
    super("bank_connection", message);
  }
}

export class BudgetError extends DomainError {
  constructor(message: string) {
    super("budget", message);
  }
}

export class AccountError extends DomainError {
  constructor(message: string) {
    super("account", message);
  }
}

export class InvalidAuthEmailError extends DomainError {
  constructor(message = "Enter the email you use for the books.") {
    super("invalid_auth_email", message);
  }
}

export class RateLimitedError extends DomainError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number, message: string) {
    super("rate_limited", message);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class TransactionError extends DomainError {
  constructor(message: string) {
    super("transaction", message);
  }
}

/**
 * A household invite that cannot be created, revoked, or accepted.
 * `reason` lets the accept page pick a next step. The message is safe to show.
 */
export class InviteError extends DomainError {
  readonly reason: InviteFailureReason;

  constructor(reason: InviteFailureReason, message: string) {
    super("invite", message);
    this.reason = reason;
  }
}

export type InviteFailureReason =
  | "not_owner"
  | "invalid_email"
  | "already_member"
  | "already_invited"
  | "not_found"
  | "not_pending"
  | "revoked"
  | "expired"
  | "used"
  | "wrong_email"
  | "unverified"
  | "other_household";

/**
 * An agent (MCP client) request that Dollas refuses. `reason` picks the HTTP
 * answer: missing or dead credentials are 401, a scope the grant lacks is 403.
 * The message is safe to show to the member or the agent.
 */
export class AgentAccessError extends DomainError {
  readonly reason: AgentAccessFailureReason;

  constructor(reason: AgentAccessFailureReason, message: string) {
    super("agent_access", message);
    this.reason = reason;
  }
}

export type AgentAccessFailureReason =
  | "missing_token"
  | "invalid_token"
  | "no_household"
  | "insufficient_scope"
  | "revoked"
  | "invalid_scope_choice";
