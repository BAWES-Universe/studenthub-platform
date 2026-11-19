/** Pure ABK advice TXT formatter. Source: legacy 55119d36, TransferController:1838–1963.
 * No DB, clock, payment action, filesystem or transport. Caller selects approved lines.
 */
export interface AbkAdviceLine {
  readonly tcId: string;
  readonly beneficiaryName: string;
  readonly beneficiaryIban: string;
  readonly bankIbanCode: string;
  readonly bankSwiftCode: string;
  readonly currency: string;
  /** Finalized totalPaidToCandidate, not XLSX candidate_total. Fixed 3dp. */
  readonly paidAmount: string;
}
export interface AbkAdviceContract {
  readonly batchId: string;
  /** Explicit m/d/Y calendar date, e.g. 11/19/2026. Never read wall clock. */
  readonly date: string;
  readonly currency: string;
  readonly debitAccount: string;
  readonly originCode: string;
  /** PHP_EOL is OS-dependent in legacy. Specify rather than guessing CRLF. */
  readonly newline: "\n" | "\r\n";
}

function field(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 32767 || /[,;\u0000-\u001f\u007f]/u.test(value) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) {
    throw new Error(`Invalid delimiter-safe ${label}`);
  }
  return value;
}
function fils(value: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,11})\.\d{3}$/u.test(value)) throw new Error("Require nonnegative finalized amount with exactly 3 decimals");
  return BigInt(value.replace(".", ""));
}
function decimal(value: bigint): string { return `${value / 1000n}.${(value % 1000n).toString().padStart(3,"0")}`; }

/** UTF-8, no BOM, no padding, semicolon terminators and one trailing newline per row. */
export function generateAbkAdviceText(lines: readonly AbkAdviceLine[], contract: AbkAdviceContract): Uint8Array {
  if (contract.newline !== "\n" && contract.newline !== "\r\n") throw new Error("Explicit LF or CRLF required");
  if (!/^T[1-9]\d*V1$/u.test(contract.batchId)) throw new Error("Invalid batch ID");
  const date = /^(\d{2})\/(\d{2})\/(\d{4})$/u.exec(contract.date);
  if (!date) throw new Error("Date must be mm/dd/yyyy");
  const month=Number(date[1]), day=Number(date[2]), year=Number(date[3]);
  const days=[31,year%4===0&&(year%100!==0||year%400===0)?29:28,31,30,31,30,31,31,30,31,30,31];
  if(year<1900||month<1||month>12||day<1||day>days[month-1]!) throw new Error("Invalid calendar date");
  const debit=field(contract.debitAccount,"debit account"), origin=field(contract.originCode,"origin code"), currency=field(contract.currency,"currency");
  if(lines.length>10000) throw new Error("Candidate supports at most 10000 lines");
  const seen=new Set<string>();let total=0n;const detail:string[]=[];
  for(const line of lines){
    const id=field(line.tcId,"tcId");if(seen.has(id)) throw new Error("Duplicate tcId");seen.add(id);
    const name=field(line.beneficiaryName,"beneficiary name"), iban=field(line.beneficiaryIban,"IBAN");
    const bank=field(line.bankIbanCode,"bank code"), swift=field(line.bankSwiftCode,"SWIFT");
    if(field(line.currency,"currency")!==currency) throw new Error("Mixed currency batch");
    const value=fils(line.paidAmount);total+=value;
    const within=bank==="ABKK";
    const account=within?iban.slice(8).replaceAll("000000000",""):iban;
    field(account,"extracted account");
    detail.push(["APO",debit,origin,name,account,"KW",bank,"KW","KW","KW","KW","KW",currency,decimal(value),within?"WIB":"KASIP",swift+"XXX","OBS","S "+id].join(",")+",O,,,,,,,;"+contract.newline);
  }
  return new TextEncoder().encode(`FHR,${contract.batchId},${contract.date},${lines.length},${decimal(total)};${contract.newline}`+detail.join(""));
}
