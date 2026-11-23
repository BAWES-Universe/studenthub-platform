import { kuwaitDay } from "./id-cards.js";

/**
 * Marketing campaigns (contract A-22, the UTM half of legacy admin's campaign screens
 * ADM-B081..084, `common/models/Campaign.php`): staff keep a campaign per set of UTM values,
 * with what was spent on it, and see the clicks its links brought in.
 *
 * The email-campaign half of A-22 is not built: "email campaigns" were dropped on 2026-10-04.
 *
 * Changes from legacy, by the rule that legacy prod is the benchmark and best practice wins:
 * - Legacy kept one running click counter per campaign. Here clicks are counted per Kuwait day,
 *   so a campaign's history can be read and a day can be checked against the source rows.
 * - Legacy's UUID was the primary key and appeared in links; here the campaign has its own id and
 *   the UTM values are unique together, so the same link is never two campaigns.
 * - Signups and revenue were columns legacy wrote from elsewhere. They are not stored here:
 *   attribution at signup is the access lane's and revenue the pay lane's, so both show as not
 *   available until those land, never as 0.
 * - A campaign is retired, never deleted, so the clicks already counted keep their campaign.
 */
export const CAMPAIGN_FIELDS = ["utmSource", "utmMedium", "utmCampaign", "utmContent", "utmTerm"] as const;
export type CampaignField = typeof CAMPAIGN_FIELDS[number];
/** The three UTM values every campaign must have; content and term are optional, as in legacy. */
export const CAMPAIGN_REQUIRED: readonly CampaignField[] = ["utmSource", "utmMedium", "utmCampaign"];
export const CAMPAIGN_CLICK_DAYS = 30;

export interface CampaignInput extends Partial<Record<CampaignField, string | null>> { readonly investment?: string | null }
export interface CampaignRecord extends Record<CampaignField, string | null> {
  readonly id: string; readonly investment: string; readonly retired: boolean;
  /** Clicks in the last `CAMPAIGN_CLICK_DAYS` Kuwait days, and over all time. */
  readonly clicks: { readonly recent: number; readonly total: number };
}
export interface CampaignsPage {
  readonly day: string; readonly campaigns: readonly CampaignRecord[]; readonly clickDays: number;
  /** What each figure legacy also showed is waiting on; the page shows these as not available. */
  readonly missing: readonly { readonly label: string; readonly waitsOn: string }[];
}
export const CAMPAIGN_MISSING = [
  { label: "Signups", waitsOn: "attribution at signup, which the access lane holds" },
  { label: "Revenue", waitsOn: "transfers from the pay lane" },
] as const;

export type CampaignRefusal = "invalid_source" | "invalid_medium" | "invalid_campaign" | "invalid_content" | "invalid_term" | "invalid_investment" | "duplicate" | "unknown" | "retired";
const FIELD_REFUSAL: { readonly [K in CampaignField]: CampaignRefusal } = {
  utmSource: "invalid_source", utmMedium: "invalid_medium", utmCampaign: "invalid_campaign", utmContent: "invalid_content", utmTerm: "invalid_term",
};
/** Money as legacy stored it: at most 9 digits and 3 decimal places, never negative. */
const INVESTMENT = /^\d{1,9}(\.\d{1,3})?$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export interface CampaignValues extends Record<CampaignField, string | null> { readonly investment: string }
/** The values to store, or the first thing wrong with them. A field is trimmed; an empty optional field becomes null. */
export function campaignValues(input: CampaignInput): CampaignValues | { readonly refused: CampaignRefusal } {
  const out: Partial<Record<CampaignField, string | null>> = {};
  for (const field of CAMPAIGN_FIELDS) {
    const raw = input[field];
    const value = typeof raw === "string" ? raw.trim() : raw === null || raw === undefined ? "" : null;
    if (value === null || CONTROL.test(value) || value.length > 100 || (value === "" && CAMPAIGN_REQUIRED.includes(field))) return { refused: FIELD_REFUSAL[field] };
    out[field] = value === "" ? null : value;
  }
  const money = typeof input.investment === "string" ? input.investment.trim() : input.investment === null || input.investment === undefined ? "" : null;
  if (money === null || (money !== "" && !INVESTMENT.test(money))) return { refused: "invalid_investment" };
  return { ...(out as Record<CampaignField, string | null>), investment: money === "" ? "0" : money };
}

export interface CampaignsStore {
  /** Every campaign with its clicks, as of one Kuwait day; retired ones last. */
  list(day: string, clickDays: number): Promise<readonly CampaignRecord[]>;
  /** The new campaign's id, or `duplicate` when those UTM values are already a live campaign. */
  create(values: CampaignValues, by: string, at: Date): Promise<{ id: string } | { refused: "duplicate" }>;
  /** `unknown` for an id that is not a campaign, `retired` for one already retired, `duplicate` when the new values are another live campaign's. */
  update(id: string, values: CampaignValues, at: Date): Promise<true | { refused: "unknown" | "retired" | "duplicate" }>;
  retire(id: string, at: Date): Promise<true | { refused: "unknown" | "retired" }>;
}

export class CampaignsService {
  readonly #store: CampaignsStore; readonly #authority: { isStaff(principalId: string): Promise<boolean> }; readonly #now: () => Date;
  constructor(store: CampaignsStore, authority: { isStaff(principalId: string): Promise<boolean> }, now: () => Date = () => new Date()) {
    this.#store = store; this.#authority = authority; this.#now = now;
  }
  /** Every campaign for a staff member; undefined for anyone else, before anything is read. */
  async page(viewer: string): Promise<CampaignsPage | undefined> {
    if (!(await this.#authority.isStaff(viewer))) return undefined;
    const day = kuwaitDay(this.#now());
    return { day, clickDays: CAMPAIGN_CLICK_DAYS, campaigns: await this.#store.list(day, CAMPAIGN_CLICK_DAYS), missing: CAMPAIGN_MISSING };
  }
  /** Creates a campaign; undefined for anyone who is not staff, so nothing is written. */
  async create(viewer: string, input: CampaignInput): Promise<{ id: string } | { refused: CampaignRefusal } | undefined> {
    if (!(await this.#authority.isStaff(viewer))) return undefined;
    const values = campaignValues(input);
    if ("refused" in values) return values;
    return this.#store.create(values, viewer, this.#now());
  }
  async update(viewer: string, id: string, input: CampaignInput): Promise<true | { refused: CampaignRefusal } | undefined> {
    if (!(await this.#authority.isStaff(viewer))) return undefined;
    const values = campaignValues(input);
    if ("refused" in values) return values;
    return this.#store.update(id, values, this.#now());
  }
  async retire(viewer: string, id: string): Promise<true | { refused: CampaignRefusal } | undefined> {
    if (!(await this.#authority.isStaff(viewer))) return undefined;
    return this.#store.retire(id, this.#now());
  }
}
