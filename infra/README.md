# Deploy Dollas to Vercel with Pulumi

This package (`@dollas/infra`) is a Pulumi program that deploys Dollas to Vercel. Fork the repo, bring a Postgres URL, set a few config values, and `pulumi up` creates:

- the **Vercel project**: Next.js, root directory `apps/web` (the pnpm workspace app), Node 24.x, optionally linked to your GitHub repo;
- **every environment variable the app reads**, for production and preview, from stack config. Secrets are Pulumi secrets (encrypted in state) and Vercel *sensitive* variables;
- the **`dollas_app` LOGIN role** in your database and `DATABASE_URL_APP` (PEN-214), so Postgres row-level security binds the app's own connection;
- an optional **custom domain**.

It can also **adopt an existing Vercel project** and its variables without recreating, duplicating, or changing anything (see [Adopt an existing project](#adopt-an-existing-project)).

Secrets never go in the repo: they live in Pulumi config (encrypted per stack) or, for variables you adopt, stay in Vercel. `Pulumi.<stack>.yaml` is git-ignored. The Vercel build never installs this package (Vercel installs `--filter @dollas/web...` only).

Contents: [Prerequisites](#prerequisites) · [Where stacks live](#where-stacks-live) · [Quickstart](#quickstart-fork-and-deploy) · [Migrations](#migrations) · [Config reference](#config-reference) · [Adopt an existing project](#adopt-an-existing-project) · [Rotate secrets](#rotate-secrets) · [Preview deployments](#preview-deployments) · [Tear down](#tear-down) · [Repair](#repair) · [Database choices](#database-choices) · [Layout and local checks](#layout-and-local-checks)

## Prerequisites

- **Pulumi CLI** (https://www.pulumi.com/docs/iac/download-install/), for example `curl -fsSL https://get.pulumi.com | sh`. On first use it downloads two provider plugins, `random` 4.21.2 and `pulumiverse/vercel` 5.4.1. No npm install scripts are needed, so the repo's pnpm supply-chain settings stay as they are.
- **Node 24 and pnpm** (the repo's `packageManager`). Run `pnpm install` from the repo root.
- **A Vercel account and token**: https://vercel.com/account/tokens, scoped to the team that will own the project. To link a GitHub repo, install the Vercel GitHub app on that repo first.
- **A Postgres database and its owner URL.** Neon is recommended (see [Database choices](#database-choices)). You need the **owner, direct (unpooled)** URL, for example `postgresql://neondb_owner:…@ep-…​.us-east-2.aws.neon.tech/neondb?sslmode=require` (host without `-pooler`). Reading it in the Neon console is fine, but **never create roles there**: roles made in the Neon console, CLI, or API join `neon_superuser`, which bypasses row-level security. Pulumi creates `dollas_app` with plain SQL instead.

## Where stacks live

A stack holds Pulumi state: resource ids, plus every secret, encrypted. Pick one backend per deployment and share it with whoever runs `pulumi up`.

| | Pulumi Cloud (recommended) | Self-managed bucket |
| --- | --- | --- |
| Set up | `pulumi login` | `pulumi login s3://my-bucket/dollas` (or `gs://`, `azblob://`, `file://`) |
| Secrets | Encrypted with a per-stack key held by Pulumi Cloud | Encrypted with a passphrase (`PULUMI_CONFIG_PASSPHRASE`) or a KMS key (`pulumi stack init --secrets-provider awskms://…`) |
| Locking, history | Built in, with an audit log and a web view of every update | Lock files in the bucket; history as checkpoint files |
| Sharing | Invite people to the org or stack (free for one person, paid for teams) | Grant bucket access, and share the passphrase or KMS key |
| Cost | Free for individuals | The bucket |

**Recommendation: Pulumi Cloud.** For a one- or two-person deployment it is free. It handles locking and secret keys, and nothing else needs safekeeping: a lost passphrase makes a self-managed stack's secrets unrecoverable. Choose a self-managed bucket if you'd rather no third party holds state. Use KMS rather than a passphrase if more than one person deploys.

## Quickstart (fork and deploy)

From a fork, with a new, empty Postgres database:

```bash
pnpm install
cd infra
pulumi login                       # or a self-managed backend, see above
pulumi stack init production

pulumi config set --secret vercel:apiToken           # paste; leaving the value out makes Pulumi prompt, so it stays out of shell history
pulumi config set dollas:vercelTeamId team_…         # omit to use the token's personal account
pulumi config set --secret dollas:ownerDatabaseUrl   # paste the owner direct URL
pulumi config set dollas:gitRepository you/dollas    # optional: deploys on every push
```

Optional extras, each all-or-nothing (the program refuses half a pair):

```bash
pulumi config set dollas:domain dollas.example.com    # also sets BETTER_AUTH_URL to https://dollas.example.com
pulumi config set --secret dollas:resendApiKey        # email verification and password reset
pulumi config set dollas:resendFrom no-reply@dollas.example.com
pulumi config set --secret dollas:googleClientId      # Google sign-in
pulumi config set --secret dollas:googleClientSecret
pulumi config set --secret dollas:plaidClientId       # Plaid bank linking
pulumi config set --secret dollas:plaidSecret
pulumi config set dollas:plaidEnv sandbox
```

Then:

```bash
pulumi preview --diff     # 11 creates with no extras, 20 with all of the above; every value shows as [secret]
pulumi up
```

`BETTER_AUTH_SECRET` and `BANK_CONNECTION_KEYS` are generated when you don't set them (64 random characters, and one 32-byte AES key as `1:<base64>`). Back up the bank key now: `pulumi stack output bankConnectionKeys --show-secrets`. It's in state, but without it, stored bank tokens can't be decrypted.

**First deploy.** With `gitRepository`, push to the production branch (`git commit --allow-empty -m "Deploy" && git push`). Without a linked repo, run `vercel link` from the repo root (choose the project Pulumi created) and then `vercel deploy --prod`. On first boot the app migrates the empty database ([Migrations](#migrations)), then checks the `dollas_app` login before it serves.

**Check it:**

1. `psql "$(pulumi stack output appDatabaseUrl --show-secrets)" -f sql/verify-dollas-app.sql` should print `current_user = dollas_app`, `f` for every privilege, and 0 households.
2. The production function log at boot says `App pool connects as the dollas_app login (DATABASE_URL_APP).`
3. In Vercel, Project Settings, Build and Deployment, "Include source files outside of the Root Directory" must be **on**. That's the default for new projects. The Vercel provider can't set it, and the build needs `packages/` from the workspace root.
4. For a custom domain, add the DNS record Vercel shows under Project Settings, Domains.

## Migrations

**Migrations run when the app boots, against the owner URL. Pulumi doesn't run them.**

Each deployment's server applies its own Drizzle journal (`apps/web/drizzle`) before it accepts a request, connecting as `DATABASE_URL_UNPOOLED` (the owner, direct), or `DATABASE_URL` when that's unset. Instances that cold-start together take a Postgres advisory lock: one migrates, the others wait and then find nothing to do. A boot whose journal is already current does nothing. After migrating, startup re-applies the `dollas_app` grants, then checks the login. If any step fails, the app refuses to serve.

Why not a Pulumi `command` resource or a CI pre-deploy step? Those run on someone's machine at `pulumi up` time, with no tie to the code Vercel is about to deploy. They would migrate too early (old code meets a new schema) or be forgotten, and they'd put the owner URL on every operator's laptop. Migrating at boot ties each schema change to the code that needs it, and it's already tested.

When you want to apply migrations by hand first (for example, to watch a long one), run this from the repo root at the commit you're about to deploy:

```bash
DATABASE_MIGRATE_URL="$(cd infra && pulumi config get dollas:ownerDatabaseUrl)" pnpm --filter @dollas/web db:migrate
```

The deployment then boots, sees a current journal, and skips the step. Previews share the production database by default (see [Preview deployments](#preview-deployments)), so **a preview of a branch with a new migration applies it to production**. Keep migrations additive and backward compatible, as the existing ones are.

## Config reference

All keys are in the `dollas` namespace except `vercel:apiToken`. "Secret" means set it with `pulumi config set --secret`. Run `pulumi preview` after any change; the program validates everything up front and lists every problem at once.

| Key | Secret | Default | Meaning |
| --- | --- | --- | --- |
| `vercel:apiToken` | yes | required | Vercel token for the team that owns the project. |
| `ownerDatabaseUrl` | yes | required | Postgres **owner**, direct URL. Pulumi uses it to run the `dollas_app` SQL; with `databaseEnv=pulumi` it is also `DATABASE_URL_UNPOOLED`. |
| `ownerPooledDatabaseUrl` | yes | Neon pooled form of the owner URL (`ep-…-pooler…`), or the owner URL elsewhere | `DATABASE_URL` (owner, pooled). Only with `databaseEnv=pulumi`. |
| `databaseEnv` | | `pulumi` (required when adopting) | `pulumi`: Pulumi sets `DATABASE_URL` and `DATABASE_URL_UNPOOLED`. `integration`: the Neon Vercel integration sets them, and Pulumi leaves them alone. |
| `appDatabaseHost` | | pooled owner host | Host in `DATABASE_URL_APP`. |
| `appPasswordVersion` | | `1` | Change it to rotate the `dollas_app` password. |
| `projectName` | | `dollas` | Vercel project name (lowercase). |
| `vercelTeamId` | | the token's personal account | `team_…`. |
| `vercelProjectId` | | unset | `prj_…` of an **existing** project to adopt instead of creating one. |
| `gitRepository` | | unset | `owner/repo` on GitHub. Vercel deploys on push. |
| `productionBranch` | | `main` | Branch that deploys to production. |
| `nodeVersion` | | `24.x` | Node version on Vercel. |
| `installCommand`, `buildCommand` | | unset | Override only if needed. `apps/web/vercel.json` sets the install command and the Next.js preset runs `next build`. |
| `domain` | | unset | Custom domain, for example `dollas.example.com`. |
| `adoptDomain` | | `false` | The domain is already on the adopted project: import it instead of adding it. |
| `vercelTargets` | | `production,preview` | Environments that get each variable. Sensitive variables can't target development. |
| `protect` | | `true` when adopting, else `false` | Pulumi `protect` on the project, the domain, and adopted variables. Deleting or replacing them fails instead of happening. |
| `generateSecrets` | | `true`, but `false` when adopting | Generate `BETTER_AUTH_SECRET` and `BANK_CONNECTION_KEYS` when they aren't set. Off when adopting, because a new auth secret signs everyone out and a new bank key can't read stored tokens. |
| `betterAuthUrl` | | `https://<domain>`, else unset | `BETTER_AUTH_URL`, an https origin. When it's unset, the app uses Vercel's production URL. |
| `betterAuthSecret` | yes | generated (see `generateSecrets`) | `BETTER_AUTH_SECRET`, at least 32 characters. |
| `bankConnectionKeys` | yes | generated (see `generateSecrets`) | `BANK_CONNECTION_KEYS`: `version:base64` entries (32 bytes each), comma-separated, newest first. |
| `resendApiKey` + `resendFrom` | key: yes | unset | `RESEND_API_KEY`, `RESEND_FROM` (a plain email address). Both or neither. |
| `googleClientId` + `googleClientSecret` | yes | unset | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. Both or neither. |
| `plaidClientId` + `plaidSecret` + `plaidEnv` | id, secret: yes | unset | `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV` (`sandbox` or `production`; Trial is production). All three or none. |
| `plaidRedirectUri` | | unset | `PLAID_REDIRECT_URI`, https (`http://localhost` only in sandbox). Needs the Plaid settings. |
| `adoptEnv` | | required when adopting (`{}` allowed) | Existing variables to adopt: `{ KEY: [{ id, targets, sensitive? }] }`. See below. |

Variables this recipe manages: `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `DATABASE_URL_APP`, `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, `BANK_CONNECTION_KEYS`, `RESEND_API_KEY`, `RESEND_FROM`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`, `PLAID_REDIRECT_URI`. A test checks this list against the app's own list of deploy variables. `DATABASE_MIGRATE_URL` is local tooling only and is never set on Vercel. Anything else in the project (integration variables, your own) is left alone.

## Adopt an existing project

For a project that's already running, like Kyle's `dollas` (`prj_BR3J6q8u5Mf2elb9J0Z5u4TQlrvN` in `team_yhAulgIZyqJ2NaA2CU1yTZCn`, Neon integration). Adopting **imports** the project and its existing variables into the stack. Nothing is recreated, and adopted variables **keep the values already in Vercel**, so you don't need to know any secret. Pulumi creates only what's missing, which for Kyle is `DATABASE_URL_APP`.

How adoption keeps things safe:

- The project and each listed variable carry Pulumi's `import` option. The first `pulumi up` reads them and writes nothing.
- An adopted variable ignores changes to its value, comment, targets, and sensitivity. Pulumi never sends it an update, which for a sensitive variable would overwrite the secret it can't read. Setting a config value for an adopted key is rejected as ambiguous.
- The project ignores settings Pulumi would otherwise reset to its own defaults (`autoAssignCustomDomains`, `gitForkProtection`, `oidcTokenConfig`), plus install and build commands you didn't set.
- Everything adopted is `protect`ed. A config mistake that would delete or replace it fails the preview instead.
- A variable that exists in Vercel but is missing from `adoptEnv` isn't duplicated: Vercel refuses the create (`ENV_CONFLICT … the conflicting environment variable ID is …`) and `pulumi up` stops. Add it to `adoptEnv` and run again.
- Secrets are never generated for an adopted project unless you set `generateSecrets`.

### Kyle's runbook

These steps include all of the PEN-214 rollout. If you already ran PEN-214's `pulumi up`, reuse that stack: steps 1 to 3 are done, and the preview below shows `database-url-app` as unchanged.

1. **Merge this PR and let production deploy.** Without `DATABASE_URL_APP` the app keeps the `SET LOCAL ROLE` bridge and logs a warning that the login is missing.
2. **Stack and credentials** (from the repo root, after `git pull && pnpm install`):

   ```bash
   cd infra
   pulumi login                                   # Pulumi Cloud, recommended
   pulumi stack init production
   pulumi config set dollas:vercelProjectId prj_BR3J6q8u5Mf2elb9J0Z5u4TQlrvN
   pulumi config set dollas:vercelTeamId team_yhAulgIZyqJ2NaA2CU1yTZCn
   pulumi config set --secret dollas:ownerDatabaseUrl   # Neon owner direct URL = Vercel's DATABASE_URL_UNPOOLED
   pulumi config set --secret vercel:apiToken
   ```

3. **Project settings Pulumi should own:**

   ```bash
   pulumi config set dollas:gitRepository kvpendergast/dollas
   ```

4. **List the existing variables to adopt.** This reads the project's variable list from the Vercel API (keys, ids, targets, types; never values) and prints the config commands:

   ```bash
   VERCEL_API_TOKEN="$(pulumi config get vercel:apiToken)" pnpm --silent adopt-env --project prj_BR3J6q8u5Mf2elb9J0Z5u4TQlrvN --team team_yhAulgIZyqJ2NaA2CU1yTZCn
   ```

   Read the output, then run the printed lines (or pipe them: `… | grep '^pulumi config' | bash`). For Kyle's project it prints `databaseEnv integration`, because the Neon integration owns `DATABASE_URL` and `DATABASE_URL_UNPOOLED`. It also prints entries for `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, `BANK_CONNECTION_KEYS`, `RESEND_API_KEY`, `RESEND_FROM`, and both target-specific entries of `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Lines starting with `# note:` explain anything it left alone. If it notes that `DATABASE_URL_APP` already exists and you didn't create it with PEN-214's Pulumi stack, delete it in Vercel first.

5. **Preview:**

   ```bash
   pulumi preview --diff
   ```

   Expect `= import` (🔒) for `dollas-project` and each adopted variable. Expect `+ create` for `dollas-app-password`, `dollas-app-login`, and `database-url-app`, or "unchanged" if PEN-214 was already applied. Expect **no** `~` update, `+-` replace, or `-` delete. If Pulumi says the inputs to import don't match the existing project, the project differs from config in a setting the recipe owns. Set the matching key (`nodeVersion`, `productionBranch`, `gitRepository`, `projectName`, `installCommand`, `buildCommand`) to the value shown and preview again.

6. **Apply:** `pulumi up`. The imports write nothing to Vercel. `dollas-app-login` runs the role SQL as the owner, then logs in as `dollas_app` with the new password. If either step fails, nothing is changed. Then `pulumi preview --expect-no-changes` should pass.
7. **Check the login** (prints no secret):

   ```bash
   psql "$(pulumi stack output appDatabaseUrl --show-secrets)" -f sql/verify-dollas-app.sql
   ```

   Expect `current_user = dollas_app`; `f` for superuser, bypassrls, createrole, createdb, and neon_superuser; and `0` households visible. A `permission denied for table household` means startup hasn't granted tables to `dollas_app` on this database yet; deploy once and check again.
8. **Redeploy production** so it picks up `DATABASE_URL_APP`: Vercel dashboard, Deployments, the latest production deployment, **Redeploy** (or `vercel redeploy <url> --scope <team>`). Previews get it on their next build.
9. **Check the app.** The boot log says `App pool connects as the dollas_app login (DATABASE_URL_APP).` with no bridge warning. Sign in and open Activity. As the owner:

   ```sql
   select usename, application_name, count(*) from pg_stat_activity
   where datname = current_database() group by 1, 2 order by 1;
   ```

   App connections show as `dollas_app`. The web app, Better Auth, and `/api/mcp` all share this pool.

### Hand a value over to Pulumi later

Adopted variables stay in Vercel's hands. To have Pulumi own one, for example to rotate `RESEND_API_KEY` from config, do these in order: set the value in config, remove that key from `adoptEnv`, and run `pulumi up`. The resource keeps its name, so it updates in place. A key adopted as split entries (like `GOOGLE_CLIENT_ID` with separate production and preview entries) changes resource names when un-adopted, and `protect` stops that. For those, merge the entries in Vercel and adopt again, or keep rotating them in Vercel.

To stop managing something without deleting it: `pulumi state unprotect '<urn>' && pulumi state delete '<urn>'`. `pulumi stack --show-urns` lists the URNs.

## Rotate secrets

Run `pulumi up`, then **redeploy production** (Vercel applies variable changes on the next deployment). Previews pick changes up on their next build.

| Secret | Pulumi-owned | Adopted (kept in Vercel) |
| --- | --- | --- |
| `dollas_app` password | `pulumi config set dollas:appPasswordVersion <new>`, then `pulumi up`. The old password stops working as soon as `up` finishes, and a cold start on the old deployment fails its login check until the redeploy is live, so do it at a quiet time. Zero downtime would need a second login role (out of scope). | n/a (always Pulumi-owned) |
| `BETTER_AUTH_SECRET` | `pulumi config set --secret dollas:betterAuthSecret` with a new value, or, if it was generated, `pulumi up --replace 'urn:…::random:index/randomPassword:RandomPassword::better-auth-secret'`. **Signs everyone out** and turns off open invite links. | Edit it in Vercel. Same effect. |
| `BANK_CONNECTION_KEYS` | Prepend a new key and keep the old one so stored tokens still decrypt: `pulumi config set --secret dollas:bankConnectionKeys "2:$(openssl rand -base64 32),<current value>"`. If it was generated, get the current value with `pulumi stack output bankConnectionKeys --show-secrets`. | Edit it in Vercel the same way (new version first, old kept). |
| Resend, Google, Plaid | `pulumi config set --secret dollas:<key>` with the new value, then `pulumi up`. | Edit it in Vercel. |
| Vercel token | `pulumi config set --secret vercel:apiToken`. Not deployed. | |
| Owner URL (Neon password reset) | `pulumi config set --secret dollas:ownerDatabaseUrl`. With `databaseEnv=integration`, Neon updates Vercel itself. | |

## Preview deployments

By default, previews and production share one database: Pulumi (or the Neon integration) targets both with the same `DATABASE_URL*`, and `DATABASE_URL_APP` follows. As of 2026-10-10 Kyle's project is set up this way. If Neon preview branching is turned on later, each preview gets a branch `DATABASE_URL`, but a project-wide `DATABASE_URL_APP` would still point at production. The app then refuses to start (`DATABASE_URL_APP points at a different database than DATABASE_URL`), which fails safely. Supporting branching would need per-branch `DATABASE_URL_APP` values; branches do copy roles, including `dollas_app`. To keep previews off production data, set `dollas:vercelTargets production` and give previews their own database by hand.

## Tear down

- **A deployment this recipe created** (`protect` off): `pulumi destroy` deletes the Vercel project (with all its deployments and variables) and the domain. It deliberately **leaves the database and the `dollas_app` role alone**. To finish, drop the Neon project or database yourself, or run `ALTER ROLE dollas_app NOLOGIN` as the owner. Then `pulumi stack rm`.
- **An adopted project** is protected, so `pulumi destroy` fails rather than deleting your production project. To detach Pulumi without touching Vercel, unprotect and remove each resource from state (`pulumi state unprotect --all`, then `pulumi state delete '<urn>'` per resource), or drop the whole stack with `pulumi stack rm --force`. To remove only `DATABASE_URL_APP` (fall back to the bridge): `pulumi destroy --target 'urn:pulumi:production::dollas::vercel:index/projectEnvironmentVariable:ProjectEnvironmentVariable::database-url-app'`, then redeploy.

## Repair

- **Production refuses to start with "Could not log in with DATABASE_URL_APP … (28000)"** (`dollas_app` lost LOGIN) **or (28P01)** (password mismatch). Builds before PEN-214 ran `ALTER ROLE dollas_app NOLOGIN …` at boot on Vercel; an old preview could still try. Re-apply the SQL with the same password, then redeploy:

  ```bash
  pulumi up --replace 'urn:pulumi:production::dollas::pulumi-nodejs:dynamic:Resource::dollas-app-login'
  ```

- **`pulumi up` says dollas_app is in neon_superuser.** Someone created it in the Neon console. Delete that role there, run the `--replace` above to create it cleanly, redeploy, and let startup re-apply the grants.
- **`pulumi up` fails with ENV_CONFLICT.** A variable already exists in Vercel that the stack would create. Adopt it (`adopt-env`, step 4), or delete it in Vercel if it's stale.
- **Preview says a protected resource "cannot be deleted".** Config dropped something adopted (often an `adoptEnv` entry). Restore the config, or see [Hand a value over](#hand-a-value-over-to-pulumi-later).

## Database choices

**Bring your own Postgres URL** is the only built-in path: any Postgres 16+ whose owner can `CREATE ROLE` (Neon, Supabase, RDS, Crunchy, a VM). **Neon is recommended**: it scales to zero, has a free tier, and Kyle's deployment runs on it. With Neon you can either:

- create the project in the Neon console and copy the owner direct URL (`databaseEnv=pulumi`; Pulumi sets `DATABASE_URL` from the `-pooler` host and `DATABASE_URL_UNPOOLED` from the direct one), or
- install the **Neon Vercel integration** on the project and set `databaseEnv=integration` (Neon then injects `DATABASE_URL*`).

There's no Pulumi Neon provider here. As of 2026-10, no Pulumi- or Neon-published provider exists, only community packages (`pulumi-neon`, last published 2024, and `@sst-provider/neon`), so it doesn't meet the bar for a dependency that holds database owner credentials. Creating the Neon project takes one console step and is documented above. Never create `dollas_app` through Neon in any case.

## Rules for dollas_app (PEN-214)

- `dollas_app` is created only by `sql/dollas-app-login.sql`, run by Pulumi as the database owner. The SQL refuses to continue (and changes nothing) if `dollas_app` is in `neon_superuser`, is a superuser, or has BYPASSRLS, REPLICATION, CREATEROLE, or CREATEDB.
- The app never creates the login or its password. On boot it only creates a `NOLOGIN` `dollas_app` if none exists (for the bridge) and re-applies table grants.
- When `DATABASE_URL_APP` is set, the app refuses to start unless that login is `dollas_app` and passes every check: not a superuser; no BYPASSRLS, CREATEROLE, or CREATEDB; not in `neon_superuser` or any superuser or BYPASSRLS role; not the table owner; and on the same database as `DATABASE_URL`.
- The password is 48 random letters and digits (about 285 bits), from `random.RandomPassword`, encrypted in state.

### Follow-up: delete the bridge

Once production and preview both run with `DATABASE_URL_APP` (the boot log shows the login line, not the bridge warning), remove the PEN-213 bridge in one PR: `asAppRole`, `ASSUME_APP_ROLE_SQL`, and `assertAppRoleSubjectToRls` (`apps/web/src/db/app-role.ts`, `apply-migrations.ts`); the `bridge` mode in `appPoolConfig` and `openAppDatabase` and its warning; `GRANT dollas_app TO current_user` in `APP_GRANT_SQL`; and `APP_ROLE_SQL`. Then make `DATABASE_URL_APP` required.

## Layout and local checks

```
infra/
  index.ts                       composes the stack
  Pulumi.yaml                    project "dollas", Node.js + TypeScript
  sql/dollas-app-login.sql       idempotent role SQL, run as the owner
  sql/verify-dollas-app.sql      what to check while logged in as dollas_app
  src/settings.ts                config parsing and validation, no Pulumi (unit tested)
  src/config.ts                  reads the "dollas" namespace into settings
  src/adopt.ts                   adoptEnv from a Vercel variable listing (unit tested)
  src/database/app-login.ts      dynamic resource: runs the SQL, proves the login works
  src/database/app-login-sql.ts  SQL rendering, DATABASE_URL_APP building (unit tested)
  src/vercel/project.ts          Vercel project and optional domain
  src/vercel/env.ts              one Vercel variable per planned entry; adoption rules
  scripts/adopt-env.ts           read-only helper behind `pnpm adopt-env`
```

```bash
pnpm --filter @dollas/infra typecheck
pnpm --filter @dollas/infra test
```

To try the program without real credentials, use a throwaway local stack:

```bash
export PULUMI_BACKEND_URL=file://$(mktemp -d) PULUMI_CONFIG_PASSPHRASE=throwaway
pulumi stack init scratch
pulumi config set --secret vercel:apiToken 0123456789abcdef01234567
pulumi config set --secret dollas:ownerDatabaseUrl postgresql://owner:pw@127.0.0.1:5433/neondb
pulumi preview --diff
```

A fresh-fork preview calls no Vercel API; the provider only fetches Vercel's public frameworks list to validate `framework`. `pulumi up --target` on the password and `dollas-app-login` URNs runs the role SQL for real against that database; the Vercel resources need a real token.
