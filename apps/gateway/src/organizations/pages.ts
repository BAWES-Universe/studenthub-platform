import type { GatewayRouteContext } from "../routes/context.js";
import { handleOrganizationOverviewPage } from "./overview-page.js";
import { handleOrganizationEditPage } from "./edit-page.js";
import { handleOrganizationStoresPage } from "./stores-page.js";
import { handleOrganizationNotesPage } from "./notes-page.js";
import { handleOrganizationCandidatesPage } from "./candidates-page.js";
import { handleOrganizationAdminPage } from "./admin-page.js";

export async function handleOrganizationPages(ctx: GatewayRouteContext): Promise<boolean> {
  if (await handleOrganizationOverviewPage(ctx)) return true;
  if (await handleOrganizationEditPage(ctx)) return true;
  if (await handleOrganizationStoresPage(ctx)) return true;
  if (await handleOrganizationCandidatesPage(ctx)) return true;
  if (await handleOrganizationAdminPage(ctx)) return true;
  return handleOrganizationNotesPage(ctx);
}
