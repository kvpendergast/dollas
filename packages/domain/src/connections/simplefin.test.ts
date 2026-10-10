import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  InvalidSetupTokenError,
  ProviderAuthError,
  ProviderClaimError,
  ProviderNetworkError,
  ProviderSyncError,
  UsedSetupTokenError,
} from "../errors";
import { connectBank, createMemoryBankConnectionStore } from "./connect";
import { createProviderRegistry } from "./provider";
import { createSimpleFinProvider, providerDecimalToCents, type SimpleFinProvider } from "./simplefin";
import { bankBookRow, legacyBookRow } from "./book-fixtures";
import { planBankSync } from "./sync";
import { parseTokenKeyRing } from "./token-cipher";

const PASSWORD = "demo-pass";
const USER = "demo-user";
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("provider decimals", () => {
  it("maps SimpleFIN amounts to integer cents and refuses extra precision", () => {
    const dollars = providerDecimalToCents("100.23");
    const negative = providerDecimalToCents("-48.2");
    const trailing = providerDecimalToCents("1.2300");
    const extra = providerDecimalToCents("1.234");
    if (dollars.isErr() || negative.isErr() || trailing.isErr()) throw new Error("cents");
    expect(dollars.value).toBe(10_023);
    expect(negative.value).toBe(-4_820);
    expect(trailing.value).toBe(123);
    expect(extra.isErr()).toBe(true);
    if (extra.isOk()) return;
    expect(extra.error).toBeInstanceOf(ProviderSyncError);
    expect(extra.error.message).not.toContain("1.234");
  });
});

describe("SimpleFIN claim", () => {
  it("base64-decodes the setup token, POSTs the claim URL once, and returns the access URL", async () => {
    const bridge = await startBridge();
    const provider = providerFor();
    const token = setupToken(bridge.port, "fresh-token");
    const first = await provider.exchange({ token });
    if (first.isErr()) throw first.error;
    expect(bridge.posts).toEqual(["/simplefin/claim/fresh-token"]);
    expect(first.value.accessToken).toBe(`http://${USER}:${PASSWORD}@127.0.0.1:${bridge.port}/simplefin`);
    const second = await provider.exchange({ token });
    expect(second.isErr()).toBe(true);
    if (second.isOk()) return;
    expect(second.error).toBeInstanceOf(UsedSetupTokenError);
    expect(second.error.code).toBe("used_setup_token");
    expect(second.error.message).toContain("paste it again");
    expect(second.error.message).not.toContain(token);
    expect(second.error.message).not.toContain(PASSWORD);
    expect(bridge.posts).toHaveLength(2);
  });

  it("rejects a bad token before any request", async () => {
    let called = false;
    const provider = createSimpleFinProvider({
      allowLoopback: true,
      fetch: async () => {
        called = true;
        throw new Error("should not fetch");
      },
    });
    const rejected = await provider.exchange({ token: "not-a-setup-token!!!" });
    expect(called).toBe(false);
    expect(rejected.isErr()).toBe(true);
    if (rejected.isOk()) return;
    expect(rejected.error).toBeInstanceOf(InvalidSetupTokenError);
    expect(rejected.error.message).toContain("Paste a new one");
    expect(rejected.error.message).not.toContain("BANK_");
  });

  it("maps a claim failure without echoing the bridge body", async () => {
    const bridge = await startBridge();
    bridge.claimStatus = 500;
    bridge.claimBody = `http://${USER}:${PASSWORD}@127.0.0.1:${bridge.port}/simplefin`;
    const provider = providerFor();
    const failed = await provider.exchange({ token: setupToken(bridge.port, "boom") });
    expect(failed.isErr()).toBe(true);
    if (failed.isOk()) return;
    expect(failed.error).toBeInstanceOf(ProviderClaimError);
    expect(failed.error.message).toContain("new setup token");
    expect(failed.error.message).not.toContain(PASSWORD);
    expect(failed.error.message).not.toContain("127.0.0.1");
    expect(failed.error.message).not.toContain("BANK_");
  });

  it("maps a network failure on claim", async () => {
    const provider = createSimpleFinProvider({
      allowLoopback: true,
      fetch: async () => {
        throw new Error(`connect ECONNREFUSED http://${USER}:${PASSWORD}@127.0.0.1:9/simplefin`);
      },
    });
    const failed = await provider.exchange({ token: btoa("http://127.0.0.1:9/simplefin/claim/one") });
    expect(failed.isErr()).toBe(true);
    if (failed.isOk()) return;
    expect(failed.error).toBeInstanceOf(ProviderClaimError);
    expect(failed.error.message).not.toContain(PASSWORD);
    expect(failed.error.message).not.toContain("ECONNREFUSED");
  });
});

