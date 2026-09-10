import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { matchesGlob } from '../config/index.js';
import { compare, id } from '../core/hashing.js';
import type { AnalysisResult, ChangeEdge, ChangeUnit, Config, DiffHunk, Evidence, FileChange, SyntaxKind } from '../core/model.js';
import { createSnapshotPrograms } from './program.js';
export { diagnoseSnapshot } from './program.js';

interface FunctionShape { kind: 'function'; parameters: { type: string; optional: boolean; rest: boolean }[]; result: string; generics: string; modifiers: string }
interface ObjectShape { kind: 'object'; members: Record<string, { signature: string; optional: boolean }>; heritage: string; generics: string; modifiers: string }
interface OtherShape { kind: 'other'; text: string }
type Shape = FunctionShape | ObjectShape | OtherShape;
interface Declaration { key: string; name: string; node: ts.Node; kind: SyntaxKind; shape: Shape; signature: string }
interface ImportBinding { local: string; imported: string; target: string | null; module: string; node: ts.Node }
interface Source { path: string; node: ts.SourceFile; checker?: ts.TypeChecker; declarations: Declaration[]; imports: ImportBinding[] }
interface Snapshot { root: string; programs: ts.Program[]; sources: Map<string, Source>; warnings: Evidence[] }
interface UnitFacts { unit: ChangeUnit; oldNodes: ts.Node[]; newNodes: ts.Node[]; oldDeclarations: Map<string, Declaration>; newDeclarations: Map<string, Declaration>; oldReferences: Set<string>; newReferences: Set<string>; oldNames: Set<string>; newNames: Set<string>; oldModules: Set<string>; newModules: Set<string> }
const sourcePattern = /\.[cm]?[jt]sx?$/i;
const slash = (value: string): string => value.split(path.sep).join('/');
const textOf = (node: ts.Node | undefined, source: ts.SourceFile): string => node ? node.getText(source).replace(/\s+/g, ' ').trim() : '';
const unique = (items: string[]): string[] => [...new Set(items)].sort(compare);

export const matchesPattern = matchesGlob;
function matchesAny(file: string, patterns: string[]): boolean { return patterns.some(pattern => matchesPattern(file, pattern)); }

