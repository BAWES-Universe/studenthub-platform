import test from "node:test";
import assert from "node:assert/strict";
import {PostgresCivilIdReviewStore} from "../src/postgres-civil-id-review-store.js";
test("REV_DECIDE postgres civil ID review store exports its transactional API",()=>{assert.equal(typeof PostgresCivilIdReviewStore,"function");});
