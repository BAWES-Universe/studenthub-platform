import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PERSON_LIMITS, blockListOf, cidrText, clientAddress, decideLimit, limitKind, listed, mayManageBlocks, mediaType, normalizeAddress,
  parseBlockChange, parseCidr, parseTrustedProxies, windowStart,
} from "../src/index.js";

const proxies = blockListOf(parseTrustedProxies("10.0.0.0/8, 2001:db8:ffff::/48"));

test("A8_ADDRESS forwarding headers count only from a trusted proxy, read from the right", () => {
  assert.equal(clientAddress("198.51.100.9", "203.0.113.7", proxies), "198.51.100.9", "an untrusted peer's header is ignored");
  assert.equal(clientAddress("10.1.2.3", "203.0.113.7", proxies), "203.0.113.7");
  assert.equal(clientAddress("10.1.2.3", "1.2.3.4, 203.0.113.7, 10.9.9.9", proxies), "203.0.113.7", "a spoofed left entry is never reached");
  assert.equal(clientAddress("10.1.2.3", "10.2.2.2, 10.3.3.3", proxies), "10.1.2.3", "all hops trusted: the peer");
  assert.equal(clientAddress("10.1.2.3", "203.0.113.7, not-an-ip", proxies), "10.1.2.3", "a malformed hop ends the chain");
  assert.equal(clientAddress("10.1.2.3", undefined, proxies), "10.1.2.3");
  assert.equal(clientAddress("10.1.2.3", "203.0.113.7, , 10.9.9.9", proxies), "10.1.2.3", "an empty hop inside the chain ends it too");
  assert.equal(clientAddress("::ffff:10.1.2.3", ["203.0.113.7"], proxies), "203.0.113.7", "IPv4-mapped peers are normalized");
  assert.equal(clientAddress("2001:db8:ffff::1", "2001:db8:1::5", proxies), "2001:db8:1::5");
  assert.equal(clientAddress(undefined, "203.0.113.7", proxies), undefined);
  assert.equal(normalizeAddress("::FFFF:203.0.113.7"), "203.0.113.7");
  assert.throws(() => parseTrustedProxies("10.0.0.0/8, nonsense"));
  assert.deepEqual(parseTrustedProxies(undefined), []);
});

test("A8_ADDRESS a block is an address or a network starting at its first address, no wider than /8 or /16", () => {
  assert.equal(cidrText(parseCidr("203.0.113.7")!), "203.0.113.7/32");
  assert.equal(cidrText(parseCidr("203.0.113.0/24")!), "203.0.113.0/24");
  assert.equal(parseCidr("203.0.113.7/24"), undefined, "host bits set");
  assert.equal(parseCidr("0.0.0.0/0"), undefined, "too wide");
  assert.equal(parseCidr("10.0.0.0/7"), undefined);
  assert.equal(cidrText(parseCidr("2001:db8::/32")!), "2001:db8::/32");
  assert.equal(parseCidr("2001:db8::1/32"), undefined);
  assert.equal(parseCidr("::/0"), undefined);
  for (const bad of ["", "203.0.113.7/33", "203.0.113.7/24/1", "example.com", "203.0.113.7/ 24", "1.2.3"]) assert.equal(parseCidr(bad), undefined, bad);
  // Mapped and dotted spellings, as PostgreSQL renders them, mean the same network.
  assert.equal(cidrText(parseCidr("::ffff:cb00:7100/120")!), "203.0.113.0/24");
  assert.equal(cidrText(parseCidr("::ffff:203.0.113.0/120")!), "203.0.113.0/24");
  assert.equal(cidrText(parseCidr("::ffff:203.0.113.9/128")!), "203.0.113.9/32");
  assert.equal(cidrText(parseCidr("::ffff:203.0.113.9")!), "203.0.113.9/32");
  assert.equal(parseCidr("::ffff:203.0.113.0/95"), undefined, "a mapped prefix inside the ffff part");
  assert.equal(cidrText(parseCidr("::192.0.2.1/128")!), "::192.0.2.1/128");
  assert.equal(parseCidr("::192.0.2.1/120"), undefined, "host bits set in the dotted tail");
  const list = blockListOf([parseCidr("203.0.113.0/24")!, parseCidr("2001:db8::/32")!]);
  assert.equal(listed(list, "203.0.113.200"), true);
  assert.equal(listed(list, "203.0.114.1"), false);
  assert.equal(listed(list, "2001:db8:5::1"), true);
});

