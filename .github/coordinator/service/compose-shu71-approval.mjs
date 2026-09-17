#!/usr/bin/env node
// Repository-only composition. No private key, network, ref update or host IO.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { verify, createPublicKey } from 'node:crypto';
import { canonicalBytes, validateShu71Package } from '../shu71-activation-package.mjs';
import { createGitAdapter, precomputeReseedBinding } from '../reseed-append-contract.mjs';
import { hash } from './phase-a-driver.mjs';
const need = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { code }); };
const same = (a, b) => canonicalBytes(a, false).equals(canonicalBytes(b, false));

export function composeApproval({ pkg, revision, activationId, checkout, tree, binding, anchor, publicKeyPem }) {
  need(pkg?.coordinator_revision === revision && pkg?.activation?.coordinator_revision === revision
    && binding?.approvedExecutionRevision === revision, 'CLOSURE_APPROVAL_STALE_REVISION');
  need(pkg?.activation_id === activationId && pkg?.activation?.activation_id === activationId,
    'CLOSURE_APPROVAL_ACTIVATION');
  need(Array.isArray(pkg.fixtures) && pkg.fixtures.length === 2
    && same(pkg.fixtures.map(f => f.issue_id).sort(), ['SHU-140', 'SHU-254']), 'CLOSURE_APPROVAL_MISSING_FIXTURE');
  need(/^[a-f0-9]{40}$/.test(tree) && /^\/[a-zA-Z0-9_/-]+$/.test(checkout)
    && !checkout.split('/').includes('..'), 'CLOSURE_APPROVAL_CHECKOUT');
  need(['branch', 'expected_parent', 'expected_seed_head', 'patch_sha256'].every(k => binding[k] === pkg.reseed?.[k]),
    'CLOSURE_APPROVAL_RESEED');
  // Validate settled structure, fixture projections, trust anchor and policies.
  // Empty signatures are intentional: production signs only AFTER owner approval.
  // A supplied signature must validate; malformed signatures are never stripped.
  const validation = validateShu71Package({ pkg, anchor, publicKeyPem, revision, mainRevision: revision,
    phase: 'revocation', now: new Date(pkg.created_at), issues: pkg.fixtures });
  need(validation.ok || (pkg.signature === '' && pkg.activation.signature === '' && validation.code === 'ACT_FORGED_ENVELOPE'),
    validation.code ?? 'CLOSURE_APPROVAL_PACKAGE');
  const unsigned = structuredClone(pkg); unsigned.signature = ''; unsigned.activation.signature = '';
  const payload = { kind: 'shu71-production-v1', checkout, tree, pkg: unsigned, binding: structuredClone(binding) };
  const bytes = canonicalBytes(payload, false);
  return { payload, bytes, sha256: hash(bytes) };
}

export function validateApproval(doc, expected, ownerKey, expectedDigest) {
  need(expectedDigest === hash(expected.bytes), 'CLOSURE_APPROVAL_DIGEST');
  need(doc && same(Object.keys(doc).sort(), ['payload', 'signature']), 'CLOSURE_APPROVAL_ENVELOPE');
  need(doc.payload?.pkg?.coordinator_revision === expected.payload.pkg.coordinator_revision,
    'CLOSURE_APPROVAL_STALE_REVISION');
  need(same(doc.payload?.pkg?.fixtures ?? [], expected.payload.pkg.fixtures), 'CLOSURE_APPROVAL_MISSING_FIXTURE');
  need(hash(canonicalBytes(doc.payload, false)) === expectedDigest && same(doc.payload, expected.payload),
    'CLOSURE_APPROVAL_DIGEST');
  let authentic = false;
  try { authentic = createPublicKey(ownerKey).asymmetricKeyType === 'ed25519'
    && /^[A-Za-z0-9+/]{86}==$/.test(doc.signature)
    && verify(null, expected.bytes, ownerKey, Buffer.from(doc.signature, 'base64')); } catch {}
  need(authentic, 'CLOSURE_APPROVAL_FOREIGN_KEY');
  return { version: 'shu71-owner-approval-validation-v1', ok: true, activation_id: expected.payload.pkg.activation_id,
    revision: expected.payload.pkg.coordinator_revision, canonical_sha256: expectedDigest };
}

export function composeFromRepository(repo, revision, activationId, packageFile, checkout) {
  need(/^[a-f0-9]{40}$/.test(revision), 'CLOSURE_APPROVAL_STALE_REVISION');
  const git = createGitAdapter(repo);
  const pkg = JSON.parse(fs.readFileSync(packageFile));
  need(pkg.coordinator_revision === revision, 'CLOSURE_APPROVAL_STALE_REVISION');
  const tree = git(['rev-parse', '--verify', `${revision}^{tree}`]).toString().trim();
  const anchor = JSON.parse(git(['show', `${revision}:.github/coordinator/shu71-trust-anchor.json`]));
  const publicKeyPem = git(['show', `${revision}:.github/coordinator/shu71-activation-public-key.pem`]).toString();
  const config = JSON.parse(git(['show', `${revision}:.github/coordinator/config.json`]));
  const lanes = [config.fixture_lane, ...config.fixture_lanes];
  need(pkg.fixtures?.length === 2 && pkg.fixtures.every(f => same(f.lane, lanes.find(l => l.id === f.issue_id) ?? null)),
    'CLOSURE_APPROVAL_MISSING_FIXTURE');
  const binding = precomputeReseedBinding({ git, branch: 'coordinator/SHU-140',
    expected_parent: pkg.reseed.expected_parent, approvedExecutionRevision: revision });
  return composeApproval({ pkg, revision, activationId, checkout, tree, binding, anchor, publicKeyPem });
}
export function main(argv = process.argv.slice(2)) {
  const [action, repo, revision, activationId, packageFile, checkout, prefix, envelopeFile, ownerKeyFile] = argv;
  need(['compose', 'seal', 'validate'].includes(action) && argv.length === (action === 'compose' ? 7 : 9)
    && [repo, packageFile, checkout, prefix, ...(action !== 'compose' ? [envelopeFile, ownerKeyFile] : [])].every(p => path.isAbsolute(p ?? '')),
    'CLOSURE_APPROVAL_USAGE');
  const result = composeFromRepository(repo, revision, activationId, packageFile, checkout);
  if (action !== 'compose') {
    const doc = action === 'validate' ? JSON.parse(fs.readFileSync(envelopeFile))
      : { payload: result.payload, signature: fs.readFileSync(envelopeFile).toString('base64') };
    const validation = validateApproval(doc, result, fs.readFileSync(ownerKeyFile), fs.readFileSync(`${prefix}.sha256`, 'utf8').trim());
    if (action === 'seal') fs.writeFileSync(`${prefix}.shu71.json`, canonicalBytes(doc, false), { flag: 'wx', mode: 0o600 });
    return validation;
  }
  // Exclusive writes: a previous reviewed signing input cannot be overwritten.
  fs.writeFileSync(`${prefix}.canonical.json`, result.bytes, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(`${prefix}.sha256`, result.sha256 + '\n', { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(`${prefix}.unsigned.json`, canonicalBytes({ payload: result.payload, signature: '' }, false), { flag: 'wx', mode: 0o600 });
  return { ok: true, signed: false, canonical_sha256: result.sha256, activation_id: activationId, revision };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(main())); }
  catch (error) { console.error(JSON.stringify({ ok: false, code: error.code ?? 'CLOSURE_APPROVAL_INPUT' })); process.exitCode = 2; }
}
