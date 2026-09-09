#!/usr/bin/env node
/**
 * Regenerates docs/parity/coverage.md from the production Yii2 source.
 *
 * Usage:  node tools/parity/generate-coverage-ledger.mjs <path-to-studenthub-checkout> [output-path]
 *
 * Counting rules, chosen so the totals can be reproduced exactly:
 *
 *  - A *functional action* is a method whose name matches /^action[A-Za-z0-9_]+$/
 *    and is NOT the Yii framework hook `actions()`. `actions()` declares
 *    framework-configured actions (in this codebase, CORS `OptionsAction`);
 *    it is not a feature endpoint, so it is counted and reported separately.
 *  - The declaration regex tolerates arbitrary whitespace between `public`,
 *    `function` and the method name. Production contains at least one
 *    declaration written `public  function actionAppealList()`.
 *  - Base classes contribute no endpoints and are reported as cluster X.
 *  - Comments and string literals are masked before matching, so a method
 *    declared inside a block comment (production has one: the commented-out
 *    `actionTest()` in console/controllers/CronController.php) is not counted.
 *
 * Cluster assignment is data, not inference: CONTROLLER_CLUSTER gives each
 * controller a default cluster, ACTION_CLUSTER overrides individual actions
 * by "app/Controller::ActionName", and ACTION_EFFECTS records secondary
 * clusters an action writes into (one scheduled job can span three). Every
 * action is assigned exactly once.
 *
 * The script fails closed on: an unassigned action; a cluster code that is not
 * in CLUSTERS; a CONTROLLER_CLUSTER or ACTION_CLUSTER entry that names a
 * controller or action the source does not contain (stale mapping); a missing
 * app directory; a checkout whose HEAD is not SOURCE_REVISION. A source tree
 * that yields zero controllers is therefore impossible to ledger silently.
 *
 * Besides coverage.md it writes coverage-actions.json: one record per action
 * with app, controller, action, primary cluster, effects and source line, so a
 * journey or slice can be traced back to the exact declaration.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.argv[2];
const OUT = process.argv[3] ?? join(dirname(new URL(import.meta.url).pathname), "../../docs/parity/coverage.md");
if (!ROOT) { console.error("usage: generate-coverage-ledger.mjs <studenthub-checkout> [out]"); process.exit(2); }

const ACTION_RE = /public\s+function\s+(action[A-Za-z0-9_]*)\s*\(/g;

/** The production revision this ledger describes. Regenerating against any other checkout is refused. */
const SOURCE_REVISION = "c2ce255695eabc7e3a0f23b162f5996274234c63";
const JSON_OUT = join(dirname(OUT), "coverage-actions.json");

/**
 * Replace PHP comments and string literals with spaces of equal length so that
 * offsets (and therefore line numbers) are preserved but nothing inside them
 * can match ACTION_RE. Handles // and # line comments, block comments, and
 * single/double-quoted strings with backslash escapes. Heredocs are not
 * handled; none of the controllers use one around a method declaration.
 */
function maskCommentsAndStrings(src) {
  const out = src.split("");
  const blank = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " "; };
  let i = 0;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop); i = stop; continue;
    }
    if ((c === "/" && n === "/") || c === "#") {
      let end = src.indexOf("\n", i);
      if (end === -1) end = src.length;
      blank(i, end); i = end; continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) { if (src[j] === "\\") j++; j++; }
      blank(i + 1, Math.min(j, src.length)); i = j + 1; continue;
    }
    i++;
  }
  return out.join("");
}

const CLUSTERS = {
  ID: "Identity and access (SHU-124)",
  PD: "Profile and private documents (SHU-123)",
  OR: "Organizations, stores, contacts, reference data (SHU-125)",
  RC: "Discover work, apply, recruit (SHU-127)",
  WK: "Work, scheduling, attendance, approvals (SHU-126)",
  FI: "Finance, contracts, payroll (SHU-128)",
  CM: "Communication, support, marketing, clients (SHU-129)",
  RP: "Reporting and dashboards (SHU-137)",
  OPS: "Platform config, ops, integration plumbing (SHU-139)",
  X: "Base class, contributes no endpoint",
};

