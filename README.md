# dollas

A self-hosted household budgeting app. One shared set of books, separate logins. The browser is the client. Bank connections store a provider token encrypted at rest. The app never asks for a bank username or password. Local development seeds a fake provider connection. SimpleFIN is the live provider.

## Stack

- pnpm workspace with vertical slices
- Next.js app in `apps/web`
- Shared domain in `packages/domain` (integer cents, neverthrow, typed errors)
- MCP server at `/api/mcp` over Streamable HTTP with OAuth: every web action is a tool (toolkit in `packages/mcp`, tools next to slice services)
- Postgres with row-level security; the app pool logs in as `dollas_app`, a role created by Pulumi in `infra/` (see `infra/README.md`)
- Better Auth: Google sign-in counts as a verified email; email and password cannot see household data until the address is verified
- shadcn/ui on a sage palette
- OpenTelemetry logs, including request errors

## Local development

You need Node.js 22.13 or newer, pnpm 11.28.4 (`packageManager` in the root `package.json`), and Postgres 16. Docker Compose is the usual way to get the database. Migrations run through Drizzle and the `postgres` driver, so the host does not need `psql`.

`pnpm install` refuses a dependency version published less than five days ago, including a version already written into `pnpm-lock.yaml`. CI and Vercel use `pnpm install --frozen-lockfile`, so they apply the same cutoff. The setting is `minimumReleaseAge` in `pnpm-workspace.yaml` (7200 minutes). Dependency install scripts do not run. `allowBuilds` is the allowlist for a package that must build a native or platform binary; it is empty, because esbuild, sharp, and unrs-resolver ship prebuilt platform packages.

