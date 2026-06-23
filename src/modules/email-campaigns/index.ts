// ---------------------------------------------------------------------------
// Email-campaigns — barrel exports
// ---------------------------------------------------------------------------

export {
  listEmailCampaigns,
  getEmailCampaign,
} from "./actions";

export type {
  EmailCampaignListItem,
  ListEmailCampaignsResult,
} from "./schemas";

export {
  emailCampaignListItemSchema,
  listEmailCampaignsResultSchema,
  listEmailCampaignsSchema,
  getEmailCampaignSchema,
} from "./schemas";
