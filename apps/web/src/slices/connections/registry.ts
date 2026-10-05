import { createFakeBankProvider, createProviderRegistry, type ProviderRegistry } from "@dollas/domain";

/**
 * Selection seam for bank providers. The fake provider covers tests and local
 * seed. SimpleFIN registers here in a later change; Teller and Plaid are not chosen.
 */
export function bankProviderRegistry(): ProviderRegistry {
  const registry = createProviderRegistry();
  const registered = registry.register(createFakeBankProvider());
  if (registered.isErr()) throw registered.error;
  return registry;
}
