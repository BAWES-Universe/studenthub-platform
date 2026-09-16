import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// A conservative reference ban, NOT a reconstruction of Linear's private matcher.
// No keyword adjacency assumption: references in neutral prose also refuse.
export function checkMetadata(pr) {
  if (!pr || typeof pr.title !== 'string' || !pr.title.trim() || typeof pr.body !== 'string') {
    throw Object.assign(new Error('BOARD_METADATA_SHAPE'), { code: 'BOARD_METADATA_SHAPE' });
  }
  const text = `${pr.title}\n${pr.body}`.normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/gu, '');
  if (/[a-z][a-z0-9]*\s*[-\u2010-\u2015\u2212]\s*\d+/iu.test(text) || /linear\s*\.\s*app/iu.test(text)) {
    throw Object.assign(new Error('BOARD_ACCEPTANCE_REFERENCE'), { code: 'BOARD_ACCEPTANCE_REFERENCE' });
  }
  return { code: 'BOARD_METADATA_ACCEPTED', matcher: 'repository-reference-ban-v1', linear_completion_guard: 'UNRESOLVED' };
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