const APPS = ["admin", "candidate", "company", "staff", "manager", "inspector", "status", "verification", "console"];
const appDir = (app) => (app === "verification" || app === "console") ? `${app}/controllers` : `${app}/modules/v1/controllers`;

/** Default cluster per "app/Controller". */
const CONTROLLER_CLUSTER = {
  "admin/Admin": "ID", "admin/Auth": "ID", "admin/Aws": "OPS", "admin/Balance": "FI", "admin/Bank": "OR",
  "admin/BlockedIp": "ID", "admin/Brand": "OR", "admin/Campaign": "CM", "admin/Candidate": "PD",
  "admin/CandidateEvaluation": "RC", "admin/CandidateWorkHistory": "WK", "admin/CandidateWorkingHour": "WK",
  "admin/CompanyContact": "OR", "admin/Company": "OR", "admin/Country": "OR", "admin/CronLog": "OPS",
  "admin/Currency": "OR", "admin/DailyStandupAnswer": "WK", "admin/DailyStandupQuestion": "WK",
  "admin/Degree": "OR", "admin/DegreeGroup": "OR", "admin/DiscountCategory": "CM", "admin/Discount": "CM",
  "admin/EmailCampaign": "CM", "admin/Event": "OPS", "admin/Expense": "FI", "admin/Fulltimer": "RC",
  "admin/Inspector": "ID", "admin/Invitation": "RC", "admin/MailLog": "CM", "admin/Major": "OR",
  "admin/Note": "CM", "admin/PermissionSection": "ID", "admin/Ping": "OPS", "admin/RequestChecklist": "RC",
  "admin/Request": "RC", "admin/Setting": "OPS", "admin/Staff": "ID", "admin/StaffExpenses": "FI",
  "admin/StaffLeave": "WK", "admin/StaffSalary": "FI", "admin/StaffWorkSession": "WK", "admin/Statistic": "RP",
  "admin/Store": "OR", "admin/Story": "CM", "admin/Suggestion": "RC", "admin/Tag": "OR",
  "admin/TransferBankAdvice": "FI", "admin/TransferCandidate": "FI", "admin/Transfer": "FI",
  "admin/TransferFile": "FI", "admin/University": "OR", "admin/Webhook": "CM", "admin/Xero": "FI",
  "admin/XeroWebhook": "FI", "admin/Yeaster": "CM",

  "candidate/Account": "PD", "candidate/Auth": "ID", "candidate/Aws": "OPS", "candidate/Balance": "FI",
  "candidate/Campaign": "CM", "candidate/Candidate": "WK", "candidate/CandidateEducation": "PD",
  "candidate/CandidateExperience": "PD", "candidate/CandidateLink": "PD", "candidate/CandidateNotification": "CM",
  "candidate/CandidateWorkingHour": "WK", "candidate/Chat": "CM", "candidate/Country": "OR",
  "candidate/DiscountCategory": "CM", "candidate/Discount": "CM", "candidate/GoogleMap": "OPS",
  "candidate/Invitation": "RC", "candidate/Job": "RC", "candidate/Ping": "OPS", "candidate/Request": "RC",
  "candidate/Statistic": "RP", "candidate/Ticket": "CM", "candidate/University": "OR",

  "company/Account": "ID", "company/Algolia": "RC", "company/Auth": "ID", "company/Aws": "OPS",
  "company/Balance": "FI", "company/Base": "X", "company/Campaign": "CM", "company/Candidate": "RC",
  "company/CandidateWorkLogFeedback": "WK", "company/CandidateWorkingHour": "WK", "company/Chat": "CM",
  "company/CompanyContact": "OR", "company/Company": "OR", "company/Contract": "FI", "company/Country": "OR",
  "company/Currency": "OR", "company/Invitation": "RC", "company/Note": "CM", "company/Ping": "OPS",
  "company/RequestActivity": "RC", "company/RequestCandidateInvitation": "RC", "company/Request": "RC",
  "company/Store": "OR", "company/Suggestion": "RC", "company/Transfer": "FI",

  "staff/Account": "ID", "staff/Algolia": "RC", "staff/Auth": "ID", "staff/Aws": "OPS", "staff/Bank": "OR",
  "staff/Base": "X", "staff/Brand": "OR", "staff/Candidate": "PD", "staff/CandidateEvaluation": "RC",
  "staff/CandidateIdCard": "PD", "staff/CandidateIdRequest": "PD", "staff/CandidateWorkingHour": "WK",
  "staff/Certificate": "PD", "staff/Chat": "CM", "staff/CompanyContact": "OR", "staff/Company": "OR",
  "staff/CompanyRequest": "OR", "staff/Contract": "FI", "staff/Country": "OR", "staff/CronLog": "OPS",
  "staff/Currency": "OR", "staff/DailyStandup": "WK", "staff/DiscountCategory": "CM", "staff/Discount": "CM",
  "staff/EmailCampaign": "CM", "staff/FiringHitmap": "WK", "staff/Fulltimer": "RC", "staff/GoogleMap": "OPS",
  "staff/InterviewEvaluation": "RC", "staff/Invitation": "RC", "staff/Jira": "CM", "staff/Job": "RC",
  "staff/Mall": "OR", "staff/Note": "CM", "staff/PermissionSection": "ID", "staff/Ping": "OPS",
  "staff/RequestActivity": "RC", "staff/Request": "RC", "staff/Staff": "ID", "staff/StaffExpenses": "FI",
  "staff/StaffLeave": "WK", "staff/Statistic": "RP", "staff/StoreAssignmentRequest": "WK", "staff/Store": "OR",
  "staff/Story": "CM", "staff/Suggestion": "RC", "staff/Tag": "OR", "staff/Ticket": "CM",
  "staff/Transfer": "FI", "staff/University": "OR", "staff/Webhook": "CM", "staff/Yeaster": "CM",

  "manager/Account": "ID", "manager/Auth": "ID", "manager/Aws": "OPS", "manager/Base": "X",
  "manager/Candidate": "PD", "manager/CandidateWorkingHour": "WK", "manager/CompanyContact": "OR",
  "manager/Company": "OR", "manager/Ping": "OPS", "manager/Store": "OR",

  "inspector/Account": "ID", "inspector/Auth": "ID", "inspector/Aws": "OPS", "inspector/Ping": "OPS",

  "status/Account": "ID", "status/Aws": "OPS", "status/Bank": "RP", "status/Candidate": "RP",
  "status/CandidateWorkHistory": "RP", "status/Company": "RP", "status/Country": "RP", "status/Expense": "RP",
  "status/Note": "RP", "status/Request": "RP", "status/Staff": "RP", "status/Statistic": "RP",
  "status/Story": "RP", "status/TransferCandidate": "RP", "status/Transfer": "RP", "status/University": "RP",

  "verification/Site": "PD", "verification/View": "PD",

  "console/Algolia": "RC", "console/CentralDb": "ID", "console/Cron": "OPS", "console/Event": "OPS",
  "console/Report": "RP", "console/Resource": "PD", "console/Xero": "FI",
};

