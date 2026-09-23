// WHETHER A CANDIDATE CHANGES THE RECEIPT AUTHORITY, SETTLED AGAINST ITS MERGE BASE.
//
// A receipt this authority produces may not approve a candidate that edits the authority itself. The first
// version of this check settled that by object identity, which is right, but against the wrong baseline.
//
// WHAT WAS MEASURED. The first `workflow_dispatch` of the authority on main (run 35852850002, candidate
// 6feac016) compared the object id of each authority path ON MAIN with the object id AT THE CANDIDATE and
// refused, reporting `main=3615f658 candidate=<absent>` for the workflow file and `main=03fe40ba
// candidate=<absent>` for the directory. That candidate altered nothing: it was cut from an older main and
// therefore carries no authority at all. Comparing against main reads ABSENT as ALTERED, so it refuses every
// candidate that does not already contain the authority - that is, every candidate cut before the authority
// landed. 6feac016's merge base with the commit that landed the authority is a51c8490, and the authority is
// absent there too; the two tests at the foot of test/authority-scope.test.mjs read exactly that out of this
// repository's own git objects.
//
// THE BASELINE THAT ANSWERS THE QUESTION ASKED. "Did the candidate touch this" is a question about what the
// candidate started from, and main is not that: main moves after a branch is cut. The merge base of the
// protected ref and the candidate is the one revision at which "the candidate's copy" and "what the candidate
// started from" are the same object, so it is the baseline here. A candidate holding an OLDER copy of the
// authority while main has moved on has touched nothing - the merge resolves that in main's favour, and the
// authority that judges the candidate is main's own definition either way. That case is reported as stale
// rather than refused.
//
// WHY OBJECT IDS AND NOT A DIFF LISTING. The emitter's section 8 comment records both holes measured in the
// listing form, and neither is reintroduced here: GitHub's compare endpoint caps `files` at 300 entries, sorts
// by filename and truncates with nothing in the response saying so (300 returned for a comparison that changed
// 429 files, measured on this repository), and a rename is reported under its NEW name only, so moving the
// authority elsewhere - which deletes it - matches no pattern at all. This module reads the compare response
// for its `merge_base_commit.sha` and for nothing else; every other fact it uses is the object id the contents
// API reports for a path at a ref. A directory's sha covers every byte under it, so one read answers for the
// whole subtree however many other files the candidate touched.
//
// AND ONE HOLE THIS FORM DOES *NOT* CLOSE BY ITSELF, named rather than claimed away: the listing an id is read
// OUT of is itself capped, at LISTING_CAP entries, and a truncated listing is indistinguishable from a
// directory that does not hold the entry. A listing at the cap is refused (see LISTING_CAP) because the two
// readings must never be conflated: an alteration could otherwise present the one shape that is admissible.

// The authority, named as OBJECTS rather than as a pattern to test a listing against.
export const AUTHORITY_PATHS = [
  { dir: '.github/workflows', name: 'verifier-receipt.yml', kind: 'file' },
  { dir: '.github', name: 'verifier-receipt', kind: 'directory' },
];

// THE CAP THE CONTENTS API PUTS ON A DIRECTORY LISTING, AND WHY IT IS HERE RATHER THAN ASSUMED AWAY.
//
// An earlier version of this file claimed that an object id "is not a page of a list". That is true of the id
// and false of the way an id is obtained: `GET /contents/{dir}` returns up to this many entries, and a listing
// cut off at the cap looks exactly like a directory that does not contain the entry - which this module reads
// as ABSENT, the one answer that can make an alteration admissible. The compare endpoint's `files` hole is the
// same shape at 300 entries; this one is one order of magnitude further out and no less real. So a listing at or
// above the cap is refused by name rather than read: "not there" and "may be off the end of the page" are
// different answers and only the first may be used.
export const LISTING_CAP = 1000;

const short = sha => (typeof sha === 'string' && sha.length > 12 ? sha.slice(0, 12) : sha);
const absentOr = sha => (sha === null || sha === undefined ? '<absent>' : short(sha));

