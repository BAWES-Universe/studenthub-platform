import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const moduleFile = new URL("../../../dist/packages/profile/src/self-edit.js", import.meta.url);
const suite = fileURLToPath(new URL("../../../dist/packages/profile/test/self-edit.test.js", import.meta.url));
const pageModuleFile = new URL("../../../dist/apps/gateway/src/profile-edit-http.js", import.meta.url);
const pageSuite = fileURLToPath(new URL("../../../dist/apps/gateway/test/profile-edit-http.test.js", import.meta.url));
const webUiModuleFile = new URL("../../../dist/apps/gateway/src/web-ui.js", import.meta.url);
const mutations = [
  ["SHU372_RULES", "normalized !== normalized.trim()", "false"],
  ["SHU372_RULES", "/\\s{2}/u.test(normalized)", "false"],
  ["SHU372_RULES", "!NAME.test(normalized)", "false"],
  ["SHU372_RULES", "!ARABIC_LETTER.test(normalized)", "false"],
  ["SHU372_RULES", "value.normalize(\"NFC\")", "value"],
  ["SHU372_WRITE", "return normalized ? safeWrite.preview(normalized)", "return false ? safeWrite.preview(normalized)"],
  ["SHU372_OWNER", "return normalized ? safeWrite.confirm(normalized)", "return false ? safeWrite.confirm(normalized)"],
  ["SHU413_AGE", "minimum.setUTCFullYear(minimum.getUTCFullYear() - PERSON_PROFILE_MINIMUM_AGE);", "minimum.setUTCFullYear(minimum.getUTCFullYear() - 15);"],
  ["SHU413_WRITE", 'if (field === "gender" && !["male", "female", "other"].includes(normalized))', 'if (field === "gender" && false)'],
  ["SHU374_PHONE", '!/^\\+[0-9]{8,15}$/.test(normalized)', "false"],
  ["SHU374_HANDLE", '!/^[a-z][a-z0-9._-]{2,29}$/.test(normalized)', "false"],
  ["SHU415_WRITE", '(field === "nationality" || (field === "university" && normalized !== ""))', 'field === "university" && normalized !== ""'],
  ["SHU374_PAGE", "['phone', 'Phone number', 'tel', 32]", "['phone', 'Phone number', 'text', 32]", webUiModuleFile, pageSuite],
  ["SHU413_PAGE", "summary(afterShown)", "summary(after)", pageModuleFile, pageSuite],
  ["SHU415_PAGE", 'field === "kuwaitiMother" ? value === "" ? "Not recorded" : value === "true" ? "Yes" : "No"', 'field === "kuwaitiMother" ? value', pageModuleFile, pageSuite],
  ["SHU415_PAGE", 'catalogue.find(item => item.id === after)?.name ?? "Unavailable"', 'catalogue.find(item => item.id === after)?.name ?? "Not recorded"', pageModuleFile, pageSuite],
  ["SHU372_PAGE", "response.writeHead(303, { location: \"/profile\", \"cache-control\": \"no-store\" });", "response.writeHead(200, { location: \"/profile\", \"cache-control\": \"no-store\" });", pageModuleFile, pageSuite],
];
for (const [token, from, to, selectedModule = moduleFile, selectedSuite = suite] of mutations) {
  const original = await readFile(selectedModule, "utf8");
  assert.equal(original.split(from).length - 1, 1);
  try {
    await writeFile(selectedModule, original.replace(from, to));
    const result = spawnSync(process.execPath, [selectedSuite], { encoding: "utf8" });
    assert.notEqual(result.status, 0, `${token} mutant survived: ${from}`);
    assert.match(result.stdout + result.stderr, new RegExp(`not ok \\d+ - ${token} `), JSON.stringify({ status: result.status, signal: result.signal, error: String(result.error), stdout: result.stdout, stderr: result.stderr }));
    assert.match(result.stdout + result.stderr, /ERR_ASSERTION/);
  } finally { await writeFile(selectedModule, original); }
}

// CI's Postgres run also proves that the active-only catalogue boundary is
// load-bearing. Keep this here with the card's other mutants while allowing
// the ordinary, database-free profile suite to run locally.
if (process.env.DATABASE_URL) {
  const catalogueModule = new URL("../../../dist/packages/db/src/person-profile-store.js", import.meta.url);
  const catalogueSuite = fileURLToPath(new URL("../../../dist/packages/db/test/postgres-person-profile.test.js", import.meta.url));
  const from = "WHERE status='active' AND catalogue_type IN ('country','university')";
  const to = "WHERE status IN ('active','deleted') AND catalogue_type IN ('country','university')";
  const original = await readFile(catalogueModule, "utf8");
  assert.equal(original.split(from).length - 1, 1);
  try {
    await writeFile(catalogueModule, original.replace(from, to));
    const result = spawnSync(process.execPath, ["--test", "--test-name-pattern=^SHU415_CATALOGUE ", catalogueSuite], { encoding: "utf8", env: process.env });
    assert.notEqual(result.status, 0, "SHU415_CATALOGUE status-filter mutant survived");
    assert.match(result.stdout + result.stderr, /not ok \d+ - SHU415_CATALOGUE /);
    assert.match(result.stdout + result.stderr, /ERR_ASSERTION/);
  } finally { await writeFile(catalogueModule, original); }

  const commitFrom = "SELECT code FROM catalogue_items WHERE id=$1 AND catalogue_type=$2 AND status='active'";
  const commitTo = "SELECT code FROM catalogue_items WHERE id=$1 AND catalogue_type=$2";
  const commitOriginal = await readFile(catalogueModule, "utf8");
  assert.equal(commitOriginal.split(commitFrom).length - 1, 1);
  try {
    await writeFile(catalogueModule, commitOriginal.replace(commitFrom, commitTo));
    const result = spawnSync(process.execPath, ["--test", "--test-name-pattern=^SHU415_WRITE ", catalogueSuite], { encoding: "utf8", env: process.env });
    assert.notEqual(result.status, 0, "SHU415_WRITE commit catalogue mutant survived");
    assert.match(result.stdout + result.stderr, /not ok \d+ - SHU415_WRITE /);
    assert.match(result.stdout + result.stderr, /ERR_ASSERTION/);
  } finally { await writeFile(catalogueModule, commitOriginal); }
}