describe("SimpleFIN sync", () => {
  it("requests start-date, drops pending rows, and maps balances and transactions to cents", async () => {
    const bridge = await startBridge();
    const provider = providerFor();
    const access = await provider.exchange({ token: setupToken(bridge.port, "sync-token") });
    if (access.isErr()) throw access.error;
    const since = "2026-02-01";
    const books = await provider.readBooks(access.value, { since });
    if (books.isErr()) throw books.error;
    expect(bridge.accountQueries[0]).toContain(`start-date=${isoToUnix(since)}`);
    expect(bridge.accountQueries[0]).not.toContain("pending=1");
    expect(bridge.authorizations[0]).toBe(basicAuth(USER, PASSWORD));
    expect(books.value.accounts).toEqual([
      {
        providerAccountId: "act-checking",
        name: "Checking",
        type: "checking",
        currency: "USD",
        balanceCents: 10_023,
      },
      {
        providerAccountId: "act-card",
        name: "Visa card",
        type: "credit",
        currency: "USD",
        balanceCents: -2_000,
      },
    ]);
    expect(books.value.transactions.map((row) => row.providerTransactionId)).toEqual(["txn-groceries"]);
    expect(books.value.transactions[0]?.amountCents).toBe(-1_850);
    expect(books.value.transactions[0]?.pending).toBe(false);

    const pending = await provider.fetchTransactions(access.value, { since, includePending: true });
    if (pending.isErr()) throw pending.error;
    expect(bridge.accountQueries[1]).toContain("pending=1");
    expect(pending.value.map((row) => row.providerTransactionId).sort()).toEqual(["txn-coffee", "txn-groceries"]);
  });

  it("maps auth and network failures on sync to plain next steps", async () => {
    const bridge = await startBridge();
    const provider = providerFor();
    const access = await provider.exchange({ token: setupToken(bridge.port, "auth-token") });
    if (access.isErr()) throw access.error;
    bridge.accountsStatus = 403;
    bridge.accountsBody = access.value.accessToken;
    const rejected = await provider.readBooks(access.value, {});
    expect(rejected.isErr()).toBe(true);
    if (rejected.isOk()) return;
    expect(rejected.error).toBeInstanceOf(ProviderAuthError);
    expect(rejected.error.message).toContain("Disconnect it");
    expect(rejected.error.message).not.toContain(PASSWORD);
    expect(rejected.error.message).not.toContain(access.value.accessToken);

    const offline = createSimpleFinProvider({
      allowLoopback: true,
      fetch: async () => {
        throw new Error(`network down ${access.value.accessToken}`);
      },
    });
    const failed = await offline.readBooks(access.value, { since: "2026-02-01" });
    expect(failed.isErr()).toBe(true);
    if (failed.isOk()) return;
    expect(failed.error).toBeInstanceOf(ProviderNetworkError);
    expect(failed.error.message).toContain("Try syncing again");
    expect(failed.error.message).not.toContain(PASSWORD);
  });

  it("plans an idempotent sync that skips deleted fingerprints", async () => {
    const bridge = await startBridge();
    const provider = providerFor();
    const access = await provider.exchange({ token: setupToken(bridge.port, "plan-token") });
    if (access.isErr()) throw access.error;
    const books = await provider.readBooks(access.value, { since: "2026-01-01" });
    if (books.isErr()) throw books.error;
    const householdId = "house-a";
    const first = planBankSync({
      providerId: "simplefin",
      householdId,
      accounts: books.value.accounts,
      transactions: books.value.transactions,
      ledgerAccounts: [],
      links: [],
      books: [legacyBookRow(householdId, "bank:simplefin:txn-rent", "2026-04-01T00:00:00.000Z")],
      rules: [{ pattern: "Market", categoryId: "cat-groceries" }],
    });
    if (first.isErr()) throw first.error;
    const checking = first.value.accounts.find((account) => account.providerAccountId === "act-checking");
    const card = first.value.accounts.find((account) => account.providerAccountId === "act-card");
    if (!checking || checking.kind !== "create" || !card || card.kind !== "create") throw new Error("accounts");
    expect(checking.openingBalanceCents).toBe(10_023 - -1_850);
    expect(checking.balanceCents).toBe(10_023);
    expect(card.type).toBe("credit");
    expect(card.openingBalanceCents).toBe(-2_000);
    expect(first.value.transactions.map((row) => row.providerTransactionId)).toEqual(["txn-groceries"]);
    expect(first.value.transactions[0]?.categoryId).toBe("cat-groceries");
    expect(first.value.transactions.some((row) => row.providerTransactionId === "txn-rent")).toBe(false);
    expect(first.value.transactions.some((row) => row.providerTransactionId === "txn-coffee")).toBe(false);

    const again = planBankSync({
      providerId: "simplefin",
      householdId,
      accounts: books.value.accounts,
      transactions: books.value.transactions,
      ledgerAccounts: [],
      links: first.value.accounts.map((account, index) => ({
        providerAccountId: account.providerAccountId,
        ledgerAccountId: `ledger-${index}`,
      })),
      books: [
        legacyBookRow(householdId, "bank:simplefin:txn-rent", "2026-04-01T00:00:00.000Z"),
        ...first.value.transactions.map((row) =>
          bankBookRow(householdId, {
            providerId: "simplefin",
            providerAccountId: row.providerAccountId,
            providerTransactionId: row.providerTransactionId,
          }),
        ),
      ],
      rules: [],
    });
    if (again.isErr()) throw again.error;
    expect(again.value.transactions).toEqual([]);
    expect(again.value.accounts.every((account) => account.kind === "update")).toBe(true);
  });

  it("stores only the encrypted access URL", async () => {
    const bridge = await startBridge();
    const provider = providerFor();
    const registry = createProviderRegistry();
    const registered = registry.register(provider);
    if (registered.isErr()) throw registered.error;
    const store = createMemoryBankConnectionStore();
    const token = setupToken(bridge.port, "store-token");
    const connected = await connectBank(
      { registry, store, keys: keys(), newId: () => "connection-1" },
      { householdId: "house-a", providerId: "simplefin", setup: { token }, label: "Credit union" },
    );
    if (connected.isErr()) throw connected.error;
    expect(connected.value).toEqual({
      id: "connection-1",
      householdId: "house-a",
      providerId: "simplefin",
      label: "Credit union",
    });
    const stored = store.encryptedTokens()[0] ?? "";
    expect(stored.startsWith("v1.")).toBe(true);
    expect(stored).not.toContain(token);
    expect(stored).not.toContain(PASSWORD);
    expect(stored).not.toContain("demo-user");
    expect(JSON.stringify(connected.value)).not.toContain(PASSWORD);
  });
});

