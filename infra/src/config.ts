import * as pulumi from "@pulumi/pulumi";
import { parseSettings, type Settings } from "./settings";

export { parseTargets, VERCEL_TARGETS, type VercelTarget } from "./settings";

/** Reads the "dollas" config namespace into validated settings. Secrets stay Outputs. */
export function readSettings(config = new pulumi.Config("dollas")): Settings<pulumi.Output<string>> {
  return parseSettings<pulumi.Output<string>>({
    plain: (key) => config.get(key),
    secret: (key) => config.getSecret(key),
    adoptEnv: () => config.getObject<unknown>("adoptEnv"),
  });
}