/** Per-action overrides, "app/Controller::ActionName". */
const ACTION_CLUSTER = {
  // candidate/Account is mostly profile; these belong elsewhere.
  "candidate/Account::actionChangePassword": "ID",
  "candidate/Account::actionToggleTwoStepAuth": "ID",
  "candidate/Account::actionDiscardSession": "ID",
  "candidate/Account::actionValidateUserPassword": "ID",
  "candidate/Account::actionUpdateEmail": "ID",
  "candidate/Account::actionLanguagePref": "ID",
  "candidate/Account::actionSalary": "FI",
  "candidate/Account::actionSalaryDetail": "FI",
  "candidate/Account::actionUpdateBankDetail": "FI",
  "candidate/Account::actionStartWorkingTime": "WK",
  "candidate/Account::actionStopWorkingTime": "WK",
  "candidate/Account::actionWorkingStatus": "WK",
  "candidate/Account::actionGetJobSearchStatus": "RC",
  "candidate/Account::actionJobSearchStatus": "RC",
  "candidate/Account::actionVideo": "PD",
  "candidate/Account::actionVideoStatus": "PD",
  "candidate/Account::actionVideoByWebhook": "PD",

  // candidate/Candidate is work history; the appreciation certificate is a profile document (PD S8).
  "candidate/Candidate::actionAppreciationCertificate": "PD",

  // Story status transitions are recruiter pipeline state (RC R2), not messaging.
  "staff/Story::actionChangeStoryStatus": "RC",
  "admin/Story::actionChangeStoryStatus": "RC",

  // company/Store: assignment requests are the work cluster's journey (WK W1).
  "company/Store::actionStoreAssignmentRequest": "WK",
  "company/Store::actionCancelStoreAssignmentRequest": "WK",

  // staff/Candidate spans profile administration, work, recruiting and finance.
  "staff/Candidate::actionAssign": "WK",
  "staff/Candidate::actionUnassign": "WK",
  "staff/Candidate::actionListAssigned": "WK",
  "staff/Candidate::actionListNotAssigned": "RC",
  "staff/Candidate::actionAssignedHistoryList": "WK",
  "staff/Candidate::actionAssignedIdleCandidates": "WK",
  "staff/Candidate::actionToggleCommitted": "WK",
  "staff/Candidate::actionWorkHistory": "WK",
  "staff/Candidate::actionExportAssignedHistory": "WK",
  "staff/Candidate::actionApplications": "RC",
  "staff/Candidate::actionSearch": "RC",
  "staff/Candidate::actionFilter": "RC",
  "staff/Candidate::actionJobSearchStatus": "RC",
  "staff/Candidate::actionUpdateCandidateHourRate": "FI",
  "staff/Candidate::actionCompanyTransferCost": "FI",
  "staff/Candidate::actionTransfers": "FI",
  "staff/Candidate::actionListWithoutBankInfo": "FI",
  "staff/Candidate::actionResetPassword": "ID",
  "staff/Candidate::actionLogin": "ID",
  "staff/Candidate::actionWarnCandidate": "WK",
  "staff/Candidate::actionUpdateWarning": "WK",
  "staff/Candidate::actionCandidateWarnings": "WK",

  // company/Candidate: employer view of a person is profile; work logs are work.
  "company/Candidate::actionView": "PD",
  "company/Candidate::actionWorkingDates": "WK",
  "company/Candidate::actionWorkLogDetailedExcel": "WK",
  "company/Candidate::actionWorkLogExcel": "WK",
  "company/Candidate::actionWorkLogStats": "WK",
  "company/Candidate::actionWorkHistory": "WK",
  "company/Candidate::actionWorkHistoryDetail": "WK",

  "manager/Candidate::actionWorkHistory": "WK",
  "manager/Candidate::actionTotal": "WK",

  // admin/Staff: salary administration is finance, the rest is identity.
  "admin/Staff::actionListSalaries": "FI",
  "admin/Staff::actionListCompanies": "OR", // returns the staff member's company relationships, despite the salary docblock
  "admin/Staff::actionImportSalary": "FI",

  // console/Cron: one scheduled action per cluster.
  "console/Cron::actionFillCivilIdExpiryDate": "PD",
  "console/Cron::actionFillCivilIdExpiryDateNotAssigned": "PD",
  "console/Cron::actionValidateCivilId": "PD",
  "console/Cron::actionRemoveDuplicate": "PD",
  "console/Cron::actionKuwaitMomCheck": "PD",
  "console/Cron::actionFixEducation": "PD",
  "console/Cron::actionCheckIfCandidateTotalMismatch": "OR",
  "console/Cron::actionGenHitMap": "WK",
  "console/Cron::actionCheckDailyAttendance": "WK",
  "console/Cron::actionFixWorkLogs": "WK",
  "console/Cron::actionFixWorkLogDates": "WK",
  "console/Cron::actionEndOfMonth": "WK",
  "console/Cron::actionEveryMinute": "RC",
  "console/Cron::actionProcessTransferFiles": "FI",
  "console/Cron::actionDaily": "FI",
  "console/Cron::actionWeekly": "FI",
  "console/Cron::actionPayableCandidateNotification": "FI",
  "console/Cron::actionProcessCampaign": "CM",
  "console/Cron::actionMidMonth": "CM",
  "console/Cron::actionSummary": "RP",
  "console/Cron::actionUpdateCandidateStats": "RP",
  "console/Cron::actionUpdateCompanyStats": "RP",
};

