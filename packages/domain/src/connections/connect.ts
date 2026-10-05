import { err, ok, type Result } from "neverthrow";
import { BankConnectionError, type DomainError } from "../errors";
import { readProviderSetup, type BankProvider, type ProviderRegistry } from "./provider";
import { decryptToken, encryptToken, type TokenKeyRing } from "./token-cipher";

export type BankConnection = {
  id: string;
  householdId: string;
  providerId: string;
  label: string;
  encryptedAccessToken: string;
  keyVersion: number;
};

/** Safe to send to the browser. The access token is not on this type. */
export type PublicBankConnection = {
  id: string;
  householdId: string;
  providerId: string;
  label: string;
};

export function toPublicBankConnection(connection: {
  id: string;
  householdId: string;
  providerId: string;
  label: string;
}): PublicBankConnection {
  return {
    id: connection.id,
    householdId: connection.householdId,
    providerId: connection.providerId,
    label: connection.label,
  };
}

export interface BankConnectionStore {
  save(connection: BankConnection): Promise<Result<void, BankConnectionError>>;
  get(householdId: string, connectionId: string): Promise<Result<BankConnection | null, BankConnectionError>>;
  list(householdId: string): Promise<Result<readonly PublicBankConnection[], BankConnectionError>>;
  /** Deletes the row, and the encrypted token with it. */
  delete(householdId: string, connectionId: string): Promise<Result<boolean, BankConnectionError>>;
}

/** Throw on failure. The store turns that into a result and does not keep the driver message. */
export type BankConnectionQueries = {
  insert(connection: BankConnection): Promise<void>;
  selectOne(householdId: string, connectionId: string): Promise<BankConnection | null>;
  selectPublic(householdId: string): Promise<readonly PublicBankConnection[]>;
  remove(householdId: string, connectionId: string): Promise<boolean>;
};

export function createQueryBankConnectionStore(queries: BankConnectionQueries): BankConnectionStore {
  return {
    async save(connection) {
      try {
        await queries.insert(connection);
        return ok(undefined);
      } catch {
        return err(new BankConnectionError("Could not save that bank connection."));
      }
    },
    async get(householdId, connectionId) {
      try {
        return ok(await queries.selectOne(householdId, connectionId));
      } catch {
        return err(new BankConnectionError("Could not read that bank connection."));
      }
    },
    async list(householdId) {
      try {
        const rows = await queries.selectPublic(householdId);
        return ok(rows.map((row) => toPublicBankConnection(row)));
      } catch {
        return err(new BankConnectionError("Could not list bank connections."));
      }
    },
    async delete(householdId, connectionId) {
      try {
        return ok(await queries.remove(householdId, connectionId));
      } catch {
        return err(new BankConnectionError("Could not delete that bank connection."));
      }
    },
  };
}

export type MemoryBankConnectionStore = BankConnectionStore & {
  encryptedTokens(householdId?: string): readonly string[];
};

export function createMemoryBankConnectionStore(): MemoryBankConnectionStore {
  const rows = new Map<string, BankConnection>();
  return {
    encryptedTokens(householdId) {
      return [...rows.values()]
        .filter((row) => householdId == null || row.householdId === householdId)
        .map((row) => row.encryptedAccessToken);
    },
    async save(connection) {
      if (rows.has(connection.id)) return err(new BankConnectionError("That bank connection already exists."));
      rows.set(connection.id, { ...connection });
      return ok(undefined);
    },
    async get(householdId, connectionId) {
      const row = rows.get(connectionId);
      if (!row || row.householdId !== householdId) return ok(null);
      return ok({ ...row });
    },
    async list(householdId) {
      return ok(
        [...rows.values()].filter((row) => row.householdId === householdId).map((row) => toPublicBankConnection(row)),
      );
    },
    async delete(householdId, connectionId) {
      const row = rows.get(connectionId);
      if (!row || row.householdId !== householdId) return ok(false);
      rows.delete(connectionId);
      return ok(true);
    },
  };
}

