import { describe, expect, it } from "vitest";
import { ConfigError, InvalidSetupTokenError, ProviderNetworkError } from "../errors";
import { MEMBER_SETUP_FAILURE, memberFacingMessage } from "../setup/config";
import { connectBank, createMemoryBankConnectionStore } from "./connect";
import {
  PLAID_PROVIDER_ID,
  createPlaidProvider,
  plaidAmountToCents,
  plaidHistoryDays,
  resolvePlaidConfig,
  type PlaidProvider,
} from "./plaid";
import { createProviderRegistry, providerTransactionFingerprint, type ProviderAccount, type ProviderTransaction } from "./provider";
import { createSimpleFinProvider } from "./simplefin";
import { bankBookRow, legacyBookRow } from "./book-fixtures";
import { planBankSync, planPlaidSync } from "./sync";
import { parseTokenKeyRing } from "./token-cipher";

const CLIENT_ID = "plaid-test-client";
const SECRET = "plaid-test-secret";
const ACCESS = "access-sandbox-test-token-value";
const PUBLIC = "public-sandbox-test-token-value";
const LINK = "link-sandbox-test-token-value";
const householdId = "house-a";

const setupLeak = /PLAID_CLIENT_ID|PLAID_SECRET|PLAID_ENV|PLAID_REDIRECT_URI|BANK_CONNECTION_KEYS/;

describe("Plaid configuration", () => {
  it("hides Plaid when it is not configured and keeps env names out of member copy", () => {
    const absent = resolvePlaidConfig({ clientId: "", secret: "  ", env: "" });
    expect(absent.isOk()).toBe(true);
    if (absent.isOk()) expect(absent.value.enabled).toBe(false);

    const ready = resolvePlaidConfig({
      clientId: ` ${CLIENT_ID} `,
      secret: SECRET,
      env: "Sandbox",
    });
    expect(ready.isOk()).toBe(true);
    if (ready.isOk()) {
      expect(ready.value.enabled).toBe(true);
      if (ready.value.enabled) {
        expect(ready.value.credentials).toEqual({ clientId: CLIENT_ID, secret: SECRET, env: "sandbox" });
        expect(ready.value.redirectUri).toBeNull();
      }
    }

    const partial = resolvePlaidConfig({ clientId: "", secret: SECRET, env: "sandbox" });
    expect(partial.isErr()).toBe(true);
    if (partial.isErr()) {
      expect(partial.error).toBeInstanceOf(ConfigError);
      expect(partial.error.message).toMatch(/PLAID_CLIENT_ID/);
      expect(partial.error.message).not.toContain(SECRET);
      const shown = memberFacingMessage(partial.error, MEMBER_SETUP_FAILURE);
      expect(shown).toBe(MEMBER_SETUP_FAILURE);
      expect(shown).not.toMatch(setupLeak);
      expect(shown).not.toContain(SECRET);
    }

    const trial = resolvePlaidConfig({ clientId: CLIENT_ID, secret: SECRET, env: "trial" });
    expect(trial.isErr()).toBe(true);
    if (trial.isErr()) {
      expect(trial.error.message).toMatch(/PLAID_ENV/);
      expect(trial.error.message).toMatch(/production/);
      expect(memberFacingMessage(trial.error)).not.toMatch(setupLeak);
    }
  });
});

