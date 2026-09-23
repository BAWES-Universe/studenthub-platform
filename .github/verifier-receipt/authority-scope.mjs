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
// absent there too; the two tests at the foot of test/authority-scope.test.mjs read exactly that out of
// api.github.com's written-down answers for those three refs.
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
// for its `merge_base_commit.sha` and for nothing else; every other fact it uses is an entry of a git TREE.
// A directory's sha covers every byte under it, so one read answers for the whole subtree however many other
// files the candidate touched.
//
// AND WHY THE TREES ENDPOINT RATHER THAN A CONTENTS LISTING, WHICH IS THE CORRECTION THIS ROUND CARRIES. The
// ids were previously read out of `GET /contents/{dir}?ref=`, and an independent review MEASURED two ways past
// that form:
//
//   * A contents listing reports a blob's object id, and an id DOES NOT MOVE WHEN ONLY THE FILE MODE DOES. So
//     `chmod +x .github/workflows/verifier-receipt.yml` - a change to an authority file, and one that changes
//     how it is executed - compared equal and was admitted. A tree entry carries `mode`, and `mode` is part of
//     the comparison below: same id, different mode is `modified`.
//   * A contents listing says nothing about whether it is the whole directory, so the old code inferred
//     truncation from the listing's LENGTH against a cap constant. A Link-paginated or `per_page`-limited page is SHORTER
//     than any cap, so it is indistinguishable from a directory that does not hold the entry - and "absent" is
//     the one reading that admits an alteration. The review built a 999-entry page that omitted the authority
//     and the decision came back admissible with `predates_authority: true`. A tree response carries an
//     explicit `truncated` boolean; it is refused BY NAME here, never inferred from a length, and there is no
//     cap constant left to compare against.
//
// So an entry that is absent from a COMPLETE tree is absent - that is an answer, and the predating candidate
// depends on it. An entry that cannot be seen because the response was cut off is not evidence of anything.

// The authority, named as OBJECTS rather than as a pattern to test a listing against.
export const AUTHORITY_PATHS = [
  { dir: '.github/workflows', name: 'verifier-receipt.yml', kind: 'file' },
  { dir: '.github', name: 'verifier-receipt', kind: 'directory' },
];

const short = sha => (typeof sha === 'string' && sha.length > 12 ? sha.slice(0, 12) : sha);
const absentOr = sha => (sha === null || sha === undefined ? '<absent>' : short(sha));
// A side of the comparison that was never read at all: no ref to read it at, and so no answer of any kind.
const UNREAD = { read: false, truncated: false, truncated_at: null, unread_at: null, sha: null, mode: null };
// A side whose id may be compared: the tree that would hold the entry was served, whole.
const usable = side => side.read === true && side.truncated !== true;

