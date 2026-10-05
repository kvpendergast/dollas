import type { Sql, TransactionSql } from "postgres";

/** Role that does not own household tables and cannot bypass row-level security. */
export const APP_ROLE = "dollas_app";

/**
 * Transaction-local. Session SET ROLE does not survive Neon's pooled connections,
 * so every app transaction assumes the role before it touches household rows.
 */
export const ASSUME_APP_ROLE_SQL = "SET LOCAL ROLE dollas_app";

export type RoleSecurityFacts = {
  currentUser: string;
  superuser: boolean;
  bypassrls: boolean;
  ownsHousehold: boolean;
  forceRls: boolean;
  rlsEnabled: boolean;
};

/** True only for dollas_app when policies actually filter its rows. */
export function isSubjectToRowLevelSecurity(facts: RoleSecurityFacts): boolean {
  if (facts.currentUser !== APP_ROLE) return false;
  if (!facts.rlsEnabled) return false;
  if (facts.superuser || facts.bypassrls) return false;
  if (facts.ownsHousehold && !facts.forceRls) return false;
  return true;
}

type UnsafeParameters = Parameters<Sql["unsafe"]>[1];
type UnsafeOptions = Parameters<Sql["unsafe"]>[2];

/**
 * Drizzle calls `unsafe` for single statements and `begin` for transactions.
 * Both assume dollas_app before any household statement runs.
 */
export function asAppRole(sql: Sql): Sql {
  const assume = async (fn: (tx: TransactionSql) => Promise<unknown>): Promise<unknown> => {
    return sql.begin(async (tx) => {
      await tx.unsafe(ASSUME_APP_ROLE_SQL);
      return fn(tx);
    });
  };

  const wrapped = {
    options: sql.options,
    unsafe(query: string, parameters?: UnsafeParameters, queryOptions?: UnsafeOptions) {
      let pending: Promise<unknown> | undefined;
      let asValues: boolean | undefined;
      const run = (values: boolean) => {
        if (!pending) {
          asValues = values;
          pending = assume((tx) => {
            const queryPending = tx.unsafe(query, parameters, queryOptions);
            return values ? queryPending.values() : queryPending;
          });
        } else if (asValues !== values) {
          throw new Error("App query was read as both row objects and values");
        }
        return pending;
      };
      return {
        then<TResult1 = unknown, TResult2 = never>(
          onFulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
          onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ) {
          return run(false).then(onFulfilled, onRejected);
        },
        catch<TResult = never>(onRejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null) {
          return run(false).catch(onRejected);
        },
        finally(onFinally?: (() => void) | null) {
          return run(false).finally(onFinally);
        },
        values() {
          return run(true);
        },
      };
    },
    begin(optionsOrCallback: string | ((tx: TransactionSql) => unknown), maybeCallback?: (tx: TransactionSql) => unknown) {
      if (typeof optionsOrCallback === "function") {
        return assume((tx) => Promise.resolve(optionsOrCallback(tx)));
      }
      if (!maybeCallback) throw new Error("Transaction callback is required");
      return sql.begin(optionsOrCallback, async (tx) => {
        await tx.unsafe(ASSUME_APP_ROLE_SQL);
        return maybeCallback(tx);
      });
    },
  };

  return wrapped as unknown as Sql;
}
