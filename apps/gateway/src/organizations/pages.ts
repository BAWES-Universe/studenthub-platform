import type { GatewayRouteContext } from "../routes/context.js";
import { handleOrganizationOverviewPage } from "./overview-page.js";
import { handleOrganizationEditPage } from "./edit-page.js";
import { handleOrganizationStoresPage } from "./stores-page.js";

export async function handleOrganizationPages(ctx: GatewayRouteContext): Promise<boolean> {
  if (await handleOrganizationOverviewPage(ctx)) return true;
  if (await handleOrganizationEditPage(ctx)) return true;
  return handleOrganizationStoresPage(ctx);
}