describe("Plaid link and exchange", () => {
  it("creates a link token and exchanges the public token without storing a bank password", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const provider = providerWith(async (url, body) => {
      calls.push({ url, body });
      if (url.endsWith("/link/token/create")) {
        return json({ link_token: LINK, expiration: "2026-10-06T12:00:00Z", request_id: "req-link" });
      }
      if (url.endsWith("/item/public_token/exchange")) {
        return json({ access_token: ACCESS, item_id: "item-sandbox-1", request_id: "req-exchange" });
      }
      return json({ error_code: "INVALID_API_KEYS", error_message: SECRET }, 400);
    });

    const link = await provider.createLinkToken({ clientUserId: "user-ada", daysRequested: 90 });
    if (link.isErr()) throw link.error;
    expect(link.value.linkToken).toBe(LINK);
    expect(calls[0]?.url).toBe("https://sandbox.plaid.com/link/token/create");
    expect(calls[0]?.body.client_id).toBe(CLIENT_ID);
    expect(calls[0]?.body.secret).toBe(SECRET);
    expect(calls[0]?.body.products).toEqual(["transactions"]);
    expect(calls[0]?.body.transactions).toEqual({ days_requested: 90 });
    expect(calls[0]?.body).not.toHaveProperty("password");
    expect(calls[0]?.body).not.toHaveProperty("username");
    expect(JSON.stringify(calls[0]?.body)).not.toContain("user_good");

    const registry = createProviderRegistry();
    const registered = registry.register(provider);
    if (registered.isErr()) throw registered.error;
    const store = createMemoryBankConnectionStore();
    const connected = await connectBank(
      { registry, store, keys: keys(), newId: () => "connection-plaid" },
      { householdId, providerId: PLAID_PROVIDER_ID, setup: { token: PUBLIC }, label: "First Platypus Bank" },
    );
    if (connected.isErr()) throw connected.error;
    expect(calls[1]?.url).toBe("https://sandbox.plaid.com/item/public_token/exchange");
    expect(calls[1]?.body.public_token).toBe(PUBLIC);
    expect(calls[1]?.body).not.toHaveProperty("password");
    expect(connected.value).toEqual({
      id: "connection-plaid",
      householdId,
      providerId: "plaid",
      label: "First Platypus Bank",
    });
    const stored = store.encryptedTokens()[0] ?? "";
    expect(stored.startsWith("v1.")).toBe(true);
    expect(stored).not.toContain(ACCESS);
    expect(stored).not.toContain(PUBLIC);
    expect(stored).not.toContain(SECRET);
    expect(JSON.stringify(connected.value)).not.toContain(ACCESS);
    expect(JSON.stringify(connected.value)).not.toContain(SECRET);
  });

  it("maps a rejected link without echoing the secret or the Plaid error body", async () => {
    const provider = providerWith(async () =>
      json({ error_code: "INVALID_API_KEYS", error_message: `rejected ${SECRET} ${ACCESS}` }, 400),
    );
    const failed = await provider.createLinkToken({ clientUserId: "user-ada" });
    expect(failed.isErr()).toBe(true);
    if (failed.isOk()) return;
    expect(failed.error.message).toMatch(/PLAID_CLIENT_ID/);
    expect(failed.error.message).not.toContain(SECRET);
    expect(failed.error.message).not.toContain(ACCESS);
    expect(memberFacingMessage(failed.error, MEMBER_SETUP_FAILURE)).not.toMatch(setupLeak);

    const expired = providerWith(async () =>
      json({ error_code: "INVALID_PUBLIC_TOKEN", error_message: PUBLIC }, 400),
    );
    const rejected = await expired.exchange({ token: PUBLIC });
    expect(rejected.isErr()).toBe(true);
    if (rejected.isOk()) return;
    expect(rejected.error).toBeInstanceOf(InvalidSetupTokenError);
    expect(rejected.error.message).toContain("Start the link again");
    expect(rejected.error.message).not.toContain(PUBLIC);
    expect(rejected.error.message).not.toContain(SECRET);
  });

  it("does not call Plaid when the public token is not a provider token", async () => {
    let called = false;
    const provider = createPlaidProvider({
      credentials: { clientId: CLIENT_ID, secret: SECRET, env: "sandbox" },
      fetch: async () => {
        called = true;
        throw new Error(`network ${SECRET}`);
      },
    });
    const rejected = await provider.exchange({ token: "password=hunter2" });
    expect(called).toBe(false);
    expect(rejected.isErr()).toBe(true);
    if (rejected.isOk()) return;
    expect(rejected.error.message).not.toContain("hunter2");
    expect(rejected.error.message).not.toMatch(setupLeak);
  });
});

