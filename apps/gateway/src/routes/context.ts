import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthzMiddleware } from "../authz-middleware.js";
import type { CandidateDocuments } from "../../../../packages/private-documents/src/candidate-lifecycle.js";
import type { ReferenceCatalogue } from "@studenthub/reference-catalogue";
import type { ProfileRecordsRuntime } from "../profile-records-http.js";
import type { OrganizationDocumentsRuntime } from "../organization-documents-http.js";
import type { BrowserLoginApplication } from "../web-ui.js";
import type { OrganizationProfile } from "../organization-profile.js";
import type { OrganizationStatus } from "../organization-status.js";
import type { OrganizationCommercialTerms } from "../organization-commercial-terms.js";
import type { OrganizationApprovedToHire } from "../organization-approved-to-hire.js";
import type { OrganizationNotes } from "../organization-notes.js";
import type { PayContractsCreate } from "../pay-contracts-http.js";
import type { OrganizationBrands } from "../organization-brands.js";
import type { OrganizationStores } from "../organization-stores.js";
import type { OrganizationDeletion } from "../organization-deletion.js";
import type { OrganizationCreation } from "../organization-creation.js";
import type { LegacyLinkService } from "../legacy-link-http.js";
import type { CivilIdService } from "@studenthub/profile";
import type { AreaService } from "../area-http.js";

export type GatewayRouteLogin = BrowserLoginApplication & {
  readonly civilId?: CivilIdService;
  readonly area?: AreaService;
  readonly organizationProfile?: OrganizationProfile;
  readonly organizationStatus?: OrganizationStatus;
  readonly organizationCommercialTerms?: OrganizationCommercialTerms;
  readonly organizationApprovedToHire?: OrganizationApprovedToHire;
  readonly organizationNotes?: OrganizationNotes;
  readonly payContracts?: PayContractsCreate;
  readonly organizationBrands?: OrganizationBrands;
  readonly organizationStores?: OrganizationStores;
  readonly organizationDeletion?: OrganizationDeletion;
  readonly organizationCreation?: OrganizationCreation;
  readonly legacyLink?: LegacyLinkService;
};

export interface GatewayRouteContext {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly login: GatewayRouteLogin | undefined;
  readonly authz: AuthzMiddleware;
  readonly documents: CandidateDocuments | undefined;
  readonly catalogue: ReferenceCatalogue | undefined;
  readonly profileRecords: ProfileRecordsRuntime | undefined;
  readonly organizationDocuments: OrganizationDocumentsRuntime | undefined;
  readonly writeHtml: typeof import("../web-ui.js").writeHtml;
  readonly pageDocument: typeof import("../web-ui.js").pageDocument;
  readonly renderError: typeof import("../web-ui.js").renderError;
}

export type GatewayRoute = {
  readonly name: string;
  readonly handle: (ctx: GatewayRouteContext) => Promise<boolean>;
};

export async function runRoutes(routes: readonly GatewayRoute[], ctx: GatewayRouteContext): Promise<boolean> {
  for (const route of routes) {
    if (await route.handle(ctx)) return true;
  }
  return false;
}