/**
 * Secondary clusters an action writes into. Primary ownership above answers
 * "who specifies this endpoint"; effects answer "who else must test it".
 */
const ACTION_EFFECTS = {
  // sends paid-transfer email + push and marks is_candidate_notified (FI, CM), then purges six token tables (ID)
  "console/Cron::actionDaily": ["CM", "ID"],
  // token purge and mail-log rotation alongside the reporting counters
  "console/Cron::actionSummary": ["CM"],
  // marks candidate/company notification state after suggestions
  "console/Cron::actionEveryMinute": ["CM"],
};

const NOTES = {
  "admin/Aws": "upload-credential endpoint, same shape as SHU-134",
  "candidate/Aws": "SHU-134",
  "company/Aws": "SHU-134 shape", "staff/Aws": "SHU-134 shape",
  "manager/Aws": "SHU-134 shape", "inspector/Aws": "SHU-134 shape", "status/Aws": "SHU-134 shape",
  "admin/Company": "includes sub-companies via parent_company_id",
  "admin/Xero": "owner disposition DEFER",
  "admin/XeroWebhook": "not routed in config; verify dead",
  "staff/Discount": "not routed in config; verify dead",
  "staff/DiscountCategory": "not routed in config; verify dead",
  "manager/CompanyContact": "not routed in config; verify dead",
  "status/Account": "not routed in config; verify dead",
  "console/CentralDb": "exports users with password hashes to a second database",
  "verification/Site": "public QR card", "verification/View": "public resume/video/phone redirects",
  "admin/Fulltimer": "full-time placement product; liveness is a decision",
  "staff/Jira": "support tooling", "admin/Yeaster": "telephony/PBX", "staff/Yeaster": "telephony/PBX",
};

