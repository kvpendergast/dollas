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

You need Node.js 22, pnpm, and Postgres 16. Docker Compose is the usual way to get the database.

```bash
docker compose up -d
cp apps/web/.env.example apps/web/.env.local
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Open http://localhost:3000 and sign in with the seed account:

- Email: `ada@maple.local`
- Password: `maple-demo`
- Household: Maple House
- Invite code: `MAPLE-HOUSE`

The seed builds accounts, categories, budgets, and transactions relative to today, including a grocery purchase split across categories. History, the home spend estimate, and plan totals are computed from those rows.

No bank credentials are required. Leave `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` empty unless you want to try Google sign-in. Verification links for email-and-password signups are printed in the server log.

`DATABASE_URL` is the restricted `dollas_app` role. It cannot bypass row-level security. `DATABASE_MIGRATE_URL` is the table owner, used only for migrations and seeding.

## Checks

```bash
pnpm test
pnpm lint
pnpm typecheck
```

Domain tests cover household access (members only, and unverified email/password stays out) and the partial-month history rule: the current month is not treated as finished, and its year-over-year change is “Not comparable yet” with no dollar delta.

CI runs a gitleaks secret scan and a code-quality scan (lint, types, and tests).

## Production

The Next.js app is the pnpm workspace package `@dollas/web` in `apps/web`. On the Vercel project, set the root directory to `apps/web`. The install command is `pnpm install --frozen-lockfile --filter @dollas/web...` (also in `apps/web/vercel.json`). The workspace root and `packages/domain` have to be included in the build, which is the “Include source files outside of the Root Directory” setting. Node on that project is 24.x.

Set these environment variable names in Vercel. Do not commit the values.

| Name | Required | Role |
| --- | --- | --- |
| `DATABASE_URL` | Yes | Postgres URL for the non-owner app role. That role must not bypass row-level security. Money stays integer cents. |
| `BETTER_AUTH_SECRET` | Yes | Signs sessions. There is no production fallback. |
| `BETTER_AUTH_URL` | Yes | Public site origin, including `https://`. |
| `DATABASE_MIGRATE_URL` | For schema changes | Table-owner URL. Used by `pnpm db:migrate`, not by the running app. |
| `GOOGLE_CLIENT_ID` | No | Google sign-in. Counts as a verified email. Set both or neither. |
| `GOOGLE_CLIENT_SECRET` | No | Pairs with `GOOGLE_CLIENT_ID`. |

Apply migrations with the owner URL before people sign in. Do not point production at the local seed password, and do not run `pnpm db:seed` against the production database.

## Screens

Phone navigation is Home, Activity, Accounts, Plan, and History. The projection is linked from the home spend estimate and is not a phone tab. The current month’s history column is hatched amber and labeled “so far”. A green change means this year spent less; red means more.