// THE DECISION, AND IT DOES NO I/O. Everything it needs is in `observed`, which is what observeAuthorityScope
// returns - so the same decision a run makes from GitHub's answers can be made in a test from written-down
// answers, and the two are the same code.
//
// `observed` is { protected_ref, candidate_sha, merge_base, merge_base_error, entries: [{ path, dir, name,
// kind, base, candidate, protected }] }, where each of base/candidate/protected is { listed, sha }: `listed`
// says the API served the directory listing at that ref, and `sha` is the entry's object id in it or null when
// the listing does not contain the entry. The two are different facts and the difference is the whole point -
// "not there" is an answer, "cannot say" is not.
export function decideAuthorityScope(observed) {
  const protectedRef = observed.protected_ref;
  const candidateSha = observed.candidate_sha;
  const mergeBase = observed.merge_base ?? null;
  const refuses = [];
  const refuse = message => refuses.push({ code: 'candidate.authority', message });

  // FAIL CLOSED WITH NO MERGE BASE. Without the fork point there is no baseline, and the only comparisons left
  // are the one that was measured wrong (against main) and none at all. Neither may admit a candidate.
  if (!mergeBase) {
    refuse(`this run cannot establish the merge base of ${protectedRef} and ${short(candidateSha)} `
      + `(${observed.merge_base_error ?? 'the comparison carries no merge_base_commit'}), so it cannot tell a `
      + 'candidate that edits the receipt authority from one that predates it');
  }

  const entries = [];
  let anyListingTruncated = false;
  for (const seen of observed.entries ?? []) {
    const base = seen.base ?? { listed: false, truncated: false, sha: null };
    const candidate = seen.candidate ?? { listed: false, truncated: false, sha: null };
    const onProtected = seen.protected ?? { listed: false, truncated: false, sha: null };
    // A listing the API will not serve is refused, not skipped: a run that cannot read one side of the
    // comparison has not made it.
    if (!onProtected.listed) {
      refuse(`the API cannot list ${seen.dir} on ${protectedRef}, so this run cannot establish what ${seen.path} `
        + 'is on the protected branch');
    }
    if (!candidate.listed) {
      refuse(`the API cannot list ${seen.dir} at ${short(candidateSha)}, so this run cannot establish what `
        + `${seen.path} is at the candidate`);
    }
    if (mergeBase && !base.listed) {
      refuse(`the API cannot list ${seen.dir} at the merge base ${short(mergeBase)}, so this run cannot `
        + `establish what ${seen.path} was at the revision the candidate was cut from`);
    }

    // A PAGE AT THE CAP IS REFUSED, ON EVERY SIDE, AND THIS IS THE ONE PLACE IT MATTERS MOST. An entry missing
    // from a truncated page may be off the end of it rather than absent, and "absent" is the single answer that
    // can make an alteration admissible - so being unable to say must never be read as "not there" here.
    const sides = [['the protected ref', onProtected], ['the candidate', candidate],
      ...(mergeBase ? [[`the merge base ${short(mergeBase)}`, base]] : [])];
    for (const [where, oneSide] of sides) {
      if (oneSide.listed && oneSide.truncated) {
        anyListingTruncated = true;
        refuse(`the listing of ${seen.dir} at ${where} is at the API's ${LISTING_CAP}-entry cap, so an entry `
          + 'missing from it may be off the end of the page rather than absent; this run will not read that as '
          + '"not there"');
      }
    }

    // `change` is named relative to the MERGE BASE, and it is left unknown rather than guessed when a side of
    // the comparison is missing - each of those cases has already produced its own refusal above.
    let change = 'unknown';
    if (mergeBase && base.listed && candidate.listed) {
      if (base.sha === candidate.sha) change = 'none';
      else if (base.sha === null) change = 'added';
      else if (candidate.sha === null) change = 'deleted';
      else change = 'modified';
    }
    if (change === 'added') {
      refuse(`${seen.path} is added relative to the merge base: absent at ${short(mergeBase)}, `
        + `${short(candidate.sha)} at the candidate`);
    }
    if (change === 'modified') {
      refuse(`${seen.path} is modified relative to the merge base: ${short(base.sha)} at ${short(mergeBase)}, `
        + `${short(candidate.sha)} at the candidate`);
    }
    if (change === 'deleted') {
      refuse(`${seen.path} is deleted relative to the merge base: ${short(base.sha)} at ${short(mergeBase)}, `
        + 'absent at the candidate');
    }
    entries.push({
      path: seen.path,
      kind: seen.kind,
      base_sha: base.sha ?? null,
      candidate_sha: candidate.sha ?? null,
      protected_sha: onProtected.sha ?? null,
      change,
    });
  }

  // The two states worth naming on an ADMISSIBLE result, so a reader can tell them apart without reading this
  // file. They are not exclusive: a candidate that predates the authority is also behind the protected ref.
  //
  // NEITHER IS ASSERTED FROM A PAGE THAT MAY HAVE BEEN CUT OFF. Both read `null` as "not there", and a listing
  // at the API's cap is not evidence of that - so on a truncated read these two flags are false and the refusals
  // above are what carries the meaning. A flag is only worth having if it is true when it is set.
  const predatesAuthority = !anyListingTruncated && entries.some(entry => entry.change === 'none'
    && entry.candidate_sha === null && entry.base_sha === null && entry.protected_sha !== null);
  const staleRelativeToProtected = !anyListingTruncated && entries.some(entry => entry.change === 'none'
    && entry.candidate_sha !== entry.protected_sha);

  return {
    ok: refuses.length === 0,
    protected_ref: protectedRef,
    candidate_sha: candidateSha,
    merge_base: mergeBase,
    refuses,
    entries,
    predates_authority: predatesAuthority,
    stale_relative_to_protected: staleRelativeToProtected,
  };
}

