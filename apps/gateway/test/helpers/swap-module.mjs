// A module-resolution hook for mutation scripts: every import of a compiled
// module named in the swap map loads the mutated sibling file instead, so
// the running gateway really executes the mutant. Register it with
//   node --import "data:text/javascript,import{register}from'node:module';register(<this file's URL>,{data:<swap map>})"
let swaps = {};
export async function initialize(data) { swaps = data ?? {}; }
export async function resolve(specifier, context, next) {
  const resolved = await next(specifier, context);
  const target = swaps[resolved.url];
  return target && context.parentURL !== target ? { ...resolved, url: target } : resolved;
}
