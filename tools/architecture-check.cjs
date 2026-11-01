const fs = require('fs'),
  path = require('path'),
  ts = require('typescript');
const root = process.cwd().replaceAll('\\', '/');
const config = JSON.parse(fs.readFileSync('architecture.config.json', 'utf8'));
const configPath = path.join(root, config.tsconfig);
const raw = ts.readConfigFile(configPath, ts.sys.readFile);
const options = ts.parseJsonConfigFileContent(raw.config, ts.sys, root).options;
const files = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name).replaceAll('\\', '/');
    if (e.isDirectory()) {
      if (e.name !== 'generated') walk(p);
    } else if (/\.tsx?$/.test(p) && !/\.(spec|test|d)\.ts$|\.test\.tsx$/.test(p)) files.push(p);
  }
}
walk(path.join(root, 'src'));
const graph = new Map(),
  errors = [];
for (const file of files) {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const edges = [];
  function visit(node) {
    let literal;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
      literal = node.moduleSpecifier;
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
      literal = node.arguments[0];
    if (literal && ts.isStringLiteral(literal)) {
      const resolved = ts.resolveModuleName(literal.text, file, options, ts.sys).resolvedModule;
      if (resolved && files.includes(resolved.resolvedFileName))
        edges.push(resolved.resolvedFileName);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  graph.set(file, edges);
}
const reachable = new Set();
function reach(file) {
  if (reachable.has(file)) return;
  reachable.add(file);
  for (const next of graph.get(file) || []) reach(next);
}
for (const name of config.entrypoints) {
  const full = path.join(root, name).replaceAll('\\', '/');
  if (!fs.existsSync(full)) errors.push('Missing entrypoint: ' + name);
  else reach(full);
}
for (const file of files)
  if (!reachable.has(file))
    errors.push('Unreachable production file: ' + path.relative(root, file));
// Cycles are checked on value imports only; type-only links do not create a runtime cycle.
const active = new Set(),
  done = new Set();
function check(file) {
  if (active.has(file)) {
    errors.push('Import cycle at ' + path.relative(root, file));
    return;
  }
  if (done.has(file)) return;
  active.add(file);
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  for (const node of source.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
    const c = node.importClause;
    if (
      c?.isTypeOnly ||
      (c?.namedBindings &&
        ts.isNamedImports(c.namedBindings) &&
        !c.name &&
        c.namedBindings.elements.every((e) => e.isTypeOnly))
    )
      continue;
    const r = ts.resolveModuleName(node.moduleSpecifier.text, file, options, ts.sys).resolvedModule;
    if (r && files.includes(r.resolvedFileName)) check(r.resolvedFileName);
  }
  active.delete(file);
  done.add(file);
}
for (const file of files) check(file);
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else
  console.log(
    'Architecture: ' + files.length + ' reachable production files; no static value-import cycle.',
  );