describe("Plaid sync", () => {
  it("maps transactions/sync amounts to integer cents with the Dollas sign", async () => {
    const outflow = plaidAmountToCents(18.5);
    const inflow = plaidAmountToCents(-48.2);
    const awkward = plaidAmountToCents(19.99);
    if (outflow.isErr() || inflow.isErr() || awkward.isErr()) throw new Error("cents");
    expect(outflow.value).toBe(-1_850);
    expect(inflow.value).toBe(4_820);
    expect(awkward.value).toBe(-1_999);

    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const provider = providerWith(async (url, body) => {
      calls.push({ url, body });
      if (url.endsWith("/transactions/sync")) {
        const cursor = body.cursor;
        if (cursor === "cursor-1") return json(emptyPage("cursor-2"));
        return json(samplePage());
      }
      return json({ error_code: "INVALID_ACCESS_TOKEN", error_message: ACCESS }, 400);
    });

    const first = await provider.syncItem({ accessToken: ACCESS }, { cursor: null, since: "2026-02-01" });
    if (first.isErr()) throw first.error;
    expect(calls[0]?.url).toBe("https://sandbox.plaid.com/transactions/sync");
    expect(calls[0]?.body.cursor).toBe("");
    expect(calls[0]?.body.access_token).toBe(ACCESS);
    expect(first.value.nextCursor).toBe("cursor-1");
    expect(first.value.accounts).toEqual([
      {
        providerAccountId: "act-checking",
        name: "Plaid Checking",
        type: "checking",
        currency: "USD",
        balanceCents: 11_023,
      },
      {
        providerAccountId: "act-card",
        name: "Plaid Credit Card",
        type: "credit",
        currency: "USD",
        balanceCents: -2_000,
      },
    ]);
    expect(first.value.added.map((row) => [row.providerTransactionId, row.amountCents, row.pending])).toEqual([
      ["txn-groceries", -1_850, false],
    ]);
    expect(first.value.added[0]?.payee).toBe("Market");
    expect(first.value.modified).toEqual([]);
    expect(first.value.removed).toEqual([]);

    const fingerprint = providerTransactionFingerprint(PLAID_PROVIDER_ID, "txn-groceries");
    if (fingerprint.isErr()) throw fingerprint.error;
    expect(fingerprint.value).toBe("bank:plaid:txn-groceries");

    const plan = planPlaidSync({
      householdId,
      accounts: first.value.accounts,
      added: first.value.added,
      modified: first.value.modified,
      removed: first.value.removed,
      ledgerAccounts: [],
      links: [],
      books: [],
      rules: [{ pattern: "Market", categoryId: "cat-groceries" }],
      fallbacks: { incomeCategoryId: "cat-income", expenseCategoryId: "cat-expense" },
    });
    if (plan.isErr()) throw plan.error;
    expect(plan.value.added.map((row) => row.providerTransactionId)).toEqual(["txn-groceries"]);
    expect(plan.value.added[0]?.amountCents).toBe(-1_850);
    expect(plan.value.added[0]?.categoryId).toBe("cat-groceries");
    const card = plan.value.accounts.find((account) => account.providerAccountId === "act-card");
    if (!card || card.kind !== "create") throw new Error("card");
    expect(card.balanceCents).toBe(-2_000);
    expect(card.type).toBe("credit");
  });

  it("is idempotent when the same cursor page is applied again", async () => {
    const provider = providerWith(async (_url, body) => {
      if (body.cursor === "cursor-1") return json(emptyPage("cursor-1"));
      return json(samplePage());
    });
    const first = await provider.syncItem({ accessToken: ACCESS }, { cursor: null, since: "2026-01-01" });
    if (first.isErr()) throw first.error;
    const imported = first.value.added.map((row) =>
      bankBookRow(householdId, {
        providerId: PLAID_PROVIDER_ID,
        providerAccountId: row.providerAccountId,
        providerTransactionId: row.providerTransactionId,
      }),
    );
    const again = await provider.syncItem({ accessToken: ACCESS }, { cursor: first.value.nextCursor, since: "2026-01-01" });
    if (again.isErr()) throw again.error;
    expect(again.value.added).toEqual([]);
    const replay = planPlaidSync({
      householdId,
      accounts: first.value.accounts,
      added: first.value.added,
      modified: [],
      removed: [],
      ledgerAccounts: [],
      links: first.value.accounts.map((account, index) => ({
        providerAccountId: account.providerAccountId,
        ledgerAccountId: `ledger-${index}`,
      })),
      books: imported,
      rules: [],
    });
    if (replay.isErr()) throw replay.error;
    expect(replay.value.added).toEqual([]);
    expect(replay.value.updated).toEqual([]);
    expect(replay.value.removed).toEqual([]);
    expect(replay.value.accounts.every((account) => account.kind === "update")).toBe(true);
  });

  it("hides removed transactions and does not resurrect a member delete", () => {
    const groceries: ProviderTransaction = {
      providerTransactionId: "txn-groceries",
      providerAccountId: "act-checking",
      occurredOn: "2026-03-02",
      payee: "Market",
      amountCents: -1_850,
      pending: false,
    };
    const checking: ProviderAccount = {
      providerAccountId: "act-checking",
      name: "Plaid Checking",
      type: "checking",
      currency: "USD",
      balanceCents: 11_023,
    };
    const removed = planPlaidSync({
      householdId,
      accounts: [checking],
      added: [],
      modified: [{ ...groceries, amountCents: -1_900, payee: "Market basket" }],
      removed: ["txn-groceries", "txn-missing"],
      ledgerAccounts: [],
      links: [{ providerAccountId: "act-checking", ledgerAccountId: "ledger-checking" }],
      books: [
        legacyBookRow(householdId, "bank:plaid:txn-groceries"),
        legacyBookRow(householdId, "bank:plaid:txn-rent", "2026-04-01T00:00:00.000Z"),
      ],
      rules: [],
    });
    if (removed.isErr()) throw removed.error;
    expect(removed.value.removed).toEqual([{ transactionId: "row-txn-groceries", matched: false }]);
    expect(removed.value.updated).toEqual([]);
    expect(removed.value.added).toEqual([]);

    const edited = planPlaidSync({
      householdId,
      accounts: [checking],
      added: [],
      modified: [{ ...groceries, amountCents: -1_900 }],
      removed: [],
      ledgerAccounts: [],
      links: [{ providerAccountId: "act-checking", ledgerAccountId: "ledger-checking" }],
      books: [legacyBookRow(householdId, "bank:plaid:txn-groceries")],
      rules: [],
    });
    if (edited.isErr()) throw edited.error;
    expect(edited.value.updated).toEqual([
      {
        transactionId: "row-txn-groceries",
        providerAccountId: "act-checking",
        providerTransactionId: "txn-groceries",
        occurredOn: "2026-03-02",
        payee: "Market",
        amountCents: -1_900,
        matched: false,
        deleted: false,
        clearLegacyFingerprint: true,
      },
    ]);

    const deleted = planPlaidSync({
      householdId,
      accounts: [checking],
      added: [groceries],
      modified: [{ ...groceries, amountCents: -1_900 }],
      removed: ["txn-rent"],
      ledgerAccounts: [],
      links: [{ providerAccountId: "act-checking", ledgerAccountId: "ledger-checking" }],
      books: [
        legacyBookRow(householdId, "bank:plaid:txn-groceries", "2026-04-02T00:00:00.000Z"),
        legacyBookRow(householdId, "bank:plaid:txn-rent", "2026-04-01T00:00:00.000Z"),
      ],
      rules: [],
    });
    if (deleted.isErr()) throw deleted.error;
    expect(deleted.value.added).toEqual([]);
    expect(deleted.value.updated).toEqual([]);
    expect(deleted.value.removed).toEqual([]);
  });

  it("keeps SimpleFIN and Plaid on different accounts in one household", async () => {
    const simplefin = createSimpleFinProvider({
      allowLoopback: true,
      fetch: async () => new Response("http://demo-user:demo-pass@127.0.0.1:9/simplefin\n"),
    });
    const plaid = providerWith(async (url) => {
      if (url.endsWith("/item/public_token/exchange")) {
        return json({ access_token: ACCESS, item_id: "item-1", request_id: "req" });
      }
      return json({ link_token: LINK });
    });
    const registry = createProviderRegistry();
    if (registry.register(simplefin).isErr()) throw new Error("simplefin");
    if (registry.register(plaid).isErr()) throw new Error("plaid");
    expect(registry.list().map((provider) => provider.id).sort()).toEqual(["plaid", "simplefin"]);

    const simplePlan = planBankSync({
      providerId: "simplefin",
      householdId,
      accounts: [
        {
          providerAccountId: "act-checking",
          name: "Checking",
          type: "checking",
          currency: "USD",
          balanceCents: 10_000,
        },
      ],
      transactions: [
        {
          providerTransactionId: "txn-rent",
          providerAccountId: "act-checking",
          occurredOn: "2026-03-02",
          payee: "Rent",
          amountCents: -8_000,
          pending: false,
        },
      ],
      ledgerAccounts: [],
      links: [],
      books: [],
      rules: [],
      fallbacks: { incomeCategoryId: "cat-income", expenseCategoryId: "cat-expense" },
    });
    if (simplePlan.isErr()) throw simplePlan.error;
    expect(simplePlan.value.transactions[0]?.providerTransactionId).toBe("txn-rent");

    const plaidPlan = planPlaidSync({
      householdId,
      accounts: [
        {
          providerAccountId: "act-checking",
          name: "Checking",
          type: "checking",
          currency: "USD",
          balanceCents: 4_000,
        },
      ],
      added: [
        {
          providerTransactionId: "txn-rent",
          providerAccountId: "act-checking",
          occurredOn: "2026-03-04",
          payee: "Rent",
          amountCents: -2_000,
          pending: false,
        },
      ],
      modified: [],
      removed: [],
      ledgerAccounts: [
        {
          id: "ledger-simplefin",
          householdId,
          name: "Checking",
          type: "checking",
          archivedAt: null,
        },
      ],
      links: [],
      reservedLedgerIds: ["ledger-simplefin"],
      books: simplePlan.value.transactions.map((row) =>
        bankBookRow(
          householdId,
          { providerId: "simplefin", providerAccountId: row.providerAccountId, providerTransactionId: row.providerTransactionId },
          { accountId: "ledger-simplefin" },
        ),
      ),
      rules: [],
      fallbacks: { incomeCategoryId: "cat-income", expenseCategoryId: "cat-expense" },
    });
    if (plaidPlan.isErr()) throw plaidPlan.error;
    // Same provider ids in two providers are different identities.
    expect(plaidPlan.value.added[0]?.providerTransactionId).toBe("txn-rent");
    expect(plaidPlan.value.accounts[0]?.kind).toBe("create");
    expect(plaidPlan.value.added).toHaveLength(1);

    const store = createMemoryBankConnectionStore();
    const simpleToken = btoa("http://127.0.0.1:9/simplefin/claim/one");
    const simpleConnected = await connectBank(
      { registry, store, keys: keys(), newId: () => "connection-simple" },
      { householdId, providerId: "simplefin", setup: { token: simpleToken }, label: "Credit union" },
    );
    if (simpleConnected.isErr()) throw simpleConnected.error;
    const plaidConnected = await connectBank(
      { registry, store, keys: keys(), newId: () => "connection-plaid" },
      { householdId, providerId: PLAID_PROVIDER_ID, setup: { token: PUBLIC }, label: "Plaid sandbox" },
    );
    if (plaidConnected.isErr()) throw plaidConnected.error;
    const listed = await store.list(householdId);
    if (listed.isErr()) throw listed.error;
    expect(listed.value.map((row) => row.providerId)).toEqual(["simplefin", "plaid"]);
    const published = JSON.stringify(listed.value);
    expect(published).not.toContain(ACCESS);
    expect(published).not.toContain(SECRET);
    expect(published).not.toContain("demo-pass");
    const sealed = store.encryptedTokens(householdId).join(" ");
    expect(sealed).not.toContain(ACCESS);
    expect(sealed).not.toContain("demo-pass");
  });

  it("maps a network failure without the access token", async () => {
    const provider = createPlaidProvider({
      credentials: { clientId: CLIENT_ID, secret: SECRET, env: "production" },
      fetch: async () => {
        throw new Error(`connect ECONNREFUSED ${ACCESS} ${SECRET}`);
      },
    });
    const failed = await provider.syncItem({ accessToken: ACCESS }, { cursor: null });
    expect(failed.isErr()).toBe(true);
    if (failed.isOk()) return;
    expect(failed.error).toBeInstanceOf(ProviderNetworkError);
    expect(failed.error.message).toContain("Try syncing again");
    expect(failed.error.message).not.toContain(ACCESS);
    expect(failed.error.message).not.toContain(SECRET);
    expect(plaidHistoryDays(undefined, new Date("2026-04-06T00:00:00.000Z"))).toBe(90);
    expect(plaidHistoryDays("2026-04-01", new Date("2026-04-06T00:00:00.000Z"))).toBe(6);
    expect(plaidHistoryDays("2020-01-01", new Date("2026-04-06T00:00:00.000Z"))).toBe(730);
  });
});

