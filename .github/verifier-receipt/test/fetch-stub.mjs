// A stand-in for `fetch` against api.github.com, serving a fixed world from a routes file. Loaded with
// `node --import` in front of a script, so the CLI the trust job actually runs can be exercised end to end -
// its argument handling, its rendering and its exit code - with no token and no network. Anything the world
// does not define answers 404, because that is what the real API does for a path that is not there and
// because a refusal on an undefined endpoint is the fail-closed answer.
import fs from 'node:fs';

const routes = JSON.parse(fs.readFileSync(process.env.FETCH_STUB_ROUTES, 'utf8'));
const notFound = { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };

globalThis.fetch = async request => {
  const url = String(request);
  if (!url.startsWith('https://api.github.com')) {
    throw new Error(`the fetch stub was asked for ${url}, which is not the API this module may read`);
  }
  const endpoint = url.slice('https://api.github.com'.length);
  if (!(endpoint in routes)) return notFound;
  return { ok: true, status: 200, json: async () => routes[endpoint] };
};
