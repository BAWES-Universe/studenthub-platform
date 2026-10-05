#!/usr/bin/env node
// A stand-in for `gh api` that serves a fixed world from a routes file. The emitter's tests need no token and
// no network: what they exercise is which facts the emitter insists on, and how it refuses when one of them
// does not match. Anything the world does not define is a 404, because that is what the real API does and
// because a refusal on an undefined endpoint is the fail-closed answer.
import fs from 'node:fs';

const [, , verb, endpoint] = process.argv;
if (verb !== 'api' || !endpoint) {
  process.stderr.write(`gh-stub: unsupported invocation: ${process.argv.slice(2).join(' ')}\n`);
  process.exit(2);
}
const routes = JSON.parse(fs.readFileSync(process.env.GH_STUB_ROUTES, 'utf8'));
const route = routes[endpoint];
if (route === undefined) {
  process.stderr.write(`gh-stub: no such endpoint: ${endpoint}\n`);
  process.exit(1);
}
if (route === null) {
  process.stderr.write(`gh-stub: ${endpoint} is defined as an error\n`);
  process.exit(1);
}
if (route.binary_file) {
  process.stdout.write(fs.readFileSync(route.binary_file));
} else {
  process.stdout.write(JSON.stringify(route.json));
}
