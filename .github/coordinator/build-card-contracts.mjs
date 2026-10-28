// M16: writes card-contracts.json, the card contracts as data, from their
// source card-contracts.mjs.
//
// card-contracts.mjs is where a person or Claude writes a card: its briefs may
// be built from helpers and templates. Nothing the box runs imports it. What
// the coordinator reads, as root or not, is the generated card-contracts.json
// (card-contracts-reader.mjs), so an installed contracts change is never code:
// Card B parses both revisions' data and admits only new cards
// (service/card-install.mjs). A test checks the committed file is this
// script's output.
//
//   node .github/coordinator/build-card-contracts.mjs
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { CARD_CONTRACTS, REVIEW_ONLY_CARDS, WRITER_FINISH_RULE } from "./card-contracts.mjs";

export const CONTRACTS_DATA = fileURLToPath(new URL("./card-contracts.json", import.meta.url));

export function renderContracts() {
  return `${JSON.stringify({ cards: CARD_CONTRACTS, review_only: REVIEW_ONLY_CARDS, writer_finish_rule: WRITER_FINISH_RULE }, null, 2)}\n`;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(CONTRACTS_DATA, renderContracts());
}
