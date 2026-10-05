import { describe, expect, it } from "vitest";
import { BankConnectionError, ProviderError, TokenEncryptionError } from "../errors";
import {
  connectBank,
  createMemoryBankConnectionStore,
  createQueryBankConnectionStore,
  disconnectBank,
} from "./connect";
import {
  createFakeBankProvider,
  createProviderRegistry,
  providerTransactionFingerprint,
  readProviderSetup,
} from "./provider";
import { parseTokenKeyRing } from "./token-cipher";

const houseA = "house-a";
const houseB = "house-b";
const password = "hunter2-bank-password";

function keys() {
  const bytes = new Uint8Array(32).fill(4);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const parsed = parseTokenKeyRing(`1:${(globalThis as { btoa: (value: string) => string }).btoa(binary)}`);
  if (parsed.isErr()) throw parsed.error;
  return parsed.value;
}

function deps(options?: { failDisconnect?: boolean }) {
  const provider = createFakeBankProvider({ failDisconnect: options?.failDisconnect });
  const registry = createProviderRegistry();
  const registered = registry.register(provider);
  if (registered.isErr()) throw registered.error;
  const store = createMemoryBankConnectionStore();
  let n = 0;
  return {
    provider,
    store,
    registry,
    connection: {
      registry,
      store,
      keys: keys(),
      newId: () => `connection-${++n}`,
    },
  };
}