const problems = [];

// Refuse any checkout that is not the revision this ledger describes.
let actualRevision = null;
try {
  actualRevision = execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
} catch (error) {
  problems.push(`cannot read HEAD of ${ROOT}: ${error?.message ?? error}`);
}
if (actualRevision && actualRevision !== SOURCE_REVISION) {
  problems.push(`source checkout is at ${actualRevision}, ledger describes ${SOURCE_REVISION}`);
}

// Every cluster code used by the mapping must exist.
for (const [k, v] of Object.entries(CONTROLLER_CLUSTER)) if (!CLUSTERS[v]) problems.push(`unknown cluster "${v}" for controller ${k}`);
for (const [k, v] of Object.entries(ACTION_CLUSTER)) if (!CLUSTERS[v]) problems.push(`unknown cluster "${v}" for action ${k}`);
for (const [k, vs] of Object.entries(ACTION_EFFECTS)) for (const v of vs) if (!CLUSTERS[v]) problems.push(`unknown effect cluster "${v}" for action ${k}`);

const rows = [];
const records = [];
let optionsHooks = 0;
const unassigned = [];
const seenControllers = new Set();
const seenActions = new Set();

for (const app of APPS) {
  const dir = join(ROOT, appDir(app));
  if (!existsSync(dir)) { problems.push(`app directory missing: ${appDir(app)}`); continue; }
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith("Controller.php")) continue;
    const name = file.slice(0, -"Controller.php".length);
    const key = `${app}/${name}`;
    seenControllers.add(key);
    const path = join(dir, file);
    const src = maskCommentsAndStrings(readFileSync(path, "utf8"));
    const matches = [...src.matchAll(ACTION_RE)];
    const hooks = matches.filter((m) => m[1] === "actions").length;
    optionsHooks += hooks;
    const actions = matches.filter((m) => m[1] !== "actions");
    const byCluster = {};
    for (const m of actions) {
      const a = m[1];
      const id = `${key}::${a}`;
      seenActions.add(id);
      const cluster = ACTION_CLUSTER[id] ?? CONTROLLER_CLUSTER[key];
      if (!cluster) { unassigned.push(id); continue; }
      byCluster[cluster] = (byCluster[cluster] ?? 0) + 1;
      const line = src.slice(0, m.index).split("\n").length;
      records.push({ app, controller: name, action: a, cluster, effects: ACTION_EFFECTS[id] ?? [], source: `${relative(ROOT, path)}:${line}` });
    }
    if (actions.length === 0 && CONTROLLER_CLUSTER[key] === "X") byCluster.X = 0;
    rows.push({ app, name, key, actions: actions.length, hooks, byCluster, note: NOTES[key] ?? "" });
  }
}

