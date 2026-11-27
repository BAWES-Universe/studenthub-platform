import assert from "node:assert/strict";
import test from "node:test";
import { CANDIDATE_STATISTICS_CALCULATION_VERSION, candidateStatistics, lineParts, type CandidatePayLine } from "../src/candidate-statistics.js";

const calc = (over: Partial<NonNullable<CandidatePayLine["calculation"]>> = {}): CandidatePayLine["calculation"] => ({ version: CANDIDATE_STATISTICS_CALCULATION_VERSION, hours: "1", minutes: 2, seconds: 3,
  bonus: "2.000", resultKind: "calculated", resultCandidateTotal: "10.000", bonusCommission: "0.250", ...over });
const line = (calculation: CandidatePayLine["calculation"], candidateTotal = "10.000", paidOut = true, currency = "KWD"): CandidatePayLine => ({ currency, candidateTotal, paidOut, calculation });

test("CANDIDATE_STATISTICS a generated line that still matches its total gives worked time and the bonus after commission", () => {
  assert.deepEqual(lineParts(line(calc())), { seconds: 3723n, bonus: 1750n });
  assert.deepEqual(lineParts(line(calc({ resultCandidateTotal: "10" }))), { seconds: 3723n, bonus: 1750n }, "the same amount written another way");
});

test("CANDIDATE_STATISTICS anything else gives no parts, so the whole total counts as paid", () => {
  for (const [why, c] of [
    ["no calculation", null], ["another version", calc({ version: "studenthub.payroll.v0" })], ["edited after generation", calc({ resultCandidateTotal: "9.000" })],
    ["empty result", calc({ resultKind: "empty" })], ["hours not a whole number", calc({ hours: "1.5" })], ["hours as a number", calc({ hours: 1 })],
    ["minutes out of range", calc({ minutes: 60 })], ["negative seconds", calc({ seconds: -1 })], ["fractional seconds", calc({ seconds: 1.5 })],
    ["bonus not a decimal", calc({ bonus: "1e3" })], ["commission missing", calc({ bonusCommission: undefined })],
    ["commission over the bonus", calc({ bonus: "1.000", bonusCommission: "1.001" })], ["bonus over the total", calc({ bonus: "20.000", bonusCommission: "0.000" })],
  ] as const) assert.equal(lineParts(line(c as CandidatePayLine["calculation"])), null, why);
});

test("CANDIDATE_STATISTICS money sums paid-out lines per currency in exact fils; hours sum every line read", () => {
  const s = candidateStatistics([
    line(calc()), line(calc({ hours: "2", minutes: 58, seconds: 57, bonus: "0", bonusCommission: "0.000", resultCandidateTotal: "0.001" }), "0.001"),
    line(null, "0.100"), line(calc({ hours: "10" }), "10.000", false), line(null, "5.000", true, "BHD"),
  ], 3);
  assert.deepEqual(s.worked, { hours: "14", minutes: 3, seconds: 3 }); // 1:02:03 + 2:58:57 + 10:02:03
  assert.deepEqual(s.money, [{ currency: "BHD", paid: "5.000", bonus: "0.000", earnings: "5.000" }, { currency: "KWD", paid: "8.351", bonus: "1.750", earnings: "10.101" }]);
  assert.equal(s.upcomingInterviews, 3);
  assert.deepEqual(candidateStatistics([], 0), { worked: { hours: "0", minutes: 0, seconds: 0 }, money: [], upcomingInterviews: 0 });
  assert.throws(() => candidateStatistics([line(null, "-1.000")], 0), RangeError);
});
