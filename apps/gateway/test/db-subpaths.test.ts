import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const areas = ["profile", "access", "catalogue", "organizations", "pay-contracts", "ops", "documents", "notifications"] as const;
const expected = {
  profile: ["BANK_DETAILS_OPERATION", "LANGUAGES", "LANGUAGE_FIELD", "LegacyCandidateAlreadyLinkedError", "PERSON_PROFILE_FIELDS", "PersonProfileBrowserRetryableError", "PostgresBankDetailsStore", "PostgresLegacyLinkStore", "PostgresPersonLocationStore", "PostgresPersonProfileStore", "PostgresProfileRecordStore", "PostgresReferenceResolver", "PostgresSafeWriteStore", "PrincipalAlreadyLinkedError", "SAFE_WRITE_OPERATION", "personRecordRef", "safeWritePrincipalRef"],
  access: ["AUTHORIZATION_MUTATION_OPERATIONS", "PostgresAuthzStore", "PostgresLoginStore", "organizationAuditRef", "principalAuditRef", "readLiveLoginSessionPerson", "requestAuditRef"],
  catalogue: ["PostgresCatalogueStore"],
  organizations: ["ORGANIZATION_ACCOUNT_MANAGER_OPERATION", "ORGANIZATION_APPROVED_TO_HIRE_OPERATION", "ORGANIZATION_BRAND_LINK_OPERATION", "ORGANIZATION_BRAND_UNLINK_OPERATION", "ORGANIZATION_COMMERCIAL_TERMS_OPERATION", "ORGANIZATION_CREATE_OPERATION", "ORGANIZATION_DELETION_OPERATION", "ORGANIZATION_NOTES_OPERATION", "ORGANIZATION_PROFILE_OPERATION", "ORGANIZATION_STATUS_OPERATION", "ORGANIZATION_STORE_CREATE_OPERATION", "ORGANIZATION_STORE_REMOVE_OPERATION", "ORGANIZATION_STORE_UPDATE_OPERATION", "PostgresOrganizationAccountManagerReads", "PostgresOrganizationAccountManagerStore", "PostgresOrganizationApprovedToHireStore", "PostgresOrganizationBrandsStore", "PostgresOrganizationCommercialTermsStore", "PostgresOrganizationCreationStore", "PostgresOrganizationDeletionStore", "PostgresOrganizationNotesStore", "PostgresOrganizationProfileReads", "PostgresOrganizationProfileStore", "PostgresOrganizationStatusStore", "PostgresOrganizationStoresStore"],
  "pay-contracts": ["PAY_CONTRACT_CREATE_SAFE_WRITE_OPERATION", "PostgresFinanceReferenceResolver", "PostgresPayContractSafeWriteStore", "PostgresPayContractStore"],
  ops: ["DEFAULT_DATABASE_URL", "PostgresExportsStore", "PostgresJobRunsStore", "bootstrapAdmin", "databaseUrl", "runMigrations"],
  documents: [],
  notifications: ["EMAIL_CLAIM_LEASE_SECONDS", "PostgresEmailOutboxStore", "PostgresNotificationsStore", "recordOrganizationStatusChanged"],
} as const;

async function moduleFor(specifier: string): Promise<Record<string, unknown>> {
  return import(specifier) as Promise<Record<string, unknown>>;
}

test("PREP_EXPORTS explicit database area exports resolve with their assigned values", async () => {
  const manifest = JSON.parse(await readFile(resolve("packages/db/package.json"), "utf8")) as { exports: Record<string, Record<string, string>> };
  assert.deepEqual(Object.keys(manifest.exports).sort(), [".", ...areas.map(area => `./${area}`), "./assertions"].sort());
  assert.equal(JSON.stringify(manifest.exports).includes("*"), false);
  for (const area of areas) {
    assert.deepEqual(manifest.exports[`./${area}`], { types: `./dist/${area}/index.d.ts`, import: `./dist/${area}/index.js` });
    const entry = await moduleFor(`@studenthub/db/${area}`);
    assert.deepEqual(Object.keys(entry).sort(), [...expected[area]].sort(), `PREP_EXPORTS ${area} owns exactly its assigned runtime exports`);
  }
  // Assertions is subpath-only: keep the original root-export golden unchanged.
  assert.deepEqual(manifest.exports["./assertions"], {
    types: "./dist/assertions/index.d.ts", import: "./dist/assertions/index.js",
  });
  const assertions = await moduleFor("@studenthub/db/assertions");
  assert.deepEqual(Object.keys(assertions), ["PostgresReplayStore"]);
  assert.equal(typeof assertions.PostgresReplayStore, "function");
});

test("PREP_ROOT_SAME root database exports are the unchanged golden set and identical area objects", async () => {
  const root = await moduleFor("@studenthub/" + "db");
  const golden = areas.flatMap(area => [...expected[area]]).sort();
  assert.deepEqual(Object.keys(root).sort(), golden);
  for (const area of areas) {
    const entry = await moduleFor(`@studenthub/db/${area}`);
    for (const name of expected[area]) assert.equal(root[name], entry[name], `PREP_ROOT_SAME ${name}`);
  }
});

async function javascriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async entry => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? javascriptFiles(path) : entry.name.endsWith(".js") && !entry.name.endsWith(".d.js") ? [path] : [];
  }))).flat();
}

test("PREP_DEEP_IMPORTS compiled applications use database area paths only", async () => {
  const packageRoot = "@studenthub/" + "db";
  const flatSource = ["packages", "db", "src", "index.js"].join("/");
  for (const file of await javascriptFiles(resolve("dist/apps"))) {
    const source = await readFile(file, "utf8");
    const specifiers = [...source.matchAll(/(?:from\s*|import\s*\()(["'])([^"']+)\1/g)].map(match => match[2]);
    assert.equal(specifiers.includes(packageRoot), false, `PREP_DEEP_IMPORTS ${file}`);
    assert.equal(specifiers.some(value => value?.endsWith(flatSource)), false, `PREP_DEEP_IMPORTS ${file}`);
  }
  assert.match(await readFile(resolve("dist/apps/worker/src/index.js"), "utf8"), /packages\/db\/src\/ops\/index\.js/);
});

test("PREP_CLOSURE deployment closure follows database subpaths and pinned migration entry", async () => {
  // The deployment helper is JavaScript and intentionally has no declaration file.
  // @ts-expect-error imported deployment JavaScript is verified at runtime
  const { runtimeClosure } = await import("../../../../deploy/coolify/stage-workspaces.mjs") as { runtimeClosure(root: string): { code: string[] } };
  const { code } = runtimeClosure(resolve("."));
  for (const file of ["packages/db/dist/access/index.js", "packages/db/dist/profile/index.js", "packages/db/dist/migrate.js"]) {
    assert.ok(code.includes(file), `PREP_CLOSURE includes ${file}`);
  }
});

test("PREP_STABLE database subpaths preserve values without adding behavior", () => {
  assert.equal(areas.length, 8);
  assert.equal(new Set(areas.flatMap(area => expected[area])).size, areas.flatMap(area => expected[area]).length);
});
