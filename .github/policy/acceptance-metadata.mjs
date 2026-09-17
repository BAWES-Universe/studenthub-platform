import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Measured repository grammar, NOT a reconstruction of Linear's private matcher.
// Require a closing verb and reference joined by punctuation or bounded connector
// words. Neutral references are allowed; negated/quoted closing forms still refuse.
const closingVerb = String.raw`\b(?:clos(?:e[sd]?|ing)|fix(?:es|ed|ing)?|resolv(?:e[sd]?|ing)|complet(?:e[sd]?|ing)|finish(?:es|ed|ing)?)\b`;
const separator = String.raw`[\s#:;,()\[\]{}\x60*_'"<>!\-\u2010-\u2015]*`;
const connector = String.raw`(?:only|the|this|that|all|of|work|acceptance|issue|issues|ticket|tickets|for|on|in|and)`;
const reference = String.raw`(?:[a-z][a-z0-9]*\s*[-\u2010-\u2015\u2212]\s*\d+\b|(?:https?:\/\/)?linear\s*\.\s*app\/)`;
const closingReference = new RegExp(`${closingVerb}${separator}(?:${connector}\\b${separator})*${reference}`, 'iu');
export function checkMetadata(pr) {
  if (!pr || typeof pr.title !== 'string' || !pr.title.trim() || typeof pr.body !== 'string') {
    throw Object.assign(new Error('BOARD_METADATA_SHAPE'), { code: 'BOARD_METADATA_SHAPE' });
  }
  const text = `${pr.title}\n${pr.body}`.normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/gu, '');
  if (closingReference.test(text)) {
    throw Object.assign(new Error('BOARD_ACCEPTANCE_REFERENCE'), { code: 'BOARD_ACCEPTANCE_REFERENCE' });
  }
  return { code: 'BOARD_METADATA_ACCEPTED', matcher: 'repository-closing-reference-v2', linear_completion_guard: 'UNRESOLVED' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let event;
    try { event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')); }
    catch { throw Object.assign(new Error('BOARD_METADATA_SHAPE'), { code: 'BOARD_METADATA_SHAPE' }); }
    console.log(JSON.stringify(checkMetadata(event?.pull_request)));
  } catch (error) {
    console.error(JSON.stringify({ code: error.code === 'BOARD_ACCEPTANCE_REFERENCE' ? error.code : 'BOARD_METADATA_SHAPE' }));
    process.exitCode = 1;
  }
}
