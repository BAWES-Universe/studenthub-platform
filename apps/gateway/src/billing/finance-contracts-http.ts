import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionStore } from "@studenthub/login-contract";
import { FINANCE_CONTRACT_STATUSES, type FinanceContractEntry, type FinanceContractPage, type FinanceContractStatus } from "@studenthub/db/billing";
import { longDate } from "../../../../packages/reports/src/id-card-pdf.js";
import { sessionCookie } from "../recruit/http-common.js";
import { pageDocument, wantsHtml, writeHtml } from "../web-ui.js";
import { FINANCE_SETTLED_PATH } from "./finance-settled-http.js";
import { FINANCE_TRANSFERS_PATH } from "./finance-transfers-http.js";

/**
 * Finance contracts (matrix A-17). Read only.
 *
 * GET /finance/contracts lists the pay contracts of every company StudentHub Finance settles, latest start first,
 * 100 a page (`?page=N`), optionally of one status (`?status=active|inactive`), each linking to its detail.
 * GET /finance/contracts/<id> shows one contract. Both show the company's side of a contract only (the projection
 * the pay contracts API gives a company's finance users): what the company is billed, never what the person is paid.
 * Changing a contract stays with the pay contracts API.
 *
 * Only StudentHub's own finance users reach these pages: the central gate and per-company settle rule of the bank
 * result files, Finance transfers and settled view. Everyone else, a company's own finance users included, gets not
 * found, and a contract outside the reader's companies reads exactly like a missing one.
 */
export const FINANCE_CONTRACTS_PATH = "/finance/contracts";
export interface FinanceContractReads {
  list(principalId: string, filter: { status?: FinanceContractStatus; page?: number }): Promise<FinanceContractPage | null>;
  contract(principalId: string, contractId: string): Promise<FinanceContractEntry | null>;
}
export interface FinanceContractsHttp {
  viewer(sessionId: string | undefined): Promise<string | undefined>;
  list(viewer: string, filter: { status?: FinanceContractStatus; page: number }): Promise<FinanceContractPage | null>;
  contract(viewer: string, contractId: string): Promise<FinanceContractEntry | null>;
}

export function createFinanceContractsHttp(ports: { sessions: Pick<SessionStore, "get">; reads: FinanceContractReads }): FinanceContractsHttp {
  return {
    async viewer(sessionId) { return sessionId ? (await ports.sessions.get(sessionId))?.personId : undefined; },
    list: (viewer, filter) => ports.reads.list(viewer, filter),
    contract: (viewer, id) => ports.reads.contract(viewer, id),
  };
}

/** `page` absent is 1 and `status` absent is every status; any other parameter, or a value outside these, is undefined. */
export function contractFilterOf(query: URLSearchParams): { status?: FinanceContractStatus; page: number } | undefined {
  const keys = [...query.keys()];
  if (new Set(keys).size !== keys.length || keys.some((k) => k !== "page" && k !== "status")) return undefined;
  const rawPage = query.get("page"), rawStatus = query.get("status");
  if (rawPage !== null && !/^[1-9][0-9]{0,5}$/.test(rawPage)) return undefined;
  if (rawStatus !== null && !FINANCE_CONTRACT_STATUSES.includes(rawStatus as FinanceContractStatus)) return undefined;
  return { page: rawPage === null ? 1 : Number(rawPage), ...(rawStatus === null ? {} : { status: rawStatus as FinanceContractStatus }) };
}

const DETAIL = /^\/finance\/contracts\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const STATUS_NAME: Readonly<Record<FinanceContractStatus, string>> = { active: "Active", inactive: "Inactive" };
const MODEL_NAME: Readonly<Record<string, string>> = { hourly: "Hourly", fixed_price: "Fixed price", monthly_salary: "Monthly salary" };
const esc = (v: string) => v.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const text = (v: unknown) => typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
const detailHref = (id: string) => `${FINANCE_CONTRACTS_PATH}/${encodeURIComponent(id)}`;
const listHref = (filter: { status?: FinanceContractStatus; page: number }) => {
  const q = new URLSearchParams();
  if (filter.status) q.set("status", filter.status);
  if (filter.page > 1) q.set("page", String(filter.page));
  const s = q.toString();
  return s ? `${FINANCE_CONTRACTS_PATH}?${s}` : FINANCE_CONTRACTS_PATH;
};
const terms = (e: FinanceContractEntry) => (e.contract.terms ?? {}) as Readonly<Record<string, unknown>>;
const statusName = (e: FinanceContractEntry) => STATUS_NAME[e.contract.status as FinanceContractStatus] ?? text(e.contract.status);
const period = (e: FinanceContractEntry) => typeof e.contract.endDate === "string"
  ? `${longDate(text(e.contract.startDate))} to ${longDate(e.contract.endDate)}` : `From ${longDate(text(e.contract.startDate))}`;
/** What the company is billed under the contract, from the company projection's terms only. */
function billed(e: FinanceContractEntry): string {
  const t = terms(e), money = (v: unknown) => `${e.currencyCode} ${text(v)}`.trim();
  if (t.payModel === "hourly") return `${money(t.companyHourlyRate)} an hour`;
  if (t.payModel === "fixed_price") return `${money(t.companyTotal)} in total, ${text(t.completionPercentage)}% complete`;
  return `${money(t.companyTotal)} a month, on day ${text(t.salaryDay)}`;
}

