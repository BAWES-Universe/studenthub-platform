import { readFileSync, rmSync } from 'node:fs';
const closure = JSON.parse(readFileSync(process.argv[2], 'utf8'));
for (const { name } of closure.workspaces) {
  if (!closure.packages.some(pkg => pkg.name === name)) rmSync(`node_modules/${name}`, { force: true });
}
