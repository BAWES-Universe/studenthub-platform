import type { GatewayRouteContext } from "../routes/context.js";

export async function handleOrganizationEditPage(_ctx: GatewayRouteContext): Promise<boolean> {
  // SHU-667 owns the company details edit page.
  return false;
}