if (rows.length === 0) problems.push("no controllers found under the source checkout");
for (const k of Object.keys(CONTROLLER_CLUSTER)) if (!seenControllers.has(k)) problems.push(`stale CONTROLLER_CLUSTER entry, no such controller: ${k}`);
for (const k of Object.keys(ACTION_CLUSTER)) if (!seenActions.has(k)) problems.push(`stale ACTION_CLUSTER entry, no such action: ${k}`);
for (const k of Object.keys(ACTION_EFFECTS)) if (!seenActions.has(k)) problems.push(`stale ACTION_EFFECTS entry, no such action: ${k}`);
if (unassigned.length) problems.push(`unassigned actions (${unassigned.length}):\n` + unassigned.join("\n"));

if (problems.length) {
  console.error("coverage ledger refused:\n- " + problems.join("\n- "));
  process.exit(1);
}

const totals = {};
let grand = 0;
for (const r of rows) for (const [c, n] of Object.entries(r.byCluster)) { totals[c] = (totals[c] ?? 0) + n; grand += n; }
const perApp = {};
for (const r of rows) {
  perApp[r.app] ??= { controllers: 0, actions: 0, hooks: 0 };
  perApp[r.app].controllers++; perApp[r.app].actions += r.actions; perApp[r.app].hooks += r.hooks;
}
const fmt = (m) => Object.entries(m).map(([c, n]) => (Object.keys(m).length > 1 ? `${c} ${n}` : c)).join(", ") || "—";