export type ConnectionDeps = {
  registry: ProviderRegistry;
  store: BankConnectionStore;
  keys: TokenKeyRing;
  newId?: () => string;
};

export async function connectBank(
  deps: ConnectionDeps,
  input: { householdId: string; providerId: string; setup: unknown; label?: string },
): Promise<Result<PublicBankConnection, DomainError>> {
  if (!isRecordId(input.householdId)) return err(new BankConnectionError("That household is not valid."));
  const setup = readProviderSetup(input.setup);
  if (setup.isErr()) return err(setup.error);
  const provider = deps.registry.select(input.providerId);
  if (provider.isErr()) return err(provider.error);
  const label = normalizeLabel(input.label, provider.value.label);
  if (label.isErr()) return err(label.error);

  let exchanged: Awaited<ReturnType<typeof provider.value.exchange>>;
  try {
    exchanged = await provider.value.exchange(setup.value);
  } catch {
    return err(new BankConnectionError("That provider could not exchange the setup token."));
  }
  if (exchanged.isErr()) return err(exchanged.error);

  const encrypted = await encryptToken(exchanged.value.accessToken, deps.keys, {
    householdId: input.householdId,
  });
  if (encrypted.isErr()) {
    await revokeQuietly(provider.value, exchanged.value.accessToken);
    return err(encrypted.error);
  }

  const id = deps.newId ? deps.newId() : randomConnectionId();
  if (!id) {
    await revokeQuietly(provider.value, exchanged.value.accessToken);
    return err(new BankConnectionError("Could not save that bank connection."));
  }
  const connection: BankConnection = {
    id,
    householdId: input.householdId,
    providerId: provider.value.id,
    label: label.value,
    encryptedAccessToken: encrypted.value.ciphertext,
    keyVersion: encrypted.value.keyVersion,
  };
  const saved = await deps.store.save(connection);
  if (saved.isErr()) {
    await revokeQuietly(provider.value, exchanged.value.accessToken);
    return err(saved.error);
  }
  return ok(toPublicBankConnection(connection));
}

export type DisconnectResult = {
  providerRevoked: boolean;
};

/**
 * Deletes the stored ciphertext. A failed provider revoke still removes the
 * local token: keeping the secret after the household disconnects is worse.
 */
export async function disconnectBank(
  deps: ConnectionDeps,
  input: { householdId: string; connectionId: string },
): Promise<Result<DisconnectResult, DomainError>> {
  if (!isRecordId(input.householdId) || !isRecordId(input.connectionId)) {
    return err(new BankConnectionError("That bank connection is not valid."));
  }
  const existing = await deps.store.get(input.householdId, input.connectionId);
  if (existing.isErr()) return err(existing.error);
  if (!existing.value) return err(new BankConnectionError("That bank connection is not in this household."));

  let providerRevoked = false;
  const plain = await decryptToken(existing.value.encryptedAccessToken, deps.keys, {
    householdId: input.householdId,
  });
  if (plain.isOk()) {
    const provider = deps.registry.select(existing.value.providerId);
    if (provider.isOk()) providerRevoked = await revokeQuietly(provider.value, plain.value);
  }

  const deleted = await deps.store.delete(input.householdId, input.connectionId);
  if (deleted.isErr()) return err(deleted.error);
  if (!deleted.value) return err(new BankConnectionError("That bank connection is not in this household."));
  return ok({ providerRevoked });
}

function randomConnectionId(): string | null {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return crypto?.randomUUID ? crypto.randomUUID() : null;
}

async function revokeQuietly(provider: BankProvider, accessToken: string): Promise<boolean> {
  try {
    const revoked = await provider.disconnect({ accessToken });
    return revoked.isOk();
  } catch {
    return false;
  }
}

function isRecordId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

function normalizeLabel(requested: string | undefined, fallback: string): Result<string, BankConnectionError> {
  const label = (requested ?? fallback).trim();
  if (label.length < 1 || label.length > 80 || /[\u0000-\u001f\u007f]/.test(label)) {
    return err(new BankConnectionError("Name that bank connection in 80 characters or fewer."));
  }
  return ok(label);
}
