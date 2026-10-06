import { DomainError, hidesSetupDetail, memberFacingMessage } from "@dollas/domain";

export const BANK_SETUP_UNAVAILABLE =
  "Bank connections are not available right now. Ask whoever runs Dollas to check the server, then try again.";

/**
 * Bank form copy. Typed book errors keep their plain next step.
 * Config, encryption, and raw provider failures stay in the server log.
 */
export function memberBankMessage(error: unknown, fallback: string): string {
  if (!(error instanceof DomainError)) return fallback;
  const shownFallback = hidesSetupDetail(error) ? BANK_SETUP_UNAVAILABLE : fallback;
  return memberFacingMessage(error, shownFallback);
}