test("A8_LIMITS writes and uploads are counted separately in fixed windows, and the refusal says when to retry", () => {
  assert.equal(limitKind("GET", undefined), undefined);
  assert.equal(limitKind("HEAD", "multipart/form-data"), undefined);
  assert.equal(limitKind("POST", "application/x-www-form-urlencoded"), "write");
  assert.equal(limitKind("delete", undefined), "write");
  assert.equal(limitKind("POST", "multipart/form-data; boundary=x"), "upload");
  assert.equal(limitKind("PUT", "image/png"), "upload");
  assert.equal(windowStart(1_000_123, PERSON_LIMITS.write), 999_600);
  assert.deepEqual(decideLimit(PERSON_LIMITS.write.max, 1_000_123, PERSON_LIMITS.write), { kind: "allow" });
  assert.deepEqual(decideLimit(PERSON_LIMITS.write.max + 1, 1_000_123, PERSON_LIMITS.write), { kind: "limited", retryAfterSeconds: 77 });
  assert.deepEqual(decideLimit(31, 3600, PERSON_LIMITS.upload), { kind: "limited", retryAfterSeconds: 3600 });
});

test("A8_BLOCKS only an operator admin changes the block list, with a reason", () => {
  assert.equal(mayManageBlocks([{ orgId: "root", role: "admin", scope: "self" }]), true);
  assert.equal(mayManageBlocks([{ orgId: "root", role: "staff", scope: "subtree" }]), false);
  assert.equal(mayManageBlocks([{ orgId: "acme", role: "admin", scope: "subtree" }]), false);
  assert.equal(parseBlockChange({ action: "block", cidr: "203.0.113.7", reason: "Credential stuffing" })?.cidr.prefix, 32);
  assert.equal(parseBlockChange({ action: "block", cidr: "203.0.113.7", reason: "no" }), undefined);
  assert.equal(parseBlockChange({ action: "ban", cidr: "203.0.113.7", reason: "Credential stuffing" }), undefined);
  assert.equal(parseBlockChange({ action: "unblock", cidr: "203.0.113.7/24", reason: "Credential stuffing" }), undefined);
});

test("A8_BLOCKS an IPv6 rule never matches an IPv4 address, nor an IPv4 rule an IPv6 one", () => {
  const list = blockListOf([parseCidr("::/16")!, parseCidr("2001:db8::/32")!]);
  assert.equal(listed(list, "203.0.113.9"), false, "::/16 covers mapped IPv4 in Node's BlockList, but not here");
  assert.equal(listed(list, "0:1::1"), true);
  const v4 = blockListOf([parseCidr("0.0.0.0/8")!, parseCidr("203.0.113.0/24")!]);
  assert.equal(listed(v4, "::1"), false);
  assert.equal(listed(v4, "203.0.113.9"), true);
  assert.equal(listed(v4, "not an address"), false);
});

test("A8_LIMITS uploads are recognized by media type whatever the parameters, spacing or case", () => {
  for (const type of ["application/pdf; charset=binary", " Application/PDF ", "APPLICATION/OCTET-STREAM", "  application/octet-stream;x=1",
    "Multipart/Form-Data; boundary=x", "IMAGE/PNG", " image/webp ; q=1", ["application/pdf"]] as const) {
    assert.equal(limitKind("POST", type), "upload", String(type));
  }
  for (const type of ["application/pdfx", "application/x-www-form-urlencoded; charset=utf-8", "text/plain", "", "imagex/png", "application/json"]) {
    assert.equal(limitKind("POST", type), "write", type);
  }
  assert.equal(mediaType(" Application/X-WWW-Form-Urlencoded ; charset=UTF-8"), "application/x-www-form-urlencoded");
  assert.equal(mediaType(undefined), "");
});

test("A8_LIMITS the JSON document upload routes count as uploads; other JSON writes stay writes", () => {
  assert.equal(limitKind("POST", "application/json", "/organization-documents/upload"), "upload");
  assert.equal(limitKind("POST", "application/json", "/organization-documents/replace"), "upload");
  assert.equal(limitKind("POST", "application/json", "/organization-documents/uploads"), "write");
  assert.equal(limitKind("GET", undefined, "/organization-documents/upload"), undefined);
});