const L = [];
L.push("# Production coverage ledger: every controller action assigned to a cluster\n");
L.push(`**Card:** SHU-88 (acceptance items 2 and 4). **Production source:** \`BAWES-Universe/studenthub\` at \`${actualRevision}\` (verified by the generator against the checkout it read).\n`);
L.push("**Generated** by `tools/parity/generate-coverage-ledger.mjs`. Regenerate rather than hand-edit:\n");
L.push("```\nnode tools/parity/generate-coverage-ledger.mjs <path-to-studenthub-checkout>\n```\n");
L.push("## Counting rules\n");
L.push("A **functional action** is a method matching `/^action[A-Za-z0-9_]+$/` that is not the Yii framework hook `actions()`. In this codebase `actions()` configures CORS `OptionsAction`, so it is an OPTIONS/plumbing declaration rather than a feature endpoint; it is counted separately below. The declaration regex tolerates arbitrary whitespace between `public`, `function` and the name, because production contains at least one method written `public  function actionAppealList()` (`staff/modules/v1/controllers/CandidateWorkingHourController.php:279`).\n");
L.push(`**Functional actions: ${grand}.** **\`actions()\` hooks (OPTIONS/CORS configuration), reported separately: ${optionsHooks}.** Controllers: ${rows.length}.\n`);
L.push("Comments and string literals are masked before matching, so a declaration inside a block comment is not counted (production has one: the commented-out `actionTest()` at `console/controllers/CronController.php:952`).\n");
L.push("Cluster assignment is data, not inference. `CONTROLLER_CLUSTER` in the generator gives each controller a default; `ACTION_CLUSTER` overrides named actions for controllers that span clusters; `ACTION_EFFECTS` records the secondary clusters an action writes into. The generator exits non-zero on an unassigned action, an unknown cluster code, a mapping entry that names a controller or action the source does not contain, a missing app directory, or a checkout at any revision other than the one named above. The per-action assignment is also written to `coverage-actions.json` with the source line of every declaration.\n");
L.push("## Totals by cluster\n");
L.push("| Code | Cluster | Actions | Share |\n|---|---|---:|---:|");
for (const c of ["ID", "PD", "OR", "RC", "WK", "FI", "CM", "RP", "OPS"]) {
  if (totals[c]) L.push(`| ${c} | ${CLUSTERS[c]} | ${totals[c]} | ${(totals[c] * 100 / grand).toFixed(0)}% |`);
}
L.push(`| | **Total functional actions** | **${grand}** | 100% |\n`);
const sevenClusters = ["ID", "PD", "OR", "RC", "WK", "FI", "CM"].reduce((s, c) => s + (totals[c] ?? 0), 0);
L.push(`The seven inventory clusters cover **${sevenClusters}** of ${grand} functional actions (${(sevenClusters * 100 / grand).toFixed(0)}%). The remaining ${grand - sevenClusters} needed two buckets no roadmap card owned when this ledger was first written: reporting and dashboards (${totals.RP}, now SHU-137) and platform config, ops and integration plumbing (${totals.OPS}, now SHU-139).\n`);
L.push("## Totals by app\n");
L.push("| App | Controllers | Functional actions | `actions()` hooks |\n|---|---:|---:|---:|");
for (const app of APPS) if (perApp[app]) L.push(`| ${app} | ${perApp[app].controllers} | ${perApp[app].actions} | ${perApp[app].hooks} |`);
L.push(`| **All** | **${rows.length}** | **${grand}** | **${optionsHooks}** |\n`);
L.push("## Assignment, controller by controller\n");
L.push("Codes: ID identity, PD profile/documents, OR organizations, RC recruit, WK work, FI finance, CM communication, RP reporting, OPS platform, X base class.\n");
let cur = null;
for (const r of rows) {
  if (r.app !== cur) { cur = r.app; L.push(`\n### ${r.app}\n\n| Controller | Functional actions | \`actions()\` | Cluster | Note |\n|---|---:|---:|---|---|`); }
  L.push(`| ${r.name} | ${r.actions} | ${r.hooks} | ${fmt(r.byCluster)} | ${r.note} |`);
}
L.push("\n## Cross-cluster effects\n");
L.push("Primary ownership says who specifies an endpoint; these actions also write into other clusters, which must test them too.\n");
L.push("| Action | Primary | Also affects |\n|---|---|---|");
for (const r of records.filter((x) => x.effects.length)) L.push(`| ${r.app}/${r.controller}::${r.action} | ${r.cluster} | ${r.effects.join(", ")} |`);
L.push("\n## What this ledger does not claim\n");
L.push("- That every action is a distinct user journey. Many are CRUD variants of one journey; the per-cluster inventories collapse them.\n- That the assignment is the only defensible cut. It is expressed as data in the generator, so a different cut is a diff, not a recount.\n- Anything about the front-end repositories, the live database, or live infrastructure.\n");

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, L.join("\n") + "\n");
writeFileSync(JSON_OUT, JSON.stringify({ source: `BAWES-Universe/studenthub@${actualRevision}`, functional: grand, hooks: optionsHooks, controllers: rows.length, actions: records }, null, 2) + "\n");
console.error(`functional=${grand} hooks=${optionsHooks} controllers=${rows.length} seven=${sevenClusters}`);