function providerFor(): SimpleFinProvider {
  return createSimpleFinProvider({ allowLoopback: true });
}

function keys() {
  const bytes = new Uint8Array(32).fill(4);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const parsed = parseTokenKeyRing(`1:${btoa(binary)}`);
  if (parsed.isErr()) throw parsed.error;
  return parsed.value;
}

function setupToken(port: number, id: string): string {
  return btoa(`http://127.0.0.1:${port}/simplefin/claim/${id}`);
}

function isoToUnix(iso: string): number {
  return Math.floor(Date.parse(`${iso}T00:00:00Z`) / 1000);
}

function basicAuth(username: string, password: string): string {
  return `Basic ${btoa(`${username}:${password}`)}`;
}

function sampleBooks() {
  return {
    errors: ["institution delayed"],
    accounts: [
      {
        id: "act-checking",
        name: "Checking",
        currency: "USD",
        balance: "100.23",
        transactions: [
          {
            id: "txn-rent",
            posted: isoToUnix("2026-01-01"),
            amount: "-48.20",
            description: "Rent",
            pending: false,
          },
          {
            id: "txn-groceries",
            posted: isoToUnix("2026-03-02"),
            amount: "-18.50",
            description: "Market basket",
            pending: false,
          },
          {
            id: "txn-coffee",
            posted: isoToUnix("2026-03-03"),
            amount: "-5.00",
            description: "Coffee",
            pending: true,
          },
        ],
      },
      {
        id: "act-card",
        name: "Visa card",
        currency: "usd",
        balance: "-20.00",
        transactions: [],
      },
    ],
  };
}

type BridgeHandle = {
  port: number;
  posts: string[];
  accountQueries: string[];
  authorizations: string[];
  claimStatus?: number;
  claimBody?: string;
  accountsStatus?: number;
  accountsBody?: string;
};

async function startBridge(): Promise<BridgeHandle> {
  const claimed = new Set<string>();
  const handle: BridgeHandle = { port: 0, posts: [], accountQueries: [], authorizations: [] };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "POST" && url.pathname.startsWith("/simplefin/claim/")) {
      handle.posts.push(url.pathname);
      if (handle.claimStatus) {
        res.writeHead(handle.claimStatus, { "content-type": "text/plain" });
        res.end(handle.claimBody ?? "");
        return;
      }
      const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      if (claimed.has(id)) {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end("Token already claimed");
        return;
      }
      claimed.add(id);
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`http://${USER}:${PASSWORD}@127.0.0.1:${handle.port}/simplefin\n`);
      return;
    }
    if (req.method === "GET" && url.pathname === "/simplefin/accounts") {
      handle.accountQueries.push(url.search);
      handle.authorizations.push(req.headers.authorization ?? "");
      if (handle.accountsStatus) {
        res.writeHead(handle.accountsStatus, { "content-type": "text/plain" });
        res.end(handle.accountsBody ?? "");
        return;
      }
      if ((req.headers.authorization ?? "") !== basicAuth(USER, PASSWORD)) {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end("Forbidden");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(sampleBooks()));
      return;
    }
    res.writeHead(404);
    res.end("missing");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  handle.port = typeof address === "object" && address ? address.port : 0;
  servers.push(server);
  return handle;
}
