import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const source=await readFile(new URL("../../../dist/packages/private-documents/src/staff-delivery.js",import.meta.url),"utf8");
for(const [token,needle] of [["REV_STAFF","listGrantsForPrincipal"],["REV_IMAGES","staff-delivery-v1:"],["REV_IMAGES","claim.viewer !== viewer"],["REV_IMAGES","await this.#audit.recordView"]])assert.ok(source.includes(needle),`${token} mutation binding`);