function providerWith(
  respond: (url: string, body: Record<string, unknown>) => Promise<Response> | Response,
): PlaidProvider {
  return createPlaidProvider({
    credentials: { clientId: CLIENT_ID, secret: SECRET, env: "sandbox" },
    fetch: async (input, init) => {
      const url = String(input);
      if (!url.startsWith("https://sandbox.plaid.com/")) {
        throw new Error(`unexpected host ${url}`);
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return respond(url, body);
    },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function keys() {
  const bytes = new Uint8Array(32).fill(7);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const parsed = parseTokenKeyRing(`1:${btoa(binary)}`);
  if (parsed.isErr()) throw parsed.error;
  return parsed.value;
}

function samplePage() {
  return {
    accounts: [
      {
        account_id: "act-checking",
        name: "Plaid Checking",
        official_name: "Plaid Gold Standard 0% Interest Checking",
        type: "depository",
        subtype: "checking",
        balances: { available: 100, current: 110.23, iso_currency_code: "USD" },
      },
      {
        account_id: "act-card",
        name: "Plaid Credit Card",
        type: "credit",
        subtype: "credit card",
        balances: { available: null, current: 20, iso_currency_code: "USD" },
      },
    ],
    added: [
      {
        transaction_id: "txn-old",
        account_id: "act-checking",
        amount: 48.2,
        date: "2026-01-01",
        name: "Rent",
        merchant_name: "Rent",
        pending: false,
      },
      {
        transaction_id: "txn-groceries",
        account_id: "act-checking",
        amount: 18.5,
        date: "2026-03-02",
        name: "Market basket",
        merchant_name: "Market",
        pending: false,
      },
      {
        transaction_id: "txn-coffee",
        account_id: "act-checking",
        amount: 5,
        date: "2026-03-03",
        name: "Coffee",
        pending: true,
      },
    ],
    modified: [],
    removed: [],
    next_cursor: "cursor-1",
    has_more: false,
  };
}

function emptyPage(cursor: string) {
  return {
    accounts: [
      {
        account_id: "act-checking",
        name: "Plaid Checking",
        type: "depository",
        subtype: "checking",
        balances: { current: 110.23, iso_currency_code: "USD" },
      },
    ],
    added: [],
    modified: [],
    removed: [],
    next_cursor: cursor,
    has_more: false,
  };
}