function safeFile(root: string, relative: string): string | undefined {
  const absolute = path.resolve(root, relative), prefix = path.resolve(root) + path.sep;
  if (!absolute.startsWith(prefix)) return undefined;
  try { if (!fs.lstatSync(absolute).isFile() || !fs.realpathSync(absolute).startsWith(fs.realpathSync(root) + path.sep)) return undefined; return absolute; } catch { return undefined; }
}
function readText(root: string, relative: string, maxBytes = 2_000_000): string | undefined {
  const absolute = safeFile(root, relative);
  if (!absolute || fs.statSync(absolute).size > maxBytes) return undefined;
  return fs.readFileSync(absolute, 'utf8');
}
function declarationName(node: ts.Node): string | undefined {
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) return node.name?.text ?? (node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword) ? 'default' : undefined);
  if (ts.isVariableDeclaration(node) || ts.isParameter(node)) return ts.isIdentifier(node.name) ? node.name.text : undefined;
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node) || ts.isPropertyDeclaration(node) || ts.isPropertySignature(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node) || ts.isEnumMember(node) || ts.isModuleDeclaration(node)) return node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) || ts.isNumericLiteral(node.name)) ? node.name.text : undefined;
  return undefined;
}
function declarationKey(node: ts.Node, relative: string): string | undefined {
  const own = declarationName(node); if (!own) return undefined;
  const parts = [own];
  for (let parent = node.parent; parent && !ts.isSourceFile(parent); parent = parent.parent) { const name = declarationName(parent); if (name && !ts.isParameter(parent)) parts.unshift(name); }
  return `${relative}#${parts.join('.')}`;
}
function functionNode(node: ts.Node): ts.SignatureDeclaration | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isMethodSignature(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) || ts.isCallSignatureDeclaration(node) || ts.isConstructSignatureDeclaration(node) || ts.isFunctionTypeNode(node) || ts.isConstructorTypeNode(node)) return node;
  if (ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) return node.initializer;
  return undefined;
}
function shapeOf(node: ts.Node, source: ts.SourceFile, checker?: ts.TypeChecker): Shape {
  const modifierNode = ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent) && ts.isVariableStatement(node.parent.parent) ? node.parent.parent : node;
  const modifiers = ts.canHaveModifiers(modifierNode) ? (ts.getModifiers(modifierNode) ?? []).map(modifier => modifier.kind).sort((a, b) => a - b).join(',') : '';
  const fn = functionNode(node);
  if (fn) {
    const signature = checker?.getSignatureFromDeclaration(fn);
    return { kind: 'function', parameters: fn.parameters.map(parameter => ({ type: parameter.type ? textOf(parameter.type, source) : checker ? checker.typeToString(checker.getTypeAtLocation(parameter)) : 'inferred', optional: !!parameter.questionToken || !!parameter.initializer, rest: !!parameter.dotDotDotToken })), result: fn.type ? textOf(fn.type, source) : signature && checker ? checker.typeToString(checker.getReturnTypeOfSignature(signature)) : 'inferred', generics: fn.typeParameters?.map(parameter => textOf(parameter, source)).join(',') ?? '', modifiers };
  }
  const members = ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) ? node.members : ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type) ? node.type.members : undefined;
  if (members) {
    const output: ObjectShape = { kind: 'object', members: {}, heritage: ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) ? node.heritageClauses?.map(clause => textOf(clause, source)).join(',') ?? '' : '', generics: ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) ? node.typeParameters?.map(parameter => textOf(parameter, source)).join(',') ?? '' : '', modifiers };
    for (const [position, member] of members.entries()) { const name = declarationName(member) ?? `@${member.kind}:${position}`; output.members[name] = { signature: JSON.stringify(shapeOf(member, source, checker)), optional: 'questionToken' in member && !!member.questionToken }; }
    return output;
  }
  if (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isPropertySignature(node) || ts.isParameter(node)) return { kind: 'other', text: modifiers + '|' + (node.type ? textOf(node.type, source) : checker ? checker.typeToString(checker.getTypeAtLocation(node)) : 'inferred') + ('questionToken' in node && node.questionToken ? '?' : '') };
  return { kind: 'other', text: modifiers + '|' + (ts.isTypeAliasDeclaration(node) ? textOf(node.type, source) : textOf(node, source)) };
}
function compatible(before: Shape, after: Shape): boolean {
  if (before.kind === 'function' && after.kind === 'function') return before.modifiers === after.modifiers && before.result === after.result && before.generics === after.generics && after.parameters.length >= before.parameters.length && before.parameters.every((parameter, index) => JSON.stringify(parameter) === JSON.stringify(after.parameters[index])) && after.parameters.slice(before.parameters.length).every(parameter => parameter.optional && !parameter.rest);
  if (before.kind === 'object' && after.kind === 'object') return before.modifiers === after.modifiers && before.heritage === after.heritage && before.generics === after.generics && Object.entries(before.members).every(([name, member]) => JSON.stringify(member) === JSON.stringify(after.members[name])) && Object.entries(after.members).filter(([name]) => !(name in before.members)).every(([, member]) => member.optional);
  return false;
}
function syntaxKind(node: ts.Node): SyntaxKind {
  if (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node) && !!functionNode(node)) return 'function';
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) return 'method';
  if (ts.isClassDeclaration(node)) return 'class';
  if (ts.isInterfaceDeclaration(node)) return 'interface';
  if (ts.isTypeAliasDeclaration(node) || ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) return 'type';
  if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) return 'import';
  if (ts.isExportDeclaration(node) || ts.isExportAssignment(node)) return 'export';
  if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && /^(?:it|test|describe)(?:\.|$)/.test(node.expression.expression.getText())) return 'test';
  return ts.isSourceFile(node) ? 'file' : 'module';
}
function resolveModule(snapshot: Snapshot, file: string, module: string, source?: Source): string | null {
  if (source?.checker) {
    let declaration: ts.Node | undefined;
    const find = (node: ts.Node): void => { if (declaration) return; if (ts.isStringLiteralLike(node) && node.text === module) { const symbol = source.checker!.getSymbolAtLocation(node); declaration = symbol?.declarations?.find(ts.isSourceFile); } ts.forEachChild(node, find); };
    find(source.node);
    if (declaration) { const relative = slash(path.relative(snapshot.root, declaration.getSourceFile().fileName)); if (!relative.startsWith('../') && !path.isAbsolute(relative)) return relative; }
  }
  if (!module.startsWith('.')) return null;
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), module));
  const withoutJs = target.replace(/\.[cm]?jsx?$/, '');
  for (const candidate of unique([target, ...['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.d.ts', '/index.ts', '/index.tsx', '/index.js', '/index.d.ts'].map(extension => withoutJs + extension)])) if (safeFile(snapshot.root, candidate)) return candidate;
  return null;
}
function loadSource(snapshot: Snapshot, file: string, maxBytes: number): Source | undefined {
  if (snapshot.sources.has(file)) return snapshot.sources.get(file);
  const text = readText(snapshot.root, file, maxBytes); if (text === undefined) return undefined;
  const absolute = path.resolve(snapshot.root, file);
  const program = snapshot.programs.find(item => item.getSourceFile(absolute));
  const source: Source = { path: file, node: program?.getSourceFile(absolute) ?? ts.createSourceFile(absolute, text, ts.ScriptTarget.Latest, true), checker: program?.getTypeChecker(), declarations: [], imports: [] };
  const visit = (node: ts.Node): void => {
    if (!ts.isParameter(node)) { const key = declarationKey(node, file); if (key) { const shape = shapeOf(node, source.node, source.checker); source.declarations.push({ key, name: declarationName(node)!, node, kind: syntaxKind(node), shape, signature: JSON.stringify(shape) }); } }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const module = node.moduleSpecifier.text, target = resolveModule(snapshot, file, module, source), clause = node.importClause;
      if (clause?.name) source.imports.push({ local: clause.name.text, imported: 'default', target, module, node });
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) source.imports.push({ local: clause.namedBindings.name.text, imported: '*', target, module, node });
      else if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const element of clause.namedBindings.elements) source.imports.push({ local: element.name.text, imported: element.propertyName?.text ?? element.name.text, target, module, node });
      if (!clause) source.imports.push({ local: '', imported: '*', target, module, node });
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) { const module = node.moduleReference.expression.text; source.imports.push({ local: node.name.text, imported: '*', target: resolveModule(snapshot, file, module, source), module, node }); }
    ts.forEachChild(node, visit);
  };
  visit(source.node); snapshot.sources.set(file, source); return source;
}
function nodesForRange(source: Source | undefined, start: number, count: number): ts.Node[] {
  if (!source || count === 0) return [];
  const end = start + count - 1;
  const contains = (node: ts.Node): boolean => source.node.getLineAndCharacterOfPosition(node.getStart(source.node)).line + 1 <= start && source.node.getLineAndCharacterOfPosition(Math.max(node.getStart(source.node), node.end - 1)).line + 1 >= end;
  let best: ts.Node = source.node;
  const visit = (node: ts.Node): void => { if (!contains(node)) return; if (declarationName(node) && !ts.isParameter(node) || ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isExportAssignment(node) || ts.isExpressionStatement(node) || node.parent === source.node) if (node.end - node.getStart(source.node) <= best.end - best.getStart(source.node)) best = node; ts.forEachChild(node, visit); };
  visit(source.node); return [best];
}
function nodeIdentity(node: ts.Node, file: string): string { return declarationKey(node, file) ?? `${file}@${node.kind}:${node.pos}`; }
function intersects(node: ts.Node, selected: ts.Node[]): boolean { return selected.some(parent => node.pos >= parent.pos && node.end <= parent.end || parent.pos >= node.pos && parent.end <= node.end); }
function declarationsFor(source: Source | undefined, keys: Set<string>): Map<string, Declaration> {
  const result = new Map<string, Declaration>();
  for (const declaration of source?.declarations ?? []) if (keys.has(declaration.key)) {
    const previous = result.get(declaration.key);
    if (!previous) result.set(declaration.key, declaration);
    else { const shape: OtherShape = { kind: 'other', text: previous.signature + '\n' + declaration.signature }; result.set(declaration.key, { ...previous, shape, signature: shape.text }); }
  }
  return result;
}
function gatherReferences(snapshot: Snapshot, source: Source | undefined, selected: ts.Node[]): { references: Set<string>; names: Set<string>; modules: Set<string> } {
  const references = new Set<string>(), names = new Set<string>(), modules = new Set<string>(); if (!source) return { references, names, modules };
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      names.add(node.text);
      let resolved = false;
      if (source.checker) {
        let symbol = source.checker.getSymbolAtLocation(node);
        if (symbol?.flags && symbol.flags & ts.SymbolFlags.Alias) { try { symbol = source.checker.getAliasedSymbol(symbol); } catch { /* An unresolved alias falls back to direct import evidence. */ } }
        for (const declaration of symbol?.declarations ?? []) { const relative = slash(path.relative(snapshot.root, declaration.getSourceFile().fileName)); if (relative.startsWith('../') || path.isAbsolute(relative) || relative.startsWith('node_modules/')) continue; const key = declarationKey(declaration, relative); if (key) { references.add(key); resolved = true; } }
      }
      if (!resolved) {
        for (const declaration of source.declarations.filter(item => item.name === node.text)) references.add(declaration.key);
        for (const binding of source.imports.filter(item => item.local === node.text && item.target)) {
          modules.add(binding.target!);
          if (binding.imported !== '*') references.add(`${binding.target}#${binding.imported}`);
          else if (ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node) references.add(`${binding.target}#${node.parent.name.text}`);
        }
      }
    }
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) { const target = resolveModule(snapshot, source.path, node.moduleSpecifier.text, source); if (target) modules.add(target); }
    if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) { const target = resolveModule(snapshot, source.path, node.arguments[0].text, source); if (target) modules.add(target); }
    ts.forEachChild(node, visit);
  };
  for (const node of selected) visit(node);
  return { references, names, modules };
}
function packageFor(root: string, file: string): string | null {
  let directory = path.posix.dirname(file);
  for (;;) { const content = readText(root, path.posix.join(directory, 'package.json')); if (content) { try { const manifest = JSON.parse(content) as { name?: unknown }; return typeof manifest.name === 'string' ? manifest.name : directory === '.' ? '(root)' : directory; } catch { return directory === '.' ? '(root)' : directory; } } if (directory === '.') return null; directory = path.posix.dirname(directory); }
}
function changedLines(hunks: DiffHunk[], prefix: string): number { return hunks.reduce((sum, hunk) => sum + hunk.lines.filter(line => line.startsWith(prefix)).length, 0); }