// THE READS, AND ONLY THE READS. `api(endpoint)` returns the parsed JSON body or null when the request failed;
// it may be sync or async. Injected rather than built here so the emitter keeps its ONE HTTP path - the same
// `gh api` call every other fact in a receipt is fetched through - and so a test needs no network.
export async function observeAuthorityScope({ repo, protectedRef, candidateSha, api }) {
  // The merge base, and nothing else, out of the compare response. `files` is not read here: see the header.
  const compare = await api(`/repos/${repo}/compare/${protectedRef}...${candidateSha}`);
  let mergeBase = null;
  let mergeBaseError = null;
  if (!compare) {
    mergeBaseError = `the API cannot compare ${protectedRef} with ${short(candidateSha)}`;
  } else if (typeof compare.merge_base_commit?.sha === 'string' && compare.merge_base_commit.sha !== '') {
    mergeBase = compare.merge_base_commit.sha;
  } else {
    mergeBaseError = `the comparison of ${protectedRef} with ${short(candidateSha)} names no merge_base_commit.sha`;
  }

  // One listing per (directory, ref): the two authority entries share `.github` on some refs and would
  // otherwise be fetched twice, and a second fetch is a second chance for the two to disagree.
  const listings = new Map();
  const listingAt = async (dir, ref) => {
    const key = `${dir}\n${ref}`;
    if (!listings.has(key)) listings.set(key, await api(`/repos/${repo}/contents/${encodeURI(dir)}?ref=${ref}`));
    return listings.get(key);
  };
  const entryAt = async (entry, ref) => {
    if (!ref) return { listed: false, truncated: false, sha: null };
    const listing = await listingAt(entry.dir, ref);
    if (!Array.isArray(listing)) return { listed: false, truncated: false, sha: null };
    // AT THE CAP IS NOT READ AS "NOT THERE". See LISTING_CAP: an entry missing from a full page and an entry
    // missing from a directory are different facts, and only the second may be used to admit a candidate.
    const truncated = listing.length >= LISTING_CAP;
    const found = listing.find(item => item.name === entry.name);
    return { listed: true, truncated, sha: found?.sha ?? null };
  };

  const entries = [];
  for (const entry of AUTHORITY_PATHS) {
    entries.push({
      path: `${entry.dir}/${entry.name}`,
      dir: entry.dir,
      name: entry.name,
      kind: entry.kind,
      // With no merge base there is nothing to read the base side at; the decision refuses on that alone.
      base: await entryAt(entry, mergeBase),
      candidate: await entryAt(entry, candidateSha),
      protected: await entryAt(entry, protectedRef),
    });
  }

  return {
    repo,
    protected_ref: protectedRef,
    candidate_sha: candidateSha,
    merge_base: mergeBase,
    merge_base_error: mergeBaseError,
    entries,
  };
}

// What a reader of a log needs to see: the ids the decision was made from, one line per authority path, then
// the verdict. Returned rather than printed so the caller owns the stream.
export function renderAuthorityScope(decision) {
  const lines = [`merge base of ${decision.protected_ref} and ${short(decision.candidate_sha)}: `
    + `${decision.merge_base ? short(decision.merge_base) : '<not established>'}`];
  for (const entry of decision.entries) {
    lines.push(`${entry.path}: base=${absentOr(entry.base_sha)} candidate=${absentOr(entry.candidate_sha)} `
      + `${decision.protected_ref}=${absentOr(entry.protected_sha)} -> ${entry.change}`);
  }
  if (decision.ok) {
    lines.push('the candidate changes no authority object relative to its merge base'
      + (decision.predates_authority ? ', and carries none of it: it predates the authority' : '')
      + (decision.stale_relative_to_protected ? `; its copy is not what ${decision.protected_ref} holds today, `
        + 'which the merge resolves in the protected branch\'s favour' : ''));
  }
  return lines;
}

// THE CLI, WHICH IS HOW THE TRUST JOB RUNS THIS. That job checks out no code on purpose - it is setup-node,
// inline shell and API reads - so it fetches this file from the trusted commit through the contents API and
// runs it here. `fetch` rather than `gh`, because nothing in that job guarantees a `gh` on PATH once the step
// is a node process; the token is the same `github.token` the rest of the job uses.
if (import.meta.url === `file://${process.argv[1]}`) {
  const [repo, protectedRef, candidateSha] = process.argv.slice(2);
  if (!repo || !protectedRef || !candidateSha) {
    console.error('::error::usage: node authority-scope.mjs <owner/repo> <protected-ref> <candidate-sha>');
    process.exit(1);
  }
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('::error::no GH_TOKEN in this step, so it cannot read the authority objects it must compare');
    process.exit(1);
  }
  const api = async endpoint => {
    const response = await fetch(`https://api.github.com${endpoint}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'verifier-receipt-authority-scope',
      },
    });
    if (!response.ok) return null;
    try { return await response.json(); } catch { return null; }
  };
  const decision = decideAuthorityScope(await observeAuthorityScope({ repo, protectedRef, candidateSha, api }));
  for (const line of renderAuthorityScope(decision)) console.log(line);
  if (!decision.ok) {
    console.error('::error::this candidate changes the receipt authority relative to its merge base '
      + `(${decision.refuses.map(entry => entry.message).join('; ')}), so no receipt this authority produces `
      + 'may approve it');
    process.exit(1);
  }
}