describe("bank connections", () => {
  it("stores only ciphertext and returns no token to the caller", async () => {
    const { provider, store, connection } = deps();
    const connected = await connectBank(connection, {
      householdId: houseA,
      providerId: "fake",
      setup: { token: "setup-token-from-the-provider" },
      label: "Demo bank",
    });
    if (connected.isErr()) throw connected.error;
    expect(connected.value).toEqual({
      id: "connection-1",
      householdId: houseA,
      providerId: "fake",
      label: "Demo bank",
    });
    expect(connected.value).not.toHaveProperty("accessToken");
    expect(connected.value).not.toHaveProperty("encryptedAccessToken");
    const issued = provider.issuedAccessTokens()[0];
    expect(issued).toBeTruthy();
    const stored = store.encryptedTokens();
    expect(stored).toHaveLength(1);
    expect(stored[0]).not.toContain(issued);
    expect(stored[0]).not.toContain("setup-token-from-the-provider");
    expect(JSON.stringify(connected.value)).not.toContain(issued);
    const listed = await store.list(houseA);
    if (listed.isErr()) throw listed.error;
    expect(JSON.stringify(listed.value)).not.toContain(issued);
    expect(listed.value[0]).not.toHaveProperty("encryptedAccessToken");
  });

  it("refuses a bank username or password and stores nothing", async () => {
    const { store, connection } = deps();
    const rejected = await connectBank(connection, {
      householdId: houseA,
      providerId: "fake",
      setup: { username: "ada", password, token: "should-not-be-stored" },
    });
    const pasted = readProviderSetup({ token: `user=ada&password=${password}` });
    const json = readProviderSetup({ token: JSON.stringify({ password }) });
    expect(rejected.isErr()).toBe(true);
    expect(pasted.isErr()).toBe(true);
    expect(json.isErr()).toBe(true);
    if (rejected.isOk() || pasted.isOk() || json.isOk()) return;
    expect(rejected.error).toBeInstanceOf(ProviderError);
    for (const error of [rejected.error, pasted.error, json.error]) {
      expect(error.message).not.toContain(password);
      expect(error.message).not.toContain("ada");
      expect(error.message).not.toContain("should-not-be-stored");
    }
    expect(store.encryptedTokens()).toEqual([]);
  });

  it("deletes the token on disconnect, including when the provider cannot revoke", async () => {
    const happy = deps();
    const connected = await connectBank(happy.connection, {
      householdId: houseA,
      providerId: "fake",
      setup: { token: "setup-token-from-the-provider" },
    });
    if (connected.isErr()) throw connected.error;
    const removed = await disconnectBank(happy.connection, {
      householdId: houseA,
      connectionId: connected.value.id,
    });
    if (removed.isErr()) throw removed.error;
    expect(removed.value).toEqual({ providerRevoked: true });
    expect(removed.value).not.toHaveProperty("accessToken");
    expect(happy.store.encryptedTokens()).toEqual([]);
    expect(happy.provider.revokedAccessTokens()).toEqual(happy.provider.issuedAccessTokens());
    const listed = await happy.store.list(houseA);
    if (listed.isErr()) throw listed.error;
    expect(listed.value).toEqual([]);
    const again = await disconnectBank(happy.connection, {
      householdId: houseA,
      connectionId: connected.value.id,
    });
    expect(again.isErr()).toBe(true);
    if (again.isOk()) return;
    expect(again.error).toBeInstanceOf(BankConnectionError);

    const failing = deps({ failDisconnect: true });
    const second = await connectBank(failing.connection, {
      householdId: houseA,
      providerId: "fake",
      setup: { token: "another-setup-token" },
    });
    if (second.isErr()) throw second.error;
    const forced = await disconnectBank(failing.connection, {
      householdId: houseA,
      connectionId: second.value.id,
    });
    if (forced.isErr()) throw forced.error;
    expect(forced.value.providerRevoked).toBe(false);
    expect(failing.store.encryptedTokens()).toEqual([]);
  });

  it("does not read or delete another household's token", async () => {
    const { store, connection } = deps();
    const first = await connectBank(connection, {
      householdId: houseA,
      providerId: "fake",
      setup: { token: "setup-token-a" },
    });
    const second = await connectBank(connection, {
      householdId: houseB,
      providerId: "fake",
      setup: { token: "setup-token-b" },
    });
    if (first.isErr()) throw first.error;
    if (second.isErr()) throw second.error;
    const crossGet = await store.get(houseA, second.value.id);
    const crossDelete = await store.delete(houseA, second.value.id);
    if (crossGet.isErr()) throw crossGet.error;
    if (crossDelete.isErr()) throw crossDelete.error;
    expect(crossGet.value).toBeNull();
    expect(crossDelete.value).toBe(false);
    expect(store.encryptedTokens(houseB)).toHaveLength(1);
    const disconnected = await disconnectBank(connection, {
      householdId: houseA,
      connectionId: second.value.id,
    });
    expect(disconnected.isErr()).toBe(true);
    expect(store.encryptedTokens(houseB)).toHaveLength(1);
    expect(store.encryptedTokens(houseA)).toHaveLength(1);
  });

  it("strips a token that a query accidentally returns", async () => {
    const leaked = "v1.iv.ciphertext-should-not-leak";
    const store = createQueryBankConnectionStore({
      async insert() {},
      async selectOne() {
        return null;
      },
      async selectPublic() {
        return [
          {
            id: "connection-1",
            householdId: houseA,
            providerId: "fake",
            label: "Demo bank",
            encryptedAccessToken: leaked,
          } as { id: string; householdId: string; providerId: string; label: string },
        ];
      },
      async remove() {
        return false;
      },
    });
    const listed = await store.list(houseA);
    if (listed.isErr()) throw listed.error;
    expect(listed.value[0]).toEqual({
      id: "connection-1",
      householdId: houseA,
      providerId: "fake",
      label: "Demo bank",
    });
    expect(JSON.stringify(listed.value)).not.toContain(leaked);
  });

  it("gives synced transactions a stable fingerprint distinct from a CSV row", () => {
    const first = providerTransactionFingerprint("simplefin", "txn/rent:1");
    const second = providerTransactionFingerprint("simplefin", "txn/rent:1");
    const other = providerTransactionFingerprint("fake", "txn-rent");
    if (first.isErr() || second.isErr() || other.isErr()) throw new Error("fingerprint");
    expect(first.value).toBe(second.value);
    expect(first.value.startsWith("bank:")).toBe(true);
    expect(first.value).not.toBe(other.value);
    expect(first.value).not.toMatch(/^[0-9a-f]{64}:\d+$/);
  });

  it("does not connect an unknown provider", async () => {
    const { connection, store } = deps();
    const missing = await connectBank(connection, {
      householdId: houseA,
      providerId: "simplefin",
      setup: { token: "claim-token" },
    });
    expect(missing.isErr()).toBe(true);
    if (missing.isOk()) return;
    expect(missing.error).toBeInstanceOf(ProviderError);
    expect(store.encryptedTokens()).toEqual([]);
  });

  it("lists accounts and transactions from the fake provider until disconnect", async () => {
    const provider = createFakeBankProvider();
    const exchanged = await provider.exchange({ token: "setup-token-from-the-provider" });
    if (exchanged.isErr()) throw exchanged.error;
    const accounts = await provider.listAccounts(exchanged.value);
    const transactions = await provider.fetchTransactions(exchanged.value, { since: "2026-01-01" });
    if (accounts.isErr() || transactions.isErr()) throw new Error("fetch");
    expect(accounts.value[0]?.balanceCents).toBe(245_000);
    expect(transactions.value[0]?.amountCents).toBe(-180_000);
    expect(Number.isInteger(transactions.value[0]?.amountCents)).toBe(true);
    const fingerprint = providerTransactionFingerprint("fake", transactions.value[0].providerTransactionId);
    if (fingerprint.isErr()) throw fingerprint.error;
    expect(fingerprint.value).toBe("bank:fake:txn-rent");
    await provider.disconnect(exchanged.value);
    const after = await provider.fetchTransactions(exchanged.value, {});
    expect(after.isErr()).toBe(true);
  });
});

describe("missing encryption key", () => {
  it("is a typed error and does not invent a plaintext store", async () => {
    const parsed = parseTokenKeyRing(undefined);
    expect(parsed.isErr()).toBe(true);
    if (parsed.isOk()) return;
    expect(parsed.error).toBeInstanceOf(TokenEncryptionError);
    const provider = createFakeBankProvider();
    const registry = createProviderRegistry();
    registry.register(provider);
    const store = createMemoryBankConnectionStore();
    const connected = await connectBank(
      { registry, store, keys: { current: 1, keys: new Map() } },
      { householdId: houseA, providerId: "fake", setup: { token: "setup-token-from-the-provider" } },
    );
    expect(connected.isErr()).toBe(true);
    if (connected.isOk()) return;
    expect(connected.error).toBeInstanceOf(TokenEncryptionError);
    expect(store.encryptedTokens()).toEqual([]);
    expect(provider.revokedAccessTokens()).toEqual(provider.issuedAccessTokens());
  });
});
