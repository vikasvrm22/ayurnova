/**
 * Provider-agnostic courier registry - the shipping equivalent of
 * integrationsAdmin.js's PROVIDERS map. A future real courier (Shiprocket,
 * Delhivery, ...) plugs in by writing one module with the same shape as
 * ./manual/provider.js and adding one entry here; shipmentService.js and
 * every route in this codebase only ever go through this map, never a
 * concrete provider module directly, so adding a courier never touches
 * order/shipment business logic.
 */
import * as manualProvider from "./manual/provider.js";

export const SHIPPING_PROVIDERS = {
  manual: manualProvider,
};

export const SHIPPING_ENVIRONMENTS = ["test", "production"];

export function listShippingProviders() {
  return Object.entries(SHIPPING_PROVIDERS).map(([key, mod]) => ({ key, label: mod.LABEL || key }));
}
