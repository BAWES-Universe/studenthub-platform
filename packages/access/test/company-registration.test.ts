import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompanyRegistrationService, decideReview, parseCompanyRegistration, parseRegistrationReview, type ReviewSnapshot } from "../src/index.js";

const staff = [{ orgId: "root", role: "staff", scope: "subtree" }];
const valid = { companyName: "  Acme   Trading ", contactName: "Sara Ali", contactPosition: "", phoneNumber: "+965 2222 3333", companyEmail: "HR@Acme.example", requestingFor: "" };
const ID = "6f1c2f8e-6a7b-4c2d-9e3f-0a1b2c3d4e5f";
const pending = (submitter = "owner-1"): ReviewSnapshot => ({ callerGrants: staff, registration: { submitterPrincipalId: submitter, status: "pending", companyName: "Acme" }, nameTaken: false, submitterPaused: false });

test("A7_FORM a registration needs a company name, a contact, a phone number and a company email address", () => {
  assert.deepEqual(parseCompanyRegistration(valid), { ...valid, companyName: "Acme Trading", companyEmail: "hr@acme.example" });
  assert.equal(parseCompanyRegistration({ ...valid, companyName: "A" }), undefined);
  assert.equal(parseCompanyRegistration({ ...valid, contactName: undefined }), undefined);
  assert.equal(parseCompanyRegistration({ ...valid, phoneNumber: "call me" }), undefined);
  assert.equal(parseCompanyRegistration({ ...valid, companyEmail: "not-an-address" }), undefined);
  assert.equal(parseCompanyRegistration({ ...valid, companyName: "Acme\u0000" }), undefined);
  assert.deepEqual(parseRegistrationReview({ registrationId: ID, action: "approve", reason: " Licence checked " }), { registrationId: ID, action: "approve", reason: "Licence checked" });
  assert.equal(parseRegistrationReview({ registrationId: ID, action: "approve", reason: "ok" }), undefined);
  assert.equal(parseRegistrationReview({ registrationId: "1", action: "approve", reason: "Licence checked" }), undefined);
  assert.equal(parseRegistrationReview({ registrationId: ID, action: "delete", reason: "Licence checked" }), undefined);
});

test("A7_RULES only operator staff decide, once, never on their own registration, and approval needs a free name and an unpaused person", () => {
  const review = { registrationId: ID, action: "approve" as const, reason: "Licence checked" };
  assert.deepEqual(decideReview("staff-1", review, pending()), { kind: "apply" });
  assert.deepEqual(decideReview("owner-2", review, { ...pending(), callerGrants: [{ orgId: "acme", role: "org-owner", scope: "subtree" }] }), { kind: "refused", reason: "not_allowed" });
  assert.deepEqual(decideReview("staff-1", review, { ...pending(), registration: null }), { kind: "refused", reason: "unknown_registration" });
  assert.deepEqual(decideReview("staff-1", review, { ...pending(), registration: { submitterPrincipalId: "owner-1", status: "rejected", companyName: "Acme" } }), { kind: "refused", reason: "already_decided" });
  assert.deepEqual(decideReview("staff-1", review, pending("staff-1")), { kind: "refused", reason: "own_registration" });
  assert.deepEqual(decideReview("staff-1", review, { ...pending(), nameTaken: true }), { kind: "refused", reason: "name_taken" });
  assert.deepEqual(decideReview("staff-1", review, { ...pending(), submitterPaused: true }), { kind: "refused", reason: "submitter_paused" });
  assert.deepEqual(decideReview("staff-1", { ...review, action: "reject" }, { ...pending(), nameTaken: true, submitterPaused: true }), { kind: "apply" }, "a rejection needs neither");
  assert.throws(() => createCompanyRegistrationService({ store: { review: async () => ({ kind: "rejected" }) }, operatorOrgIds: [] }), /operator organization/);
});
