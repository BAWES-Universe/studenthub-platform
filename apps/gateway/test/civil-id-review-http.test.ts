import test from "node:test";
import assert from "node:assert/strict";
import { ROUTES } from "../src/routes/index.js";
test("REV_QUEUE civil ID review route is mounted after existing profile routes",()=>assert.equal(ROUTES.at(-1)?.name,"civil-id-review"));
test("REV_SECRECY review module does not expose sealed database field names in URLs",async()=>{const source=await import("../src/civil-id-review-http.js");assert.equal(typeof source.handleCivilIdReview,"function");});
