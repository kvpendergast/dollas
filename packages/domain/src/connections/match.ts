import { err, ok, type Result } from "neverthrow";
import { TransactionError } from "../errors";
import type { Cents } from "../money/cents";

/**
 * Cross-source matching (PEN-203): one charge that reaches the books from the
 * bank and from a CSV (or was typed by hand) is one transaction.
 *
 * Rules, applied the same way in both directions (a bank sync looking at CSV or
 * manual rows, and a CSV preview looking at bank-backed rows):
 * - Same Dollas account and the same signed amount in cents, exactly.
 * - Dates within {@link BANK_MATCH_WINDOW_DAYS} days. A bank row offers its
 *   posted date and, when the provider sends one, the authorized date; the
 *   distance is the smaller of the two. CSV exports use either.
 * - Each row pairs at most once (one bank charge to one book row).
 * - Ambiguity: when several rows qualify, pick deterministically instead of
 *   skipping. Pairs are ranked by date distance, then payee similarity (token
 *   overlap), then a live row before a soft-deleted one, then the candidate's
 *   order key and id, and claimed greedily best-first across the whole batch.
 *   Skipping would leave the exact duplicate this exists to prevent, rows that
 *   still tie are interchangeable (same account, amount, and day), and
 *   "Not the same charge" splits a wrong pick.
 */
export const BANK_MATCH_WINDOW_DAYS = 3;

export type MatchIncoming = {
  key: string;
  accountId: string;
  amountCents: Cents;
  /** The dates this row could be booked on: posted, and authorized when known. */
  dates: readonly string[];
  payee: string;
};

export type MatchCandidate = {
  id: string;
  accountId: string;
  amountCents: Cents;
  /** The candidate's book date and, for a bank-backed row, the bank's own date. */
  dates: readonly string[];
  payee: string;
  deleted: boolean;
  /** Tie-break after the scored fields; usually created-at. Lower wins. */
  order: string;
};

export type ChargePair = {
  incomingKey: string;
  candidateId: string;
  days: number;
  similarity: number;
};

/** Greedy best-first one-to-one pairing. Pure and deterministic for the same inputs in any order. */
export function pairCharges(
  incoming: readonly MatchIncoming[],
  candidates: readonly MatchCandidate[],
  windowDays: number = BANK_MATCH_WINDOW_DAYS,
): ChargePair[] {
  const byBucket = new Map<string, MatchCandidate[]>();
  for (const candidate of candidates) {
    const bucket = `${candidate.accountId}|${candidate.amountCents}`;
    const list = byBucket.get(bucket) ?? [];
    list.push(candidate);
    byBucket.set(bucket, list);
  }
  type Scored = ChargePair & { deleted: boolean; order: string };
  const scored: Scored[] = [];
  for (const row of incoming) {
    const bucket = byBucket.get(`${row.accountId}|${row.amountCents}`);
    if (!bucket) continue;
    for (const candidate of bucket) {
      const days = closestDays(row.dates, candidate.dates);
      if (days == null || days > windowDays) continue;
      scored.push({
        incomingKey: row.key,
        candidateId: candidate.id,
        days,
        similarity: payeeSimilarity(row.payee, candidate.payee),
        deleted: candidate.deleted,
        order: candidate.order,
      });
    }
  }
  scored.sort(
    (a, b) =>
      a.days - b.days ||
      b.similarity - a.similarity ||
      Number(a.deleted) - Number(b.deleted) ||
      compare(a.order, b.order) ||
      compare(a.candidateId, b.candidateId) ||
      compare(a.incomingKey, b.incomingKey),
  );
  const usedIncoming = new Set<string>();
  const usedCandidates = new Set<string>();
  const pairs: ChargePair[] = [];
  for (const pair of scored) {
    if (usedIncoming.has(pair.incomingKey) || usedCandidates.has(pair.candidateId)) continue;
    usedIncoming.add(pair.incomingKey);
    usedCandidates.add(pair.candidateId);
    pairs.push({ incomingKey: pair.incomingKey, candidateId: pair.candidateId, days: pair.days, similarity: pair.similarity });
  }
  return pairs;
}

/**
 * Jaccard overlap of payee words, 0 to 1. Lowercased, punctuation and digit
 * runs dropped ("SQ *BLUE BOTTLE #1234" and "Blue Bottle Coffee" share two of
 * four words: 0.5). Only a tie-break; it never decides whether rows match.
 */
export function payeeSimilarity(a: string, b: string): number {
  const left = payeeWords(a);
  const right = payeeWords(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

function payeeWords(payee: string): Set<string> {
  return new Set(
    payee
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((word) => word.length >= 2 && !/^\d+$/.test(word)),
  );
}

function closestDays(left: readonly string[], right: readonly string[]): number | null {
  let best: number | null = null;
  for (const a of left) {
    const da = civilDay(a);
    if (da == null) continue;
    for (const b of right) {
      const db = civilDay(b);
      if (db == null) continue;
      const days = Math.abs(da - db);
      if (best == null || days < best) best = days;
    }
  }
  return best;
}

/** Whole days since the epoch for a YYYY-MM-DD civil date. */
export function civilDay(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(ms) ? null : Math.round(ms / 86_400_000);
}

/** Civil date shifted by whole days. */
export function shiftCivilDate(value: string, days: number): string {
  const day = civilDay(value);
  if (day == null) return value;
  return new Date((day + days) * 86_400_000).toISOString().slice(0, 10);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A transaction row as "Not the same charge" sees it. */
export type MatchedBookRow = {
  id: string;
  householdId: string;
  deletedAt: string | null;
  matchedAt: string | null;
  occurredOn: string;
  payee: string;
  amountCents: Cents;
  bankOccurredOn: string | null;
  bankPayee: string | null;
  bank: { providerId: string; providerAccountId: string; providerTransactionId: string } | null;
};

export type BankSeparation = {
  /** The bank's charge as its own transaction, with the identity moved onto it. */
  bankCopy: {
    occurredOn: string;
    payee: string;
    amountCents: Cents;
    bank: { providerId: string; providerAccountId: string; providerTransactionId: string };
  };
};

/**
 * "Not the same charge": undo a link sync made. The member's row keeps its
 * edits and loses the bank identity; the bank charge becomes its own
 * transaction with the bank's date and payee. Because the identity is then on
 * the new row, the next sync does not link it back. Only rows sync linked
 * (matched) qualify; a row sync created is the bank's own copy.
 */
export function planBankSeparation(row: MatchedBookRow | null, householdId: string): Result<BankSeparation, TransactionError> {
  if (!row || row.householdId !== householdId) return err(new TransactionError("That transaction is not in this household."));
  if (!row.bank || !row.matchedAt) {
    return err(new TransactionError("That transaction was not matched to a bank charge."));
  }
  if (row.deletedAt) return err(new TransactionError("Restore that transaction first."));
  return ok({
    bankCopy: {
      occurredOn: row.bankOccurredOn ?? row.occurredOn,
      payee: row.bankPayee ?? row.payee,
      amountCents: row.amountCents,
      bank: row.bank,
    },
  });
}
