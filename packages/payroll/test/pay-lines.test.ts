import { test } from "node:test";
import assert from "node:assert/strict";
import { calculatePayLine, payLineTotals, type PayLineCalculationInput } from "../src/pay-lines.js";
const rate = { version: "studenthub.pay-rate-resolution.v1", steps: [], matchedContractIds: [], source: "contract", contractId: "contract", payModel: "hourly", candidateHourlyRate: "5.000", companyHourlyRate: "6.000" } as const;
const input: PayLineCalculationInput = { rate, hours: "2", minutes: 30, seconds: 0, bonus: "0", bonusCommissionPercent: "0", transferCost: "0", payouts: 1 };
test("F1 hourly exact minutes and company transfer cost", () => assert.deepEqual(calculatePayLine({...input,transferCost:"0.250"}),{kind:"calculated",candidateTotal:"12.500",companyTotal:"15.250",bonusCommission:"0.000"}));
test("F1 legacy contract minute-only empty differs from manual", () => {
 assert.equal(calculatePayLine({...input,hours:"0"}).kind,"empty");
 assert.deepEqual(calculatePayLine({...input,hours:"0",rate:{...rate,source:"manual",contractId:null},bonus:"10",bonusCommissionPercent:"10",transferCost:"1"}),{kind:"calculated",candidateTotal:"12.500",companyTotal:"13.000",bonusCommission:"0.000"});
});
test("F1 contract bonus commission is subtracted without intermediate rounding",()=>assert.deepEqual(calculatePayLine({...input,hours:"1",minutes:0,bonus:"10",bonusCommissionPercent:"10"}),{kind:"calculated",candidateTotal:"14.000",companyTotal:"16.000",bonusCommission:"1.000"}));
test("F1 positive exact half-fils rounds away from zero",()=>assert.equal((calculatePayLine({...input,hours:"0.001",minutes:0,rate:{...rate,candidateHourlyRate:"0.500"}}) as {candidateTotal:string}).candidateTotal,"0.001"));
test("F1 weekly monthly salary divides by four and ignores line bonus",()=>assert.equal((calculatePayLine({...input,rate:{...rate,payModel:"monthly_salary",candidateTotal:"400",companyTotal:"500",transferCost:"0"},payouts:4,bonus:"99"}) as {candidateTotal:string}).candidateTotal,"100.000"));
test("F1 monthly company override scales candidate proportionally",()=>assert.equal((calculatePayLine({...input,rate:{...rate,payModel:"monthly_salary",candidateTotal:"400",companyTotal:"500",transferCost:"0"},payouts:4,companyOverride:"50"}) as {candidateTotal:string}).candidateTotal,"40.000"));
test("F1 fixed amounts ignore completion quantity and bonus",()=>assert.equal((calculatePayLine({...input,rate:{...rate,payModel:"fixed_price",candidateTotal:"40",companyTotal:"50",transferCost:"0"},hours:"0",minutes:0,bonus:"99"}) as {candidateTotal:string}).candidateTotal,"40.000"));
test("F1 rejects fractional minutes, floats, malformed amounts, bad divisor and overflow",()=>{
 for(const patch of [{minutes:30.7},{hours:2 as unknown as string},{bonus:"1e3"},{payouts:0},{hours:"999999999",rate:{...rate,candidateHourlyRate:"999999999"}}]) assert.throws(()=>calculatePayLine({...input,...patch}));
});
test("F1 currency totals remain separated and exact",()=>{
 const line={id:"l",personId:"p",storeId:"s",currencyCode:"KWD",candidateTotal:"0.100",companyTotal:"0.200",note:"",calculation:{}};
 assert.deepEqual(payLineTotals([line,{...line,id:"2",candidateTotal:"0.200"},{...line,id:"3",currencyCode:"USD"}]),{KWD:{candidateTotal:"0.300",companyTotal:"0.400"},USD:{candidateTotal:"0.100",companyTotal:"0.200"}});
});
