import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { REAL_PROFILE_PERSON, startRealProfileServer } from "./helpers/real-profile-server.js";

test("REAL_PROFILE a saved civil ID shows masked on a real cookie GET /profile, read by the row and the completeness check", async (t) => {
  const server = await startRealProfileServer(t);
  const saved = await server.civilId.save({ principalId: REAL_PROFILE_PERSON, country: "KW", number: "290010100000", expiry: "2027-12-31", revision: 0, submissionId: "00000000-0000-4000-8000-000000000001" });
  assert.equal((saved as { ok: boolean }).ok, true, JSON.stringify(saved));
  server.counts.civilReads = 0;
  const response = await server.get("/profile");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /id="field-civilId"/, "the Civil ID row renders through the real composition");
  assert.match(html, /0000/, "the masked last four show");
  assert.doesNotMatch(html, /290010100000/, "the full number never shows");
  assert.match(html, /Waiting for StudentHub to check/, "a changed number waits for a staff check");
  // Production reads it twice per render too: once in the merged My profile
  // read and once in the completeness check (wireProfile's web.profileCompleteness).
  assert.equal(server.counts.civilReads, 2, "the row's read and the completeness check's read");
  assert.equal(server.counts.profileReads, 1, "one My profile read per render");
});

test("REAL_PROFILE another person's session never sees the first person's civil ID", async (t) => {
  const server = await startRealProfileServer(t);
  await server.civilId.save({ principalId: REAL_PROFILE_PERSON, country: "KW", number: "290010100000", expiry: "2027-12-31", revision: 0, submissionId: "00000000-0000-4000-8000-000000000002" });
  const response = await server.get("/profile", "t".repeat(43));
  assert.equal(response.status, 200);
  assert.doesNotMatch(await response.text(), /0000<\/bdi>|•••• •••• 0000/);
});

test("REAL_PROFILE wireProfile builds My profile through composeOwnProfiles, the function the helper runs", async () => {
  const source = await readFile(new URL("../src/wiring/profile.js", import.meta.url), "utf8");
  assert.equal(source.split("composeOwnProfiles(").length - 1, 2, "defined once and called once by wireProfile");
  assert.equal(source.split("new OwnProfileRepository(").length - 1, 1, "the only OwnProfileRepository in the wiring is the composed one");
});
