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
