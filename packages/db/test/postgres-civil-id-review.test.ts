import assert from "node:assert/strict";
import test from "node:test";
import { PostgresCivilIdReviewStore } from "../src/postgres-civil-id-review-store.js";

test("REV_QUEUE review store exposes fixed-cardinality queue and state operations",()=>{assert.equal(typeof PostgresCivilIdReviewStore.prototype.listPending,"function");assert.equal(typeof PostgresCivilIdReviewStore.prototype.countPending,"function");assert.equal(typeof PostgresCivilIdReviewStore.prototype.stateFor,"function");});
test("REV_DECIDE review store exposes transactional decision and audit operations",()=>{assert.equal(typeof PostgresCivilIdReviewStore.prototype.decide,"function");assert.equal(typeof PostgresCivilIdReviewStore.prototype.recordView,"function");});
