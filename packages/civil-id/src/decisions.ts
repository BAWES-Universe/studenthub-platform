import { DEFAULT_OPERATOR_ORG_IDS } from "../../organizations/src/organizations.js";

/** SHU-146 owner defaults, kept together for review. Not a claim about national law. */
export const CIVIL_ID_DECISIONS = Object.freeze({
  digitCounts: Object.freeze({ KW: 12, BH: 9 }),
  timeZone: "Asia/Kuwait",
  operatorOrgIds: DEFAULT_OPERATOR_ORG_IDS,
});
export type CivilIdCountry = keyof typeof CIVIL_ID_DECISIONS.digitCounts;