// THE DECISION, AND IT DOES NO I/O. Everything it needs is in `observed`, which is what observeAuthorityScope
// returns - so the same decision a run makes from GitHub's answers can be made in a test from written-down
// answers, and the two are the same code.
//
// `observed` is { protected_ref, candidate_sha, merge_base, merge_base_error, entries: [{ path, dir, name,
// kind, base, candidate, protected }] }, where each of base/candidate/protected is { read, truncated,
// truncated_at, unread_at, sha, mode }: `read` says the API served every tree on the way down to the entry's
// own directory (and `unread_at` names the one it would not serve), `truncated` says one of those responses
// declared itself cut off (and `truncated_at` names it), and `sha`/`mode` are the entry's object id and file
// mode in the tree that would hold it - both null when the tree holds no such entry. Those
// are three different facts and the difference is the whole point: "not there" is an answer, "cannot say" is
// not, and "there, with a different mode" is a change.
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
  let anythingUnread = false;
  for (const seen of observed.entries ?? []) {
    const base = seen.base ?? UNREAD;
    const candidate = seen.candidate ?? UNREAD;
    const onProtected = seen.protected ?? UNREAD;
    // A tree the API will not serve is refused, not skipped: a run that cannot read one side of the comparison
    // has not made it. THE THREE REFS GET THREE REFUSALS, because which side could not be read is the fact a
    // reader needs and one merged sentence would not carry it.
    if (!onProtected.read) {
      refuse(`the API will not serve the tree of ${onProtected.unread_at ?? seen.dir} on ${protectedRef}, so `
        + `this run cannot establish what ${seen.path} is on the protected branch`);
    }
    if (!candidate.read) {
      refuse(`the API will not serve the tree of ${candidate.unread_at ?? seen.dir} at ${short(candidateSha)}, `
        + `so this run cannot establish what ${seen.path} is at the candidate`);
    }
    if (mergeBase && !base.read) {
      refuse(`the API will not serve the tree of ${base.unread_at ?? seen.dir} at the merge base `
        + `${short(mergeBase)}, so this run cannot establish what ${seen.path} was at the revision the candidate `
        + 'was cut from');
    }

    // A RESPONSE THAT SAYS IT WAS TRUNCATED IS REFUSED, ON EVERY SIDE, AND THIS IS THE ONE PLACE IT MATTERS
    // MOST. An entry missing from a cut-off response may be past the cut rather than absent, and "absent" is
    // the single answer that can make an alteration admissible - so being unable to say must never be read as
    // "not there" here. The response states this itself; nothing below infers it from a count of entries.
    const sides = [['the protected ref', onProtected], ['the candidate', candidate],
      ...(mergeBase ? [[`the merge base ${short(mergeBase)}`, base]] : [])];
    for (const [where, oneSide] of sides) {
      if (oneSide.truncated) {
        refuse(`the tree of ${oneSide.truncated_at} at ${where} answered \`"truncated": true\`, so an entry `
          + 'missing from it may be past the cut rather than absent; this run will not read that as "not there"');
      }
      if (!usable(oneSide)) anythingUnread = true;
    }

    // `change` is named relative to the MERGE BASE, and it is left unknown rather than guessed when a side of
    // the comparison is missing - each of those cases has already produced its own refusal above.
    //
    // MODE IS PART OF THE COMPARISON. Same id and a different mode is a change to the authority: `chmod +x` on
    // the workflow file moves no blob and was admitted by the id alone. A blob id can never equal the tree id
    // it displaced, so replacing the authority directory with a file of the same name was already caught by the
    // id; the mode is the case the id cannot see.
    let change = 'unknown';
    if (mergeBase && usable(base) && usable(candidate)) {
      if (base.sha === candidate.sha && base.mode === candidate.mode) change = 'none';
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
        + `${short(candidate.sha)} at the candidate`
        + (base.mode === candidate.mode ? ''
          : `, and its mode moved from ${base.mode} at the merge base to ${candidate.mode} at the candidate`));
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
      base_mode: base.mode ?? null,
      candidate_mode: candidate.mode ?? null,
      protected_mode: onProtected.mode ?? null,
      change,
    });
  }

  // The two states worth naming on an ADMISSIBLE result, so a reader can tell them apart without reading this
  // file. They are not exclusive: a candidate that predates the authority is also behind the protected ref.
  //
  // NEITHER IS ASSERTED FROM A SIDE THAT WAS NOT READ WHOLE. Both read `null` as "not there", and a tree that
  // was not served - or that said it was cut off - is not evidence of that, so on such a read these two flags
  // are false and the refusals above are what carries the meaning. A flag is only worth having if it is true
  // when it is set.
  const predatesAuthority = !anythingUnread && entries.some(entry => entry.change === 'none'
    && entry.candidate_sha === null && entry.base_sha === null && entry.protected_sha !== null);
  const staleRelativeToProtected = !anythingUnread && entries.some(entry => entry.change === 'none'
    && (entry.candidate_sha !== entry.protected_sha || entry.candidate_mode !== entry.protected_mode));

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

  // One read per tree object, whatever asks for it. `GET /git/trees/{sha}` takes a commit sha or a branch name
  // for the root tree and a tree sha below it, and the two authority entries share `.github` on every ref -
  // and, where the merge base IS the protected ref, share the whole walk. A second fetch is a second chance for
  // the two to disagree, so there is not one. Content addressing does the rest: two refs whose `.github` is the
  // same directory name the same tree id and it is fetched once.
  const trees = new Map();
  const treeAt = async treeish => {
    if (!trees.has(treeish)) trees.set(treeish, await api(`/repos/${repo}/git/trees/${treeish}`));
    return trees.get(treeish);
  };

  // Walk from the ref's root tree down to the tree that would hold `name`, and report that entry's id and mode.
  //
  // A DIRECTORY MISSING FROM A COMPLETE TREE IS AN ANSWER, not a failure to read: if `.github` is not in the
  // root tree then nothing under it exists, and that is precisely the predating candidate's shape. A path
  // segment that is a blob rather than a tree is the same answer for the same reason. What is NOT an answer is
  // a tree the API would not serve, or one that declared itself truncated; both come back as such.
  const entryAt = async (entry, ref) => {
    if (!ref) return UNREAD;
    const segments = entry.dir === '' ? [] : entry.dir.split('/');
    let treeish = ref;
    let walked = 'the repository root';
    for (let depth = 0; ; depth += 1) {
      const tree = await treeAt(treeish);
      if (!tree || !Array.isArray(tree.tree)) return { ...UNREAD, unread_at: walked };
      if (tree.truncated === true) {
        return { ...UNREAD, read: true, truncated: true, truncated_at: walked };
      }
      if (depth === segments.length) {
        const found = tree.tree.find(item => item.path === entry.name);
        return { ...UNREAD, read: true, sha: found?.sha ?? null, mode: found?.mode ?? null };
      }
      const next = tree.tree.find(item => item.path === segments[depth]);
      if (!next || next.type !== 'tree') return { ...UNREAD, read: true };
      treeish = next.sha;
      walked = depth === 0 ? segments[0] : `${walked}/${segments[depth]}`;
    }
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

// THE ONE SENTENCE BOTH CALLERS REFUSE WITH, AND WHY IT IS NOT ONE SENTENCE.
//
// It used to be: "this candidate changes the receipt authority relative to its merge base (<reasons>)". A
// review measured what that says when the comparison could not be made at all - a compare response with no
// `merge_base_commit`, which is what a rate limit or an outage produces - and the log line read "this candidate
// changes the receipt authority relative to its merge base (this run cannot establish the merge base of main
// and ...)". The leading clause asserts as fact the very thing the parenthesis says is unknown, so an outage
// accused an innocent candidate of editing the authority. The refusal is the same either way; the claim is not.
export function authorityRefusalMessage(decision) {
  const determined = decision.entries.some(entry => entry.change === 'added' || entry.change === 'modified'
    || entry.change === 'deleted');
  const lead = determined
    ? 'this candidate changes the receipt authority relative to its merge base'
    : 'this run cannot establish whether this candidate changes the receipt authority';
  return `${lead} (${decision.refuses.map(entry => entry.message).join('; ')}), so no receipt this authority `
    + 'produces may approve it';
}

// What a reader of a log needs to see: the ids the decision was made from, ONE LINE PER AUTHORITY PATH, then
// the verdict. The trust job asserts that count rather than the presence of the header line - see the step in
// .github/workflows/verifier-receipt.yml. Returned rather than printed so the caller owns the stream.
export function renderAuthorityScope(decision) {
  const lines = [`merge base of ${decision.protected_ref} and ${short(decision.candidate_sha)}: `
    + `${decision.merge_base ? short(decision.merge_base) : '<not established>'}`];
  for (const entry of decision.entries) {
    lines.push(`${entry.path}: base=${absentOr(entry.base_sha)}/${entry.base_mode ?? '<absent>'} `
      + `candidate=${absentOr(entry.candidate_sha)}/${entry.candidate_mode ?? '<absent>'} `
      + `${decision.protected_ref}=${absentOr(entry.protected_sha)}/${entry.protected_mode ?? '<absent>'} `
      + `-> ${entry.change}`);
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
    console.error(`::error::${authorityRefusalMessage(decision)}`);
    process.exit(1);
  }
}
