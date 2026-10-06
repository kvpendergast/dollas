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
  constructor(message: string) {
    super("provider", message);
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
