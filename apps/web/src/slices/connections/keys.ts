import { BANK_CONNECTION_KEYS_ENV, parseTokenKeyRing, type TokenKeyRing } from "@dollas/domain";

/** Throws a typed error when the key ring is missing or not 32-byte AES keys. */
export function requireBankConnectionKeys(raw = process.env[BANK_CONNECTION_KEYS_ENV]): TokenKeyRing {
  const parsed = parseTokenKeyRing(raw);
  if (parsed.isErr()) throw parsed.error;
  return parsed.value;
}