```bash
docker compose up -d
cp apps/web/.env.example apps/web/.env.local
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Generate `BANK_CONNECTION_KEYS` into `apps/web/.env.local` before `pnpm db:seed` or `pnpm dev`. The app refuses to start, and seed refuses to write a connection, when the variable is missing or not a 32-byte key. Do not commit the value.

```bash
node -e "console.log('1:' + require('node:crypto').randomBytes(32).toString('base64'))"
```

Put that line in `.env.local` as `BANK_CONNECTION_KEYS=...`. The number is the key version. To rotate, add `2:` plus a new key and keep `1:` until existing tokens are re-encrypted. The highest version seals new tokens.

Schema changes start in `apps/web/src/db/schema.ts`. Generate a migration and commit the files Drizzle writes:

```bash
pnpm db:generate
```

That updates `apps/web/drizzle/`. Do not hand-write the next table, check, index, or policy change. Functions, triggers, and grants that Drizzle cannot emit live in a custom migration (`pnpm exec drizzle-kit generate --custom` from `apps/web`); `0001_household_access` is that exception.

Open http://localhost:3000 and sign in with the seed account:

- Email: `ada@maple.local`
- Password: `maple-demo`
- Household: Maple House
- Open invite: `sam@maple.local` (seed prints its link)

The seed builds accounts, categories, budgets, and transactions relative to today, including a grocery purchase split across categories. Those seed categories stay as they are. A member can add income, expense, and transfer categories in groups; transfers do not count as income or spending. On Activity, a member can save a payee rule: when a new CSV import or bank sync contains a payee that matches that text, the transaction uses the rule's category. Rules do not change transactions already in the books. A member can apply one saved rule to existing matches after the page shows how many would change. A transaction split across categories is skipped, and so is a transaction with no category line; those skips are counted before anything is written. Removing a rule asks for confirmation and names the rule. Editing or deleting one transaction leaves the rule in place. Deleting a transaction hides it from the books and keeps its import fingerprint, so importing that same CSV row does not bring it back. Activity shows a short undo for the delete. Undoing a CSV import is different: it hard-deletes only the transactions that import created, including any of those rows a member had already deleted. Those fingerprints leave with the rows, so importing the same file again adds them as a new batch. A deleted transaction from an import you do not undo stays deleted and is not recreated. Undo does not change payee rules, manual entries, or bank sync rows (`bank:{provider}:{transaction id}` fingerprints stay put). Before an import is saved, Activity previews the parsed rows and how many are new versus already in the books. A member maps the file's columns onto date, payee, amount, account, category, and optional notes, including a signed amount column or separate debit and credit columns. That mapping is remembered for the same headers, or for a no-header file tied to one account, and can be edited. The import fingerprint is a SHA-256 of the normalized mapped rows in file order — date, payee, amount in cents, account name, and category name — plus each row's index. Notes are left out of the hash, and so is the category a payee rule later applies. Rows that fail validation are omitted, so the same file with the same mapping adds nothing the second time. A mapping change that repairs a row changes every fingerprint in that file. Soft-deleted fingerprints count as already imported. A file over one million characters is refused with that limit in the error. History, the home spend estimate, and plan totals are computed from the transactions that are still visible.

Family members join by email invite. On the Household page an owner enters someone's email; Dollas emails a link through Resend from `RESEND_FROM` (production and preview: `noreply@dollas.kylependergast.com`). When Resend is not set up, local development writes the link to the server log and a hosted deploy says the email did not go out. Either way the owner can copy the link and send it themselves. The link works once, for seven days, and only for a login whose verified email matches the invited address (email and password after verification, or Google). Someone signed out can create a login or sign in from the invite page and comes back to it after verifying. A wrong login, an expired, revoked, or used link, and someone who already keeps other books each get a plain message. Owners can copy an open invite's link again or revoke it. The Household page lists every member with their role. Every member sees and edits the same accounts, transactions, categories, and budget. The invite page is the only way in: the old shared invite codes are retired, and migration `0021` removes any that were still open.

The link token is an HMAC-SHA-256 of the invite id under `BETTER_AUTH_SECRET`. The database stores only the SHA-256 of that token, so a copy of the table cannot be turned into a working link, and the owner's "Copy link" recomputes the same link. Rotating `BETTER_AUTH_SECRET` turns open links off; owners send those invites again. `dollas_app` still cannot insert or update invite or membership rows. `create_household_invite`, `revoke_household_invite`, `household_invite_preview`, and `accept_household_invite` (migration `0022`) are security-definer functions that check the owner, the token hash, the expiry, single use, and the verified email. Accepting needs that narrow path because row-level security hides the household from the invitee until they are a member. Listing members and invites, creating, copying a link, and revoking are server services a future MCP tool can call. Previewing and accepting an invite are UI-only because they are bound to the browser sign-in.

Accounts lists ledger balances and bank connections. Disconnect deletes the stored token. Seed writes one encrypted connection for the in-memory `fake` provider, not a live bank. A household can link SimpleFIN and Plaid at the same time, on different accounts. Teller is not chosen.

SimpleFIN links from Accounts. Paste a setup token from your bank. That token is a base64 claim URL. The server POSTs it once; the bridge answers with an access URL. Only that access URL is stored, and only as ciphertext sealed with `BANK_CONNECTION_KEYS`. The setup token is single-use. It is not written to the database or to logs. OpenTelemetry records the claim and the sync, not the token or the access URL.

Sync reads SimpleFIN `/accounts` from the start date chosen at link time (90 days ago when that date is left blank). Pending transactions are left out until they post. Amounts become integer cents. Each SimpleFIN account is matched to a ledger account with the same name, or created when there is no single match. Transactions are written with the bank fingerprint `bank:simplefin:{transaction id}`, which does not collide with a CSV fingerprint or with a Plaid fingerprint. A second sync adds nothing that is already imported. A transaction a member deleted stays deleted, because its fingerprint remains on the row. A payee rule still applies to a new synced transaction. It does not recategorize transactions already in the books. When no rule matches, the transaction uses an Uncategorized category so the books stay balanced, and a member can edit it. If the bank rejects the connection, disconnect it and paste a new setup token.

Plaid is the other bank provider. Dollas does not ship Plaid keys. The person who deploys the app sets `PLAID_CLIENT_ID`, `PLAID_SECRET`, and `PLAID_ENV` (`sandbox` or `production`). Leave all three empty to hide Plaid on Accounts. A partial set, or an env other than those two, is logged on the server and Plaid stays hidden. Members never see those variable names. `PLAID_REDIRECT_URI` is optional and only needed for OAuth banks.

Sandbox (`PLAID_ENV=sandbox`) is for local development. It uses Plaid’s fake institutions, so no real bank is required. In Plaid Link, open First Platypus Bank and sign in with the sandbox username `user_good` and password `pass_good` published by Plaid. The server creates the link token, the browser talks to Plaid, and the server exchanges the public token. The access token is stored with `BANK_CONNECTION_KEYS`. The app never asks for a bank password, and tokens are not written to logs. Tests mock Plaid’s HTTP API and do not call Plaid.

Production (`PLAID_ENV=production`) is live data. Plaid’s Trial plan is a free way to use production: real bank data, limited to 10 production Items, for US and Canada teams created on or after April 15, 2026. Unlimited production access is a paid Plaid application. Trial uses the same production environment and the same three variables. It is not a third value of `PLAID_ENV`.

Plaid linking, exchange, listing, sync, and disconnect are server services in the bank slice. The Accounts page and its form actions only collect input, call those services, and refresh the page. `createPlaidLinkToken` and `exchangePlaidPublicToken` are UI-only: they finish Plaid Link. A future MCP tool must not call them, and it must not receive a bank password, a Plaid key, a link token, or a public token. Listing connections, syncing, and disconnecting are the services that tool can call.

Plaid sync calls `/transactions/sync` and stores the cursor on the connection. Added transactions use the fingerprint `bank:plaid:{transaction id}`. Plaid amounts are positive when money leaves the account; Dollas stores the opposite sign, in integer cents. A later sync updates a transaction Plaid marks modified, and hides one Plaid marks removed, the same way a member delete hides a row. A transaction a member already deleted stays deleted and is not imported again. Re-running sync does not duplicate a row. Pending charges stay off the books until they post. An account already linked through SimpleFIN is left alone, so the Plaid account gets its own ledger account.

Leave `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` empty unless you want to try Google sign-in. Set `RESEND_API_KEY` and `RESEND_FROM` to email verification and password-reset links through Resend. The sender is whatever `RESEND_FROM` is set to. Production and preview use `noreply@dollas.kylependergast.com`. When both variables are unset, local development writes the link to the server log instead of sending mail. OpenTelemetry logs omit the link, the token, and the password.

`DATABASE_URL` is the restricted `dollas_app` role. It cannot bypass row-level security, and it cannot apply schema changes. `DATABASE_MIGRATE_URL` is the table owner, used by `pnpm db:migrate` and `pnpm db:seed`. After those have run, starting the app sees the current Drizzle journal and does not apply anything. Household queries assume `dollas_app` for the transaction, so a forgotten membership check still cannot read another household.

## Agents (MCP)

An AI agent can use a household's books over MCP. Add `<BETTER_AUTH_URL>/api/mcp` as a remote MCP server in the agent. Dollas is the OAuth authorization server, through Better Auth's `@better-auth/oauth-provider` plugin:

- Discovery: `/.well-known/oauth-protected-resource` (and `/.well-known/oauth-protected-resource/api/mcp`) names the MCP resource and its authorization server. `/.well-known/oauth-authorization-server` (and `/.well-known/oauth-authorization-server/api/auth`) lists the endpoints under `/api/auth/oauth2/*`. A 401 or 403 from `/api/mcp` carries `WWW-Authenticate: Bearer` with `resource_metadata` and the scopes.
- Agents register themselves (dynamic client registration). A client whose redirect URIs are all `http://localhost` or `127.0.0.1` is registered as a native app. Authorization code with PKCE, S256 only.
- The member signs in the usual way (verified email or Google), sees the household the agent will act in, and picks read (`dollas:read`) or read and write (`dollas:write`). `offline_access` adds a refresh token.
- Access tokens are opaque, last 15 minutes, and are stored only as hashes. Refresh tokens last 30 days, are hashed, and rotate on every use. Tokens carry the member and household.
- Every MCP call runs as that member in a `dollas_app` transaction, so household row-level security applies just as it does in the browser. Write tools need `dollas:write`.
- Settings lists connected agents (name, access, connected and last used dates). Disconnect revokes the consent and every access and refresh token for that agent at once. Leaving a household does the same through a database trigger.

The OAuth tables (`oauth_client`, `oauth_access_token`, `oauth_refresh_token`, `oauth_consent`, and the rest) are not household-scoped, like the Better Auth session tables. Better Auth reads them before there is a member or household context. `dollas_app` gets select, insert, update, and delete on them and nothing else. The app reads them only for the signed-in member's own rows. `agent_activity` (last used) is household-scoped with row-level security. No new environment variables: the issuer and resource URLs come from `BETTER_AUTH_URL`.

### Tools

Anything a member can do in the web app is also a tool on `/api/mcp` (54 today), and both call the same slice service, so validation, rules, and row-level security are shared:

- Reads: `whoami`, `get_month_summary`, `get_spend_estimate`, `get_spending_history`, `list_accounts`, `list_transactions`, `list_categories`, `list_payee_rules`, `list_csv_imports`, `get_plan`, `preview_copy_last_month`, `preview_payee_rule_apply`, `inspect_csv`, `preview_csv_import`, `list_household`, `get_my_profile`, `list_bank_connections`.
- Writes (need `dollas:write`): accounts (`create_account`, `update_account`, `archive_account`, `unarchive_account`, `delete_account`), transactions (`create_transaction`, `update_transaction`, `categorize_transaction`, `split_transaction`, `delete_transaction`, `restore_transaction`), CSV import (`commit_csv_import`, `undo_csv_import`), categories (`create_category_group`, `rename_category_group`, `remove_category_group`, `create_category`, `move_category`, `reorder_category_group`, `reorder_category`, `change_category_kind`), payee rules (`create_payee_rule`, `update_payee_rule`, `delete_payee_rule`, `apply_payee_rule`), the plan (`set_budget`, `clear_budget`, `copy_last_month`), the household (`create_invite`, `copy_invite_link`, `revoke_invite`, `update_my_name`, `transfer_ownership`, `leave_household`, `delete_household`), and banks (`sync_bank_connection`, `disconnect_bank_connection`).

Conventions: snake_case names and fields, zod input schemas, money in integer cents (`amount_cents`, signed; negative is money out), dates `YYYY-MM-DD`, months `YYYY-MM`. Every result is a one-line text summary plus structured JSON. Lists take `limit` and `cursor` and return `next_cursor`. Failures are the same member-facing message the page shows. Destructive tools (`delete_transaction`, `delete_account`, `undo_csv_import`, `delete_payee_rule`, `disconnect_bank_connection`, `transfer_ownership`, `leave_household`, `delete_household`) need `confirm: true`; `delete_household` also needs the household name typed exactly.

UI-only on purpose: entering bank passwords or provider keys and finishing a bank login (SimpleFIN setup token, Plaid Link), changing your own email, password, or sign-in methods, signing in or up, starting or joining a household, and connecting or disconnecting agents. Tools can report bank connection status but never take or return bank secrets, provider tokens, or access URLs.

### Adding an action: the parity rule

Tools live next to the services they call: `src/slices/<slice>/tools.ts` (or `*-tools.ts`), registered in `src/slices/agents/tools.ts`. `packages/mcp` is the toolkit (`toolFor`, `confirmInput`, `pageInput`, scope and confirm guards, replies).

`src/slices/parity.ts` lists every exported server action and every page, each mapped to the tools that cover it or marked `uiOnly` with a reason. `src/slices/agents/parity.test.ts` runs in CI and fails when:

- a `"use server"` file exports something not listed, or the list names an action that no longer exists;
- a page has no entry, or an entry names a tool that does not exist;
- a tool is not reachable from any action, page, or `AGENT_ONLY_TOOLS` reason;
- a server action file imports `drizzle-orm` or `@/db` (the logic belongs in the slice service, where the tool can call it);
- a slice tools file is not registered, or a destructive tool lacks `confirm`.

So a new server action means: put the logic in the slice service, keep the action a thin form wrapper, add a tool next to the service that calls it, and add one line to `parity.ts`.

### Pointing an agent at a local Dollas

Run `pnpm dev` (with the seed). Any MCP client that does OAuth for remote servers works against `http://localhost:3000/api/mcp`; sign in as `ada@maple.local` / `maple-demo` and pick read or read and write on the consent screen.

- MCP Inspector: `npx @modelcontextprotocol/inspector`, choose Streamable HTTP, URL `http://localhost:3000/api/mcp`, then Open Auth Settings → Quick OAuth Flow (or just Connect).
- Claude Code: `claude mcp add --transport http dollas http://localhost:3000/api/mcp`, then `/mcp` to sign in.
- Cursor (`.cursor/mcp.json`) and other clients that take a URL:

  ```json
  { "mcpServers": { "dollas": { "url": "http://localhost:3000/api/mcp" } } }
  ```

- Scripted, no browser: `pnpm --filter @dollas/web mcp:local tools` lists tools; `pnpm --filter @dollas/web mcp:local call get_plan '{"month":"2026-10"}'` calls one (`@file.json` reads arguments from a file). It runs the full OAuth flow as the seeded member (`DOLLAS_EMAIL`, `DOLLAS_PASSWORD`, `DOLLAS_ACCESS=read|write` override), caches its client and rotating refresh token in the OS temp dir, and refuses non-loopback URLs.

## Checks

```bash
pnpm test
pnpm lint
pnpm typecheck
```

Domain tests cover household access (members only, and unverified email/password stays out) and the partial-month history rule: the current month is not treated as finished, and its year-over-year change is “Not comparable yet” with no dollar delta. Web tests cover startup migrations: an already current schema is a no-op, and startup does not read `DATABASE_MIGRATE_URL` when `DATABASE_URL` or `DATABASE_URL_UNPOOLED` is set. When Postgres is running on localhost, they also check that a non-owner login cannot read another household without a membership predicate, and that the table owner can until the session assumes `dollas_app`. The `dollas_app` login tests run the Pulumi role SQL as a Neon-like owner (not a superuser), confirm startup no longer removes LOGIN, check that the startup login check accepts `dollas_app` and refuses the owner or a wrong password, and show that the login pool (no bridge) cannot read or change another household's rows. Unit tests cover pool URL selection (`DATABASE_URL_APP` first, never the migration URL), the bridge warning, and every reason the login check refuses. `infra` tests cover the SQL (no privileged attribute, never `neon_superuser`), password rules, and the `DATABASE_URL_APP` it builds. They also cover verification and password-reset email: Resend sends the link when it is configured, and local development without those variables still writes the link to the server log. Agent tests cover PKCE (S256 only, wrong verifier rejected), hashed tokens and expiry, refresh rotation, a read token refused by a write tool, disconnect cutting off access and refresh tokens, row-level security through an MCP call, and the discovery documents. Tool tests call every tool against Postgres (each has a happy path), refuse every write tool for a read grant, require `confirm` on destructive tools, and check that another household's agent can neither see nor change Maple's rows; bank sync runs against a loopback SimpleFIN bridge and the output never contains the access URL. The parity test keeps the web app and the tool list in step. Domain tests cover a forgot-password response that stays the same whether or not the address has a login, the resend cooldown, and the unverified sign-in message versus a wrong password.

CI runs a gitleaks secret scan and a code-quality scan (lint, types, and tests).

## Production

The Next.js app is the pnpm workspace package `@dollas/web` in `apps/web`. On the Vercel project, set the root directory to `apps/web`. The install command is `pnpm install --frozen-lockfile --filter @dollas/web...` (also in `apps/web/vercel.json`). The workspace root and `packages/domain` have to be included in the build, which is the “Include source files outside of the Root Directory” setting. Node on that project is 24.x.

Set these environment variables in Vercel. Do not commit secret values. `RESEND_API_KEY` lives only on Vercel.

| Name | Required | Role |
| --- | --- | --- |
| `DATABASE_URL_APP` | Yes, after rollout | Sensitive. The `dollas_app` login the app pool uses for pages, server actions, Better Auth, and `/api/mcp`. Pulumi creates the role and sets this variable for production and preview (`infra/README.md`); never set it by hand to an owner URL. When it is set, startup refuses to serve unless the login is `dollas_app` without superuser, BYPASSRLS, CREATEROLE, CREATEDB, or `neon_superuser`, on the same database as `DATABASE_URL`. Until it is set, the app falls back to the `SET LOCAL ROLE` bridge below and logs a warning. |
| `DATABASE_URL` | Yes | Pooled Postgres URL injected by the Neon marketplace integration. That login owns the tables, so it is for migrations only. Startup uses it for migrations when `DATABASE_URL_UNPOOLED` is unset, and the app pool uses it only in the bridge fallback. Money stays integer cents. |
| `DATABASE_URL_UNPOOLED` | Injected with Neon | Direct Postgres URL for the same owner login. Startup prefers it so schema changes and the migration lock keep one session. |
| `BETTER_AUTH_SECRET` | Yes | Signs sessions. There is no production fallback. |
| `BETTER_AUTH_URL` | Yes | Public site origin, including `https://`. |
| `RESEND_API_KEY` | Yes | Sends verification and password-reset links through Resend. Set on Vercel for production and preview. Do not commit a value. |
| `RESEND_FROM` | Yes | From address on those messages. Production and preview set this to `noreply@dollas.kylependergast.com`. The app sends from the value of this variable. |
| `DATABASE_MIGRATE_URL` | No | Not set on Vercel and not read at startup. Local `pnpm db:migrate` and `pnpm db:seed` still use it. |
| `GOOGLE_CLIENT_ID` | No | Google sign-in. Counts as a verified email. Set both or neither. |
| `GOOGLE_CLIENT_SECRET` | No | Pairs with `GOOGLE_CLIENT_ID`. |
| `BANK_CONNECTION_KEYS` | Yes | AES-256-GCM keys for bank connection tokens, including SimpleFIN access URLs and Plaid access tokens. Comma-separated `version:base64` entries, each 32 bytes. The highest version encrypts new tokens. Missing or invalid keys fail startup with a typed error instead of storing plaintext. Do not commit a value. SimpleFIN does not add a server API key. Each household pastes its own setup token. |
| `PLAID_CLIENT_ID` | No | Plaid client id from the deployer’s own Plaid dashboard. Set this, `PLAID_SECRET`, and `PLAID_ENV` together, or leave all three empty to hide Plaid. Do not commit a value. |
| `PLAID_SECRET` | No | Plaid secret for that client id. Do not commit a value. |
| `PLAID_ENV` | No | `sandbox` or `production`. Sandbox is fake banks for local development. Production is live data. Trial is free production access (10 Items for US/CA teams created on or after 2026-04-15), not a separate env value. Unlimited production is a paid Plaid application. |
| `PLAID_REDIRECT_URI` | No | Optional https URL registered in the Plaid dashboard for OAuth banks on production, including Trial. `http://localhost` is accepted for sandbox. Leave empty when you are not linking an OAuth bank. |

On boot, the Node.js server applies the Drizzle journal in `apps/web/drizzle` before it accepts requests. A fresh Neon database has no tables and an empty journal, so the first Vercel boot runs `0000_books`, `0001_household_access`, `0002_household_rls`, `0003_csv_import`, `0004_custom_categories`, `0005_category_group_grants`, `0006_payee_category_rules`, `0007_payee_category_rule_grants`, `0008_bank_connection`, `0009_bank_connection_grants`, `0010_ledger_account_archive`, `0011_transaction_deleted_at`, `0012_bank_account`, `0013_bank_account_grants`, `0014_csv_import_batch`, `0015_csv_import_grants`, `0016_plaid_sync_cursor`, `0017_plaid_sync_cursor_grants`, `0018_household_membership`, `0019_csv_column_mapping`, `0020_csv_column_mapping_grants`, `0021_household_invite_email`, `0022_household_invite_access`, `0023_agent_oauth`, and `0024_agent_oauth_access` through Drizzle's migrator and records them in `drizzle.__drizzle_migrations`. Startup uses `DATABASE_URL_UNPOOLED` when it is set, otherwise `DATABASE_URL`. A later boot, or a boot whose journal is already current, does nothing. Several instances can cold-start together: they take a Postgres advisory lock, so one applies the pending migrations and the others wait and then skip them. Startup does not seed data.

The Neon login owns the tables, and a table owner bypasses row-level security, so app traffic does not use it. Pulumi (`infra/`) creates `dollas_app` as a LOGIN role with a generated password and stores its URL as `DATABASE_URL_APP`; the app pool connects with that and nothing else. Startup never creates the login or changes its password. It only creates `dollas_app` as `NOLOGIN` when the role is missing, so the bridge below works on a fresh database. Startup grants `dollas_app` to the migration role and grants the same table privileges as `0001_household_access` (no insert on household, membership, or invites), including later household tables such as bank connections and bank accounts. Category groups receive the same read and write privileges as categories. Without `DATABASE_URL_APP` (the PEN-213 bridge, kept until rollout is done), every app transaction runs `SET LOCAL ROLE dollas_app` before it reads or writes, and the server refuses to start if that role cannot be assumed or can bypass row-level security. `infra/README.md` lists what to delete once every environment has `DATABASE_URL_APP`. No dollas_app connection string is added to the repo. `DATABASE_MIGRATE_URL` stays unset on Vercel. `BANK_CONNECTION_KEYS` is required or startup throws before it serves requests.

Do not run `pnpm db:seed` against the production database.

## Screens

Phone navigation is Home, Activity, Accounts, Categories, Plan, and History. Settings is in the desktop sidebar and in the phone header account menu, not a phone tab. The projection is linked from the home spend estimate and is not a phone tab. Settings is where a member changes their name, confirms a new email, changes a password, hands off ownership, leaves, or deletes the household. The last owner cannot leave until someone else owns the books or the household is deleted. The current month’s history column is hatched amber and labeled “so far”. A green change means this year spent less; red means more.
