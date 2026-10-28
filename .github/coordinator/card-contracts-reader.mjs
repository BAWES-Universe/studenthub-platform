// M16: the card contracts the coordinator reads, as data.
//
// Every module that needs a card's paths, acceptance or brief imports this
// one, never card-contracts.mjs: that file is where a card is written, and
// build-card-contracts.mjs turns it into card-contracts.json, which this
// module only parses. The box installs a reviewed change to the contracts by
// itself (service/card-install.mjs), so nothing it installs that way may be
// code that root runs: here it is a JSON file, read and frozen.
import fs from "node:fs";

const data = JSON.parse(fs.readFileSync(new URL("./card-contracts.json", import.meta.url), "utf8"));

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const table = (value, what) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`card-contracts.json: ${what} is not an object`);
  return deepFreeze(value);
};

export const CARD_CONTRACTS = table(data?.cards, "cards");
export const REVIEW_ONLY_CARDS = table(data?.review_only, "review_only");
export const WRITER_FINISH_RULE = data.writer_finish_rule;
if (typeof WRITER_FINISH_RULE !== "string" || !WRITER_FINISH_RULE) throw new Error("card-contracts.json: writer_finish_rule is not a string");

for (const id of Object.keys(REVIEW_ONLY_CARDS)) {
  if (Object.hasOwn(CARD_CONTRACTS, id)) throw new Error(`${id} cannot be both a build card and a review-only card`);
}

export function reviewOnlyCard(issueId) {
  return typeof issueId === "string" && Object.hasOwn(REVIEW_ONLY_CARDS, issueId) ? REVIEW_ONLY_CARDS[issueId] : null;
}

export function cardContract(issueId) {
  return typeof issueId === "string" && Object.hasOwn(CARD_CONTRACTS, issueId) ? CARD_CONTRACTS[issueId] : null;
}

// The writer and the reviewer of a card both get its brief. Fixtures have none:
// their files are their contract.
export function cardBrief(issueId) {
  return cardContract(issueId)?.brief ?? reviewOnlyCard(issueId)?.brief ?? null;
}