function listHtml(result: FinanceContractPage, status: FinanceContractStatus | undefined): string {
  const filters = [`<a href="${FINANCE_CONTRACTS_PATH}"${status ? "" : ' aria-current="page"'}>All</a>`,
    ...FINANCE_CONTRACT_STATUSES.map((s) => `<a href="${esc(listHref({ status: s, page: 1 }))}"${status === s ? ' aria-current="page"' : ""}>${STATUS_NAME[s]}</a>`)].join(" · ");
  const rows = result.contracts.map((e) => `<tr><td><a href="${esc(detailHref(text(e.contract.id)))}">${esc(e.personName)}</a></td><td>${esc(e.companyName)}</td>`
    + `<td>${esc(e.storeName)}</td><td>${esc(MODEL_NAME[text(terms(e).payModel)] ?? text(terms(e).payModel))}</td><td>${esc(billed(e))}</td>`
    + `<td>${esc(period(e))}</td><td>${esc(statusName(e))}</td></tr>`).join("");
  const nav = [result.page > 1 ? `<a href="${esc(listHref({ ...(status ? { status } : {}), page: result.page - 1 }))}">Newer</a>` : "",
    result.more ? `<a href="${esc(listHref({ ...(status ? { status } : {}), page: result.page + 1 }))}">Older</a>` : ""].filter(Boolean).join(" ");
  return `<main><h1>Contracts</h1><p>Pay contracts of every company, latest start first. Amounts are what the company is billed.</p><p>${filters}</p>${result.contracts.length
    ? `<table><thead><tr><th>Person</th><th>Company</th><th>Store</th><th>Pay</th><th>Billed</th><th>Period</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`
    : "<p>No contracts here.</p>"}${nav ? `<p>${nav}</p>` : ""}`
    + `<p><a href="${FINANCE_TRANSFERS_PATH}">Transfers</a> · <a href="${FINANCE_SETTLED_PATH}">Settled</a></p></main>`;
}

function detailHtml(e: FinanceContractEntry): string {
  const t = terms(e);
  const rows: [string, string][] = [["Person", e.personName], ["Company", e.companyName], ["Store", e.storeName],
    ["Pay", MODEL_NAME[text(t.payModel)] ?? text(t.payModel)], ["Billed to the company", billed(e)], ["Period", period(e)], ["Status", statusName(e)]];
  if (t.payModel === "monthly_salary") rows.push(["Monthly payout generated automatically", e.contract.autoGenerate === true ? "Yes" : "No"]);
  return `<main><h1>Contract</h1><table><tbody>${rows.map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</tbody></table>`
    + `<p><a href="${FINANCE_CONTRACTS_PATH}">All contracts</a></p></main>`;
}

function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", vary: "Accept", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
  res.end(JSON.stringify(body)); return true;
}
function reply(req: IncomingMessage, res: ServerResponse, status: number, error: string, title: string, message: string): true {
  if (wantsHtml(req.headers.accept)) { writeHtml(res, status, pageDocument(title, `<main><h1>${esc(title)}</h1><p>${esc(message)}</p></main>`), { "cache-control": "no-store" }); return true; }
  return json(res, status, { error });
}
const notFound = (req: IncomingMessage, res: ServerResponse) => reply(req, res, 404, "not_found", "Not found", "This page does not exist.");

export async function handleFinanceContracts(req: IncomingMessage, res: ServerResponse, service: FinanceContractsHttp | undefined): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://gateway.invalid"), path = url.pathname;
  const list = path === FINANCE_CONTRACTS_PATH, detail = list ? null : DETAIL.exec(path);
  if (!list && !path.startsWith(`${FINANCE_CONTRACTS_PATH}/`)) return false;
  req.resume();
  try {
    if (!service) return reply(req, res, 503, "contracts_unavailable", "Contracts unavailable", "Contracts are not available right now.");
    if (!list && !detail) return notFound(req, res);
    if (req.method !== "GET") { res.writeHead(405, { allow: "GET" }); res.end(); return true; }
    const viewer = await service.viewer(sessionCookie(req.headers.cookie));
    if (!viewer) return reply(req, res, 401, "unauthorized", "Sign in", "Sign in to see contracts.");
    if (list) {
      const filter = contractFilterOf(url.searchParams);
      if (!filter) return notFound(req, res);
      const result = await service.list(viewer, filter);
      if (!result) return notFound(req, res);
      if (!wantsHtml(req.headers.accept)) return json(res, 200, result);
      writeHtml(res, 200, pageDocument("Contracts", listHtml(result, filter.status)), { "cache-control": "no-store" }); return true;
    }
    if ([...url.searchParams.keys()].length) return notFound(req, res);
    const result = await service.contract(viewer, detail![1]!);
    if (!result) return notFound(req, res);
    if (!wantsHtml(req.headers.accept)) return json(res, 200, result);
    writeHtml(res, 200, pageDocument("Contract", detailHtml(result)), { "cache-control": "no-store" }); return true;
  } catch {
    if (!res.headersSent) return reply(req, res, 503, "contracts_unavailable", "Contracts unavailable", "Contracts are not available right now.");
    res.destroy(); return true;
  }
}
