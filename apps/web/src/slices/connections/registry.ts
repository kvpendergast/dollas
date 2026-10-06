import {
  createFakeBankProvider,
  createProviderRegistry,
  createSimpleFinProvider,
  type ProviderRegistry,
} from "@dollas/domain";

/**
 * Selection seam for bank providers. The fake provider covers tests and local
 * seed. SimpleFIN is the live provider. Teller and Plaid are not chosen.
 * Loopback claim URLs are allowed outside production so a local mock bridge works.
 */
export function bankProviderRegistry(): ProviderRegistry {
  const registry = createProviderRegistry();
  const fake = registry.register(createFakeBankProvider());
  if (fake.isErr()) throw fake.error;
  const simplefin = registry.register(
    createSimpleFinProvider({ allowLoopback: process.env.NODE_ENV !== "production" }),
  );
  if (simplefin.isErr()) throw simplefin.error;
  return registry;
}
