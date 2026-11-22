import type { GatewayRouteContext } from "../routes/context.js";

export async function handleOrganizationStoresPage(_ctx: GatewayRouteContext): Promise<boolean> {
  // SHU-668 owns the company stores page.
  return false;
}
