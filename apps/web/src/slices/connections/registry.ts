import {
  createFakeBankProvider,
  createPlaidProvider,
  createProviderRegistry,
  createSimpleFinProvider,
  resolvePlaidConfig,
  type ProviderRegistry,
} from "@dollas/domain";
import { readPlaidEnv } from "./plaid-config";

/**
 * Selection seam for bank providers. The fake provider covers tests and local
 * seed. SimpleFIN is always registered. Plaid registers only when the deployer
 * set PLAID_CLIENT_ID, PLAID_SECRET, and PLAID_ENV. Loopback claim URLs are
 * allowed outside production so a local SimpleFIN mock bridge works.
 */
export function bankProviderRegistry(): ProviderRegistry {
  const registry = createProviderRegistry();
  const fake = registry.register(createFakeBankProvider());
  if (fake.isErr()) throw fake.error;
  const simplefin = registry.register(
    createSimpleFinProvider({ allowLoopback: process.env.NODE_ENV !== "production" }),
  );
  if (simplefin.isErr()) throw simplefin.error;
  const plaid = resolvePlaidConfig(readPlaidEnv());
  if (plaid.isOk() && plaid.value.enabled) {
    const registered = registry.register(createPlaidProvider({ credentials: plaid.value.credentials }));
    if (registered.isErr()) throw registered.error;
  }
  return registry;
}
