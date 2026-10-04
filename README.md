# dollas

A self-hosted household budgeting app. One shared set of books, separate logins. The browser is the client. There is no bank linking in this pass, and local development runs entirely on seed data.

## Stack

- pnpm workspace with vertical slices
- Next.js app in `apps/web`
- Shared domain in `packages/domain` (integer cents, neverthrow, typed errors)
- MCP server slot in `packages/mcp` (no tools yet)
- Postgres with row-level security
- Better Auth: Google sign-in counts as a verified email; email and password cannot see household data until the address is verified
- shadcn/ui on a sage palette
- OpenTelemetry logs, including request errors

## Local development

You need Node.js 22, pnpm, and Postgres 16. Docker Compose is the usual way to get the database. Migrations run through Drizzle and the `postgres` driver, so the host does not need `psql`.

```bash
docker compose up -d
cp apps/web/.env.example apps/web/.env.local
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Schema changes start in `apps/web/src/db/schema.ts`. Generate a migration and commit the files Drizzle writes:

```bash
pnpm db:generate
```

That updates `apps/web/drizzle/`. Do not hand-write the next table, check, index, or policy change. Functions, triggers, and grants that Drizzle cannot emit live in a custom migration (`pnpm exec drizzle-kit generate --custom` from `apps/web`); `0001_household_access` is that exception.

Open http://localhost:3000 and sign in with the seed account:

- Email: `ada@maple.local`
- Password: `maple-demo`
- Household: Maple House
- Invite code: `MAPLE-HOUSE`

The seed builds accounts, categories, budgets, and transactions relative to today, including a grocery purchase split across categories. History, the home spend estimate, and plan totals are computed from those rows.

No bank credentials are required. Leave `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` empty unless you want to try Google sign-in. Set `RESEND_API_KEY` and `RESEND_FROM` to email verification links through Resend. The sender is whatever `RESEND_FROM` is set to. Production and preview use `noreply@dollas.kylependergast.com`. When both variables are unset, local development writes the link to the server log.

`DATABASE_URL` is the restricted `dollas_app` role. It cannot bypass row-level security, and it cannot apply schema changes. `DATABASE_MIGRATE_URL` is the table owner, used by `pnpm db:migrate` and `pnpm db:seed`. After those have run, starting the app sees the current Drizzle journal and does not apply anything.

## Checks

```bash
pnpm test
pnpm lint
pnpm typecheck
```

Domain tests cover household access (members only, and unverified email/password stays out) and the partial-month history rule: the current month is not treated as finished, and its year-over-year change is “Not comparable yet” with no dollar delta. Web tests cover startup migrations: an already current schema is a no-op, and startup does not read `DATABASE_MIGRATE_URL` when `DATABASE_URL` or `DATABASE_URL_UNPOOLED` is set. They also cover verification email: Resend sends the link when it is configured, and local development without those variables still writes the link to the server log.

CI runs a gitleaks secret scan and a code-quality scan (lint, types, and tests).

## Production

The Next.js app is the pnpm workspace package `@dollas/web` in `apps/web`. On the Vercel project, set the root directory to `apps/web`. The install command is `pnpm install --frozen-lockfile --filter @dollas/web...` (also in `apps/web/vercel.json`). The workspace root and `packages/domain` have to be included in the build, which is the “Include source files outside of the Root Directory” setting. Node on that project is 24.x.

Set these environment variables in Vercel. Do not commit secret values. `RESEND_API_KEY` lives only on Vercel.

| Name | Required | Role |
| --- | --- | --- |
| `DATABASE_URL` | Yes | Pooled Postgres URL injected by the Neon marketplace integration. Startup uses it for migrations when `DATABASE_URL_UNPOOLED` is unset. Money stays integer cents. |
| `DATABASE_URL_UNPOOLED` | Injected with Neon | Direct Postgres URL. Startup prefers it so schema changes and the migration lock keep one session. |
| `BETTER_AUTH_SECRET` | Yes | Signs sessions. There is no production fallback. |
| `BETTER_AUTH_URL` | Yes | Public site origin, including `https://`. |
| `RESEND_API_KEY` | Yes | Sends email-verification links through Resend. Set on Vercel for production and preview. Do not commit a value. |
| `RESEND_FROM` | Yes | From address on those messages. Production and preview set this to `noreply@dollas.kylependergast.com`. The app sends from the value of this variable. |
| `DATABASE_MIGRATE_URL` | No | Not set on Vercel and not read at startup. Local `pnpm db:migrate` and `pnpm db:seed` still use it. |
| `GOOGLE_CLIENT_ID` | No | Google sign-in. Counts as a verified email. Set both or neither. |
| `GOOGLE_CLIENT_SECRET` | No | Pairs with `GOOGLE_CLIENT_ID`. |

On boot, the Node.js server applies the Drizzle journal in `apps/web/drizzle` before it accepts requests. A fresh Neon database has no tables and an empty journal, so the first Vercel boot runs `0000_books`, `0001_household_access`, and `0002_household_rls` through Drizzle's migrator and records them in `drizzle.__drizzle_migrations`. Startup uses `DATABASE_URL_UNPOOLED` when it is set, otherwise `DATABASE_URL`. A later boot, or a boot whose journal is already current, does nothing. Several instances can cold-start together: they take a Postgres advisory lock, so one applies the pending migrations and the others wait and then skip them. Startup does not seed data.

Do not run `pnpm db:seed` against the production database.

## Screens

Phone navigation is Home, Activity, Accounts, Plan, and History. The projection is linked from the home spend estimate and is not a phone tab. The current month’s history column is hatched amber and labeled “so far”. A green change means this year spent less; red means more.
