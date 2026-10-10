import * as pulumi from "@pulumi/pulumi";
import { APP_ROLE, appDirectUrl, loadAppLoginSql, renderAppLoginSql } from "./app-login-sql";

type ProviderInputs = {
  ownerDatabaseUrl: string;
  password: string;
  sql: string;
  /** dollas_app on the owner's direct host, for the login check. */
  directAppUrl: string;
};

type ProviderOutputs = {
  role: string;
  /** Fingerprints only, so a changed password or SQL triggers an update. */
  passwordSha256: string;
  sqlSha256: string;
};

/**
 * Runs sql/dollas-app-login.sql as the owner, then logs in as dollas_app with
 * the new password to prove it works. Everything is required inside the
 * functions because Pulumi serializes dynamic providers.
 */
const appLoginProvider: pulumi.dynamic.ResourceProvider<ProviderInputs, ProviderOutputs> = {
  async diff(_id, olds, news) {
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    const sha = (value: string) => createHash("sha256").update(value).digest("hex");
    const changes = olds.passwordSha256 !== sha(news.password) || olds.sqlSha256 !== sha(news.sql);
    return { changes, deleteBeforeReplace: false };
  },

  async create(inputs) {
    return { id: "dollas_app", outs: await applyLogin(inputs) };
  },

  async update(_id, _olds, news) {
    return { outs: await applyLogin(news) };
  },

  async delete() {
    // Leave the role in place: dropping it would cut production off. Retiring
    // the login is a deliberate manual step in infra/README.md.
  },
};

async function applyLogin(inputs: ProviderInputs): Promise<ProviderOutputs> {
  const postgres = require("postgres") as typeof import("postgres");
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");
  const quiet = { max: 1, prepare: false, connect_timeout: 30, onnotice() {} };

  const owner = postgres(inputs.ownerDatabaseUrl, { ...quiet, connection: { application_name: "dollas-pulumi" } });
  try {
    await owner.unsafe(inputs.sql).simple();
  } catch (error) {
    throw new Error(`Could not apply the dollas_app role SQL: ${errorText(error)}`);
  } finally {
    await owner.end({ timeout: 5 });
  }

  const app = postgres(inputs.directAppUrl, { ...quiet, connection: { application_name: "dollas-pulumi-check" } });
  try {
    const rows = await app<{ who: string }[]>`select current_user as who`;
    if (rows[0]?.who !== "dollas_app") throw new Error(`logged in as ${rows[0]?.who ?? "nobody"}`);
  } catch (error) {
    throw new Error(`dollas_app could not log in with the new password: ${errorText(error)}`);
  } finally {
    await app.end({ timeout: 5 });
  }

  return { role: "dollas_app", passwordSha256: sha(inputs.password), sqlSha256: sha(inputs.sql) };

  function errorText(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted-url]").replace(/PASSWORD\s+'[^']*'/gi, "PASSWORD '[redacted]'");
  }
}

export type AppLoginArgs = {
  ownerDatabaseUrl: pulumi.Input<string>;
  password: pulumi.Input<string>;
};

/** The dollas_app LOGIN role in one Postgres database. */
export class AppLogin extends pulumi.dynamic.Resource {
  declare readonly role: pulumi.Output<string>;

  constructor(name: string, args: AppLoginArgs, opts?: pulumi.CustomResourceOptions) {
    const template = loadAppLoginSql();
    const inputs = pulumi.all([args.ownerDatabaseUrl, args.password]).apply(([ownerDatabaseUrl, password]) =>
      pulumi.secret({
        ownerDatabaseUrl,
        password,
        sql: renderAppLoginSql(template, password),
        directAppUrl: appDirectUrl(ownerDatabaseUrl, password),
      }),
    );
    super(
      appLoginProvider,
      name,
      {
        ownerDatabaseUrl: inputs.ownerDatabaseUrl,
        password: inputs.password,
        sql: inputs.sql,
        directAppUrl: inputs.directAppUrl,
        role: undefined,
      },
      { ...opts, additionalSecretOutputs: ["passwordSha256", "sqlSha256"] },
    );
  }
}

export { APP_ROLE };