/** Build conservative AST units and evidence-backed dependency edges from immutable snapshots. */
export function analyzeChanges(files: FileChange[], baseRoot: string, headRoot: string, config: Config, mode: 'fast' | 'deep'): AnalysisResult {
  const coarse = files.length > config.limits.maxAnalysisFiles;
  const basePrograms = mode === 'deep' && !coarse ? createSnapshotPrograms(baseRoot) : { programs: [], warnings: [], configured: false };
  const headPrograms = mode === 'deep' && !coarse ? createSnapshotPrograms(headRoot) : { programs: [], warnings: [], configured: false };
  const base: Snapshot = { root: baseRoot, programs: basePrograms.programs, warnings: basePrograms.warnings, sources: new Map() }, head: Snapshot = { root: headRoot, programs: headPrograms.programs, warnings: headPrograms.warnings, sources: new Map() };
  const warnings: Evidence[] = [...base.warnings, ...head.warnings], facts: UnitFacts[] = [];
  if (mode === 'fast') warnings.push({ type: 'analysis-fast', message: 'Fast analysis uses changed-file AST and direct imports; aliases, inferred types and transitive references are not fully resolved.' });
  if (mode === 'deep' && !coarse && (!basePrograms.configured || !headPrograms.configured)) warnings.push({ type: 'semantic-unavailable', message: 'One or both snapshots have no TypeScript/JavaScript project configuration; AST and direct imports are used for those files.' });
  if (coarse) warnings.push({ type: 'analysis-limit', message: `The diff exceeds maxAnalysisFiles (${config.limits.maxAnalysisFiles}); files are kept atomic.` });
  for (const file of [...files].sort((a, b) => compare(a.newPath ?? a.oldPath!, b.newPath ?? b.oldPath!))) {
    const relative = file.newPath ?? file.oldPath!;
    const excluded = config.paths.include.length > 0 && !matchesAny(relative, config.paths.include) || matchesAny(relative, config.paths.exclude);
    const generated = matchesAny(relative, config.relations.generatedPatterns) || config.relations.generatedFrom.some(rule => matchesAny(relative, rule.generated));
    const isTest = matchesAny(relative, config.relations.testPatterns);
    const eligible = sourcePattern.test(relative) && !excluded && !coarse && !generated && file.oldMode !== '120000' && file.newMode !== '120000' && file.oldMode !== '160000' && file.newMode !== '160000' && file.changeKind !== 'binary' && !file.hunks.some(hunk => hunk.binary);
    const oldSource = eligible && file.oldPath ? loadSource(base, file.oldPath, config.limits.maxFileBytes) : undefined;
    const newSource = eligible && file.newPath ? loadSource(head, file.newPath, config.limits.maxFileBytes) : undefined;
    const opaque = !eligible || (!oldSource && !!file.oldPath) || (!newSource && !!file.newPath);
    const atomic = file.atomic || file.changeKind !== 'modify' || opaque || generated;
    if (excluded) warnings.push({ type: 'excluded-opaque', message: 'Excluded from semantic analysis; the complete file change remains in the reconstruction.', paths: [relative] });
    else if (eligible && opaque) warnings.push({ type: 'opaque-source', message: 'Source is unavailable, oversized or not a regular snapshot file; the complete change is atomic.', paths: [relative] });
    const groups: { hunks: DiffHunk[]; oldNodes: ts.Node[]; newNodes: ts.Node[] }[] = [];
    if (atomic || file.hunks.length === 0) groups.push({ hunks: file.hunks, oldNodes: oldSource ? [oldSource.node] : [], newNodes: newSource ? [newSource.node] : [] });
    else {
      const entries = file.hunks.map(hunk => ({ hunks: [hunk], oldNodes: nodesForRange(oldSource, hunk.oldRange.start, hunk.oldRange.count), newNodes: nodesForRange(newSource, hunk.newRange.start, hunk.newRange.count) }));
      // Union on either side: a declaration can be split or renamed by the change itself.
      for (const entry of entries) {
        let combined = entry, again = true;
        while (again) { again = false; for (let i = groups.length - 1; i >= 0; i--) { const prior = groups[i]!, intersectsSide = (a: ts.Node[], b: ts.Node[], filePath: string | null): boolean => a.some(node => b.some(other => nodeIdentity(node, filePath!) === nodeIdentity(other, filePath!) || node.pos <= other.pos && node.end >= other.end || other.pos <= node.pos && other.end >= node.end)); if (intersectsSide(combined.oldNodes, prior.oldNodes, file.oldPath) || intersectsSide(combined.newNodes, prior.newNodes, file.newPath)) { combined = { hunks: [...prior.hunks, ...combined.hunks], oldNodes: [...new Set([...prior.oldNodes, ...combined.oldNodes])], newNodes: [...new Set([...prior.newNodes, ...combined.newNodes])] }; groups.splice(i, 1); again = true; } } }
        groups.push(combined);
      }
    }
    for (const group of groups) {
      const touchedKeys = new Set([...(oldSource?.declarations ?? []).filter(declaration => intersects(declaration.node, group.oldNodes)), ...(newSource?.declarations ?? []).filter(declaration => intersects(declaration.node, group.newNodes))].map(declaration => declaration.key));
      const oldDeclarations = declarationsFor(oldSource, touchedKeys), newDeclarations = declarationsFor(newSource, touchedKeys);
      const hunkIds = group.hunks.map(hunk => hunk.id).sort(compare), selected = group.newNodes[0] ?? group.oldNodes[0];
      const unit: ChangeUnit = { id: id('cu', { file: file.id, hunks: hunkIds }), fileId: file.id, changeKind: file.changeKind, syntaxKind: opaque ? 'file' : selected ? syntaxKind(selected) : 'file', oldPath: file.oldPath, newPath: file.newPath, hunkIds, symbolIds: unique([...oldDeclarations.keys(), ...newDeclarations.keys()]), packageId: packageFor(headRoot, relative) ?? packageFor(baseRoot, file.oldPath ?? relative), area: config.areas.find(area => matchesAny(relative, area.patterns))?.name ?? null, addedLines: atomic ? file.addedLines : changedLines(group.hunks, '+'), deletedLines: atomic ? file.deletedLines : changedLines(group.hunks, '-'), isTest, isGenerated: generated, isAtomic: atomic };
      const oldRefs = gatherReferences(base, oldSource, group.oldNodes), newRefs = gatherReferences(head, newSource, group.newNodes);
      facts.push({ unit, ...group, oldDeclarations, newDeclarations, oldReferences: oldRefs.references, newReferences: newRefs.references, oldNames: oldRefs.names, newNames: newRefs.names, oldModules: oldRefs.modules, newModules: newRefs.modules });
    }
  }
  const edgeMap = new Map<string, ChangeEdge>();
  const edge = (from: ChangeUnit, to: ChangeUnit, kind: ChangeEdge['kind'], weight: number, evidence: Evidence): void => {
    if (from.id === to.id) return;
    let a = from.id, b = to.id; if (kind !== 'before' && compare(a, b) > 0) [a, b] = [b, a];
    const key = `${a}:${b}:${kind}`, existing = edgeMap.get(key);
    if (existing) { existing.weight = Math.max(existing.weight, weight); if (!existing.evidence.some(item => JSON.stringify(item) === JSON.stringify(evidence))) existing.evidence.push(evidence); }
    else edgeMap.set(key, { id: id('edge', key), from: a, to: b, kind, weight, evidence: [evidence] });
  };
  // Index hard relations. Large diffs retain those edges while soft cohesion uses adjacent peers.
  const byReference = new Map<string, Set<UnitFacts>>(), byModule = new Map<string, Set<UnitFacts>>(), byPath = new Map<string, Set<UnitFacts>>(), byArea = new Map<string, UnitFacts[]>(), byPackage = new Map<string, UnitFacts[]>();
  const index = (map: Map<string, Set<UnitFacts>>, key: string, fact: UnitFacts): void => { if (!map.has(key)) map.set(key, new Set()); map.get(key)!.add(fact); };
  for (const fact of facts) {
    for (const reference of new Set([...fact.oldReferences, ...fact.newReferences])) { index(byReference, reference, fact); index(byModule, reference.split('#')[0]!, fact); }
    for (const module of new Set([...fact.oldModules, ...fact.newModules])) index(byModule, module, fact);
    for (const filePath of new Set([fact.unit.oldPath, fact.unit.newPath])) if (filePath) index(byPath, filePath, fact);
    for (const [map, key] of [[byArea, fact.unit.area], [byPackage, fact.unit.packageId]] as const) if (key) { if (!map.has(key)) map.set(key, []); map.get(key)!.push(fact); }
  }
  const related = (provider: UnitFacts): UnitFacts[] => {
    if (facts.length <= 200) return facts;
    const peers = new Set<UnitFacts>(), add = (items?: Iterable<UnitFacts>): void => { for (const item of items ?? []) peers.add(item); };
    for (const key of new Set([...provider.oldDeclarations.keys(), ...provider.newDeclarations.keys()])) add(byReference.get(key));
    for (const filePath of [provider.unit.oldPath, provider.unit.newPath]) if (filePath) { add(byModule.get(filePath)); add(byPath.get(filePath)); }
    for (const [map, key] of [[byArea, provider.unit.area], [byPackage, provider.unit.packageId]] as const) if (key) { const group = map.get(key)!; const position = group.indexOf(provider); add(group.slice(Math.max(0, position - 1), position + 2)); }
    const filePath = provider.unit.newPath ?? provider.unit.oldPath!;
    for (const rule of config.relations.generatedFrom) if (matchesPattern(filePath, rule.source)) add(facts.filter(fact => matchesAny(fact.unit.newPath ?? fact.unit.oldPath!, rule.generated)));
    if (path.posix.basename(filePath) === 'package.json') add(facts);
    return [...peers];
  };
  if (facts.length > 200) warnings.push({ type: 'sparse-affinity', message: 'Large-change cohesion uses adjacent area/package peers; observed hard dependencies are preserved.' });
  for (const provider of facts) for (const consumer of related(provider)) {
    if (provider === consumer) continue;
    const from = provider.unit, to = consumer.unit, providerPath = from.newPath ?? from.oldPath!, consumerPath = to.newPath ?? to.oldPath!, paths = [providerPath, consumerPath];
    const introduced = [...provider.newDeclarations.values()].filter(declaration => !provider.oldDeclarations.has(declaration.key));
    const removed = [...provider.oldDeclarations.values()].filter(declaration => !provider.newDeclarations.has(declaration.key));
    for (const declaration of introduced) if (consumer.newReferences.has(declaration.key)) edge(from, to, 'before', 95, { type: 'new-symbol-reference', message: `${declaration.key} is introduced before its changed consumer.`, symbol: declaration.key, paths });
    for (const declaration of removed) if (consumer.oldReferences.has(declaration.key)) edge(to, from, consumer.newReferences.has(declaration.key) ? 'must_with' : 'before', 95, { type: 'removed-symbol-reference', message: `${declaration.key} must remain available until its consumer is removed or migrated.`, symbol: declaration.key, paths });
    for (const [key, before] of provider.oldDeclarations) {
      const after = provider.newDeclarations.get(key); if (!after || !consumer.oldReferences.has(key) && !consumer.newReferences.has(key)) continue;
      if (before.signature !== after.signature) { const isCompatible = compatible(before.shape, after.shape); edge(from, to, isCompatible ? 'before' : 'must_with', isCompatible ? 90 : 100, { type: isCompatible ? 'compatible-signature-change' : 'incompatible-signature-change', message: isCompatible ? `${key} adds optional parameters or fields before updated consumers.` : `${key} changes its signature; affected changed consumers remain in the same slice.`, symbol: key, paths }); }
      else edge(from, to, 'affinity', 40, { type: 'changed-symbol-reference', message: `${consumerPath} references the changed declaration ${key}; preserving its signature does not establish behavioral equivalence.`, symbol: key, paths });
    }
    const referencesProvider = [...consumer.newReferences, ...consumer.oldReferences].some(reference => reference.startsWith(`${from.newPath}#`) || reference.startsWith(`${from.oldPath}#`)) || consumer.newModules.has(providerPath) || !!from.oldPath && consumer.oldModules.has(from.oldPath);
    if (from.changeKind === 'rename' && referencesProvider) edge(from, to, 'must_with', 100, { type: 'rename-reference', message: 'File rename and changed references are atomic together.', paths });
    if (from.changeKind === 'add' && consumer.newModules.has(providerPath)) edge(from, to, 'before', 90, { type: 'new-module-import', message: 'The imported module must exist before its changed importer.', paths });
    if (from.changeKind === 'delete' && from.oldPath && consumer.oldModules.has(from.oldPath)) edge(to, from, 'before', 90, { type: 'removed-module-import', message: 'Migrate the importer before removing its module.', paths });
    if (config.relations.keepTestsWithImplementation && !from.isTest && to.isTest && referencesProvider) {
      const providers = facts.filter(candidate => !candidate.unit.isTest && candidate !== consumer && [...consumer.newReferences].some(reference => [...candidate.newDeclarations.keys()].includes(reference)));
      const exclusiveIntroduction = to.changeKind === 'add' && introduced.some(declaration => consumer.newReferences.has(declaration.key)) && new Set(providers.map(candidate => candidate.unit.id)).size === 1;
      edge(from, to, exclusiveIntroduction ? 'must_with' : 'affinity', exclusiveIntroduction ? 100 : 90, { type: exclusiveIntroduction ? 'exclusive-new-symbol-test' : 'implementation-test', message: exclusiveIntroduction ? 'The new test references exactly one changed implementation introducing its subject.' : 'Test and changed implementation share an observed import or symbol reference.', paths });
    }
    if (providerPath === consumerPath) {
      edge(from, to, 'affinity', 20, { type: 'same-module', message: 'Changes belong to the same module.', paths: [providerPath] });
      const beforeImports = base.sources.get(from.oldPath ?? '')?.imports.filter(binding => intersects(binding.node, provider.oldNodes)) ?? [], afterImports = head.sources.get(from.newPath ?? '')?.imports.filter(binding => intersects(binding.node, provider.newNodes)) ?? [];
      for (const binding of afterImports) if (binding.local && consumer.newNames.has(binding.local) && !beforeImports.some(old => old.local === binding.local && old.module === binding.module && old.imported === binding.imported)) edge(from, to, beforeImports.some(old => old.local === binding.local) ? 'must_with' : 'before', 95, { type: 'import-binding-change', message: `Import binding ${binding.local} is required by the changed consumer.`, symbol: binding.local, paths: [providerPath] });
      for (const binding of beforeImports) if (binding.local && consumer.oldNames.has(binding.local) && !afterImports.some(current => current.local === binding.local)) edge(to, from, 'before', 95, { type: 'removed-import-binding', message: `Migrate uses of ${binding.local} before removing its import.`, symbol: binding.local, paths: [providerPath] });
    }
    else if (from.area && from.area === to.area) edge(from, to, 'affinity', 30, { type: 'configured-area', message: `Both changes belong to configured area ${from.area}.`, paths });
    else if (from.packageId && from.packageId === to.packageId) edge(from, to, 'affinity', 5, { type: 'same-package', message: `Both changes belong to package ${from.packageId}.`, paths });
    for (const rule of config.relations.generatedFrom) if (matchesPattern(providerPath, rule.source) && matchesAny(consumerPath, rule.generated)) edge(from, to, 'must_with', 100, { type: 'generated-from', message: 'Configured generated output is kept with its changed source.', paths });
    if (path.posix.basename(providerPath) === 'package.json') {
      const directory = path.posix.dirname(providerPath), isLock = /^(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/.test(path.posix.basename(consumerPath));
      if (isLock && (path.posix.dirname(consumerPath) === directory || path.posix.dirname(consumerPath) === '.')) edge(from, to, 'must_with', 100, { type: 'manifest-lockfile', message: 'The changed package manifest and workspace lockfile must stay together.', paths });
      const dependencies = (root: string, filePath: string | null): Record<string, unknown> => { try { const manifest = JSON.parse(filePath ? readText(root, filePath) ?? '{}' : '{}') as Record<string, Record<string, unknown>>; return { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies }; } catch { return {}; } };
      const previous = dependencies(baseRoot, from.oldPath), current = dependencies(headRoot, from.newPath), imports = head.sources.get(to.newPath ?? '')?.imports ?? [], previousImports = base.sources.get(to.oldPath ?? '')?.imports ?? [];
      for (const dependency of Object.keys(current).filter(name => !(name in previous))) if (imports.some(binding => binding.module === dependency || binding.module.startsWith(dependency + '/')) && (directory === '.' || consumerPath.startsWith(directory + '/'))) edge(from, to, 'before', 95, { type: 'new-package-dependency', message: `Declare dependency ${dependency} before importing it.`, symbol: dependency, paths });
      for (const dependency of Object.keys(previous).filter(name => !(name in current))) if (previousImports.some(binding => binding.module === dependency || binding.module.startsWith(dependency + '/')) && (directory === '.' || consumerPath.startsWith(directory + '/'))) edge(to, from, 'before', 95, { type: 'removed-package-dependency', message: `Migrate imports of ${dependency} before removing the dependency declaration.`, symbol: dependency, paths });
    }
  }
  const unitList = facts.map(fact => fact.unit).sort((a, b) => compare(a.newPath ?? a.oldPath!, b.newPath ?? b.oldPath!) || compare(a.id, b.id));
  // Atomic path transitions (file <-> directory, delete+rename destination) share a boundary.
  const pathOwners = new Map<string, ChangeUnit[]>();
  for (const unit of unitList) for (const filePath of new Set([unit.oldPath, unit.newPath])) if (filePath) {
    const owners = pathOwners.get(filePath) ?? []; owners.push(unit); pathOwners.set(filePath, owners);
  }
  for (const unit of unitList) for (const filePath of new Set([unit.oldPath, unit.newPath])) if (filePath) {
    const parts = filePath.split('/');
    for (let length = 1; length <= parts.length; length++) for (const owner of pathOwners.get(parts.slice(0, length).join('/')) ?? []) {
      if (unit.fileId !== owner.fileId) edge(owner, unit, 'must_with', 100, { type: 'atomic-path-transition', message: 'Overlapping old/new paths or a file/directory transition share one atomic boundary.', paths: [owner.newPath ?? owner.oldPath!, filePath] });
    }
  }
  const edgeList = [...edgeMap.values()].sort((a, b) => compare(a.id, b.id));
  for (const item of edgeList) item.evidence.sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
  return { units: unitList, edges: edgeList, warnings: [...new Map(warnings.map(warning => [JSON.stringify(warning), warning])).values()].sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b))) };
}
