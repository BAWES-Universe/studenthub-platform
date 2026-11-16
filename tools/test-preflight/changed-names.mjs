import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * Conservative, advisory coverage only: direct node:test imports and literal
 * names whose tokens intersect added lines. Dynamic names, namespace imports,
 * wrappers, re-exports and declarations with shadowed bindings are not inferred.
 * A body-only edit does not claim that a name was added by the diff.
 */
export function changedNames(source, patch) {
  const ts = require('typescript');
  const file = ts.createSourceFile('changed.test.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (file.parseDiagnostics.length) return [];
  const added = addedLines(patch);
  const bindings = new Set();
  for (const node of file.statements) {
    if (!ts.isImportDeclaration(node) || node.moduleSpecifier.text !== 'node:test' || node.importClause?.isTypeOnly) continue;
    const clause = node.importClause;
    if (clause?.name) bindings.add(clause.name.text);
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const item of clause.namedBindings.elements) {
        if (!item.isTypeOnly && ['test', 'it', 'default'].includes((item.propertyName ?? item.name).text)) bindings.add(item.name.text);
      }
    }
  }

  // Reject a binding for the whole file rather than attempting incomplete lexical
  // scope analysis. This intentionally loses coverage, never invents a test name.
  const shadowed = new Set();
  const mark = (name) => {
    if (!name) return;
    if (ts.isIdentifier(name)) { if (bindings.has(name.text)) shadowed.add(name.text); }
    else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const element of name.elements) if (ts.isBindingElement(element)) mark(element.name);
    }
  };
  const scan = (node) => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isFunctionDeclaration(node)
      || ts.isFunctionExpression(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)
      || ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node)) mark(node.name);
    // Reassignment of the imported callable is invalid or ambiguous: do not use it.
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) mark(node.left);
    ts.forEachChild(node, scan);
  };
  scan(file);
  const names = new Set();
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      let callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'only') callee = callee.expression;
      const name = node.arguments[0];
      const options = node.arguments[1];
      const skipped = options && ts.isObjectLiteralExpression(options) && options.properties.some((property) => {
        const key = property.name;
        return key && (ts.isIdentifier(key) || ts.isStringLiteral(key)) && ['skip', 'todo'].includes(key.text);
      });
      if (ts.isIdentifier(callee) && bindings.has(callee.text) && !shadowed.has(callee.text)
        && name && (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) && !skipped) {
        const start = file.getLineAndCharacterOfPosition(name.getStart(file)).line + 1;
        const end = file.getLineAndCharacterOfPosition(name.getEnd() - 1).line + 1;
        for (let line = start; line <= end; line++) if (added.has(line)) { names.add(name.text); break; }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...names];
}

function addedLines(patch) {
  const added = new Set();
  let next = null;
  let remaining = 0;
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) { next = Number(hunk[1]); remaining = hunk[2] === undefined ? 1 : Number(hunk[2]); continue; }
    if (next === null || remaining <= 0) continue;
    if (line.startsWith('+')) { added.add(next++); remaining--; }
    else if (line.startsWith(' ')) { next++; remaining--; }
    else if (!line.startsWith('-') && !line.startsWith('\\')) next = null;
  }
  return added;
}
