import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// These are deliberately checked against compiled output: minification or a
// refactor must not silently detach the card's mutation points from CI.
const gatherer = await readFile(new URL("../../../dist/apps/gateway/src/profile-completeness.js", import.meta.url), "utf8");
const renderer = await readFile(new URL("../../../dist/apps/gateway/src/web-ui.js", import.meta.url), "utf8");
const points = [
  [gatherer, "currentProfileAvatar()", "Q14_4_SHOWN reuses the avatar document list"],
  [gatherer, "applyProfileCompleteness(own.profile, result)", "Q14_4_DERIVED applies without storing"],
  [renderer, "const target = requirementTarget(requirement);", "Q14_4_CHECKLIST keeps item targets"],
  [gatherer, "writeHtml(response, 200, html", "Q14_4_STATUS keeps the found status"],
];
for (const [source, needle, name] of points) {
  assert.equal(source.split(needle).length - 1, 1, `${name}: mutation needle binds once`);
}
console.log("Q14_4 mutation points bind once in compiled files");
