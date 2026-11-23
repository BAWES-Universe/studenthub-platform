import assert from "node:assert/strict";
import test from "node:test";
import { CampaignsService, campaignValues, CAMPAIGN_CLICK_DAYS, CAMPAIGN_MISSING, type CampaignInput, type CampaignRecord, type CampaignsStore, type CampaignValues } from "../src/index.js";

const REC: CampaignRecord = { id: "c1", utmSource: "newsletter", utmMedium: "email", utmCampaign: "launch", utmContent: null, utmTerm: null, investment: "0", retired: false, clicks: { recent: 2, total: 5 } };

function rig(over: Partial<CampaignsStore> = {}, staff: readonly string[] = ["staff"]) {
  const calls: unknown[] = [];
  const store: CampaignsStore = {
    async list(day, clickDays) { calls.push(["list", day, clickDays]); return [REC]; },
    async create(values, by, at) { calls.push(["create", values, by, at.toISOString()]); return { id: "new" }; },
    async update(id, values, at) { calls.push(["update", id, values, at.toISOString()]); return true; },
    async retire(id, at) { calls.push(["retire", id, at.toISOString()]); return true; },
    ...over,
  };
  const now = new Date("2026-11-23T09:00:00Z");
  const service = new CampaignsService(store, { isStaff: async id => staff.includes(id) }, () => now);
  return { service, calls, now };
}

test("CAMPAIGN_VALUES trims, drops empty optionals to null, requires the three, and keeps investment", () => {
  assert.deepEqual(campaignValues({ utmSource: " news ", utmMedium: "email", utmCampaign: "launch", utmContent: "", utmTerm: "  ", investment: " 12.500 " }),
    { utmSource: "news", utmMedium: "email", utmCampaign: "launch", utmContent: null, utmTerm: null, investment: "12.500" });
});
test("CAMPAIGN_VALUES empty investment becomes zero, as legacy stored it", () => {
  assert.deepEqual((campaignValues({ utmSource: "s", utmMedium: "m", utmCampaign: "c" }) as CampaignValues).investment, "0");
});
test("CAMPAIGN_VALUES refuses a missing required field, a control character, too long, and a bad investment", () => {
  assert.deepEqual(campaignValues({ utmSource: "", utmMedium: "m", utmCampaign: "c" }), { refused: "invalid_source" });
  assert.deepEqual(campaignValues({ utmSource: "s", utmMedium: "a\tb", utmCampaign: "c" }), { refused: "invalid_medium" });
  assert.deepEqual(campaignValues({ utmSource: "s", utmMedium: "m", utmCampaign: "x".repeat(101) }), { refused: "invalid_campaign" });
  assert.deepEqual(campaignValues({ utmSource: "s", utmMedium: "m", utmCampaign: "c", utmContent: "y".repeat(101) }), { refused: "invalid_content" });
  assert.deepEqual(campaignValues({ utmSource: "s", utmMedium: "m", utmCampaign: "c", investment: "-1" }), { refused: "invalid_investment" });
  assert.deepEqual(campaignValues({ utmSource: "s", utmMedium: "m", utmCampaign: "c", investment: "1.2345" }), { refused: "invalid_investment" });
});

test("CAMPAIGNS_PAGE staff get the day's campaigns and the not-available figures; nobody else reads anything", async () => {
  const x = rig();
  assert.deepEqual(await x.service.page("staff"), { day: "2026-11-23", clickDays: CAMPAIGN_CLICK_DAYS, campaigns: [REC], missing: CAMPAIGN_MISSING });
  assert.deepEqual(x.calls, [["list", "2026-11-23", CAMPAIGN_CLICK_DAYS]]);
  const y = rig();
  assert.equal(await y.service.page("alia"), undefined);
  assert.deepEqual(y.calls, []);
});

test("CAMPAIGNS_CREATE validates before writing, and only staff write", async () => {
  const x = rig();
  const input: CampaignInput = { utmSource: " news ", utmMedium: "email", utmCampaign: "launch" };
  assert.deepEqual(await x.service.create("staff", input), { id: "new" });
  assert.deepEqual(x.calls, [["create", { utmSource: "news", utmMedium: "email", utmCampaign: "launch", utmContent: null, utmTerm: null, investment: "0" }, "staff", x.now.toISOString()]]);
  const bad = rig();
  assert.deepEqual(await bad.service.create("staff", { utmSource: "", utmMedium: "m", utmCampaign: "c" }), { refused: "invalid_source" });
  assert.deepEqual(bad.calls, [], "nothing written when the values are refused");
  const notStaff = rig();
  assert.equal(await notStaff.service.create("alia", input), undefined);
  assert.deepEqual(notStaff.calls, []);
});

test("CAMPAIGNS_UPDATE and RETIRE pass the store's refusal straight through, and only staff may", async () => {
  const dup = rig({ async update() { return { refused: "duplicate" }; } });
  assert.deepEqual(await dup.service.update("staff", "c1", { utmSource: "s", utmMedium: "m", utmCampaign: "c" }), { refused: "duplicate" });
  const gone = rig({ async retire() { return { refused: "unknown" }; } });
  assert.deepEqual(await gone.service.retire("staff", "nope"), { refused: "unknown" });
  const notStaff = rig();
  assert.equal(await notStaff.service.update("alia", "c1", { utmSource: "s", utmMedium: "m", utmCampaign: "c" }), undefined);
  assert.equal(await notStaff.service.retire("alia", "c1"), undefined);
  assert.deepEqual(notStaff.calls, []);
});
