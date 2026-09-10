import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import type { CheckResult, Evidence } from '../core/model.js';
import { MAX_BLOB_BYTES } from '../git/objects.js';

type SnapshotPrograms = { programs: ts.Program[]; configuredPrograms: ts.Program[]; warnings: Evidence[]; configured: boolean };
type Entries = { files: string[]; directories: string[] };
type MatchFiles = (directory: string, extensions: readonly string[] | undefined, excludes: readonly string[] | undefined,
  includes: readonly string[] | undefined, caseSensitive: boolean, currentDirectory: string, depth: number | undefined,
  entries: (directory: string) => Entries, realpath: (file: string) => string) => string[];

const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const CONFIG = /^(?:ts|js)config(?:\.[^/]+)?\.json$/i;
const MAX_DISCOVERY = 100_000;
const MAX_SOURCE_BYTES = MAX_BLOB_BYTES;
const sourceDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const require = createRequire(import.meta.url);
const libraryDirectory = fs.realpathSync(path.dirname(require.resolve('typescript/lib/typescript.js')));
const contains = (directory: string, file: string): boolean => file === directory || file.startsWith(`${directory}${path.sep}`);

/** All compiler filesystem callbacks pass through this boundary; repository plugins are never loaded. */
function snapshotFilesystem(root: string, warnings: Evidence[]) {
  const directory = fs.realpathSync(path.resolve(root));
  const roots = [directory, libraryDirectory];
  const dependencyLink = path.join(directory, 'node_modules');
  try {
    if (fs.lstatSync(dependencyLink).isSymbolicLink()) roots.push(fs.realpathSync(dependencyLink));
  } catch { /* Dependencies are optional. */ }
  const warned = new Set<string>();
  const warn = (type: string, message: string, file?: string) => {
    const key = `${type}:${file ?? message}`;
    if (warned.has(key)) return;
    warned.add(key);
    warnings.push({ type, message, ...(file ? { paths: [path.relative(directory, file).split(path.sep).join('/')] } : {}) });
  };
  const resolve = (file: string, report = false): string | undefined => {
    const absolute = path.resolve(directory, file);
    if (!roots.some(base => contains(base, absolute))) {
      if (report) warn('blocked-access', 'Compiler access outside the snapshot was blocked.', absolute);
      return undefined;
    }
    try {
      const real = fs.realpathSync(absolute);
      if (roots.some(base => contains(base, real))) return real;
      if (report) warn('blocked-access', 'A symbolic link outside the snapshot was blocked.', absolute);
    } catch { /* Nonexistent files are normal during module resolution. */ }
    return undefined;
  };
  const stat = (file: string): fs.Stats | undefined => {
    const real = resolve(file);
    if (!real) return undefined;
    try { return fs.statSync(real); } catch { return undefined; }
  };
  const fileExists = (file: string): boolean => stat(file)?.isFile() ?? false;
  const directoryExists = (file: string): boolean => stat(file)?.isDirectory() ?? false;
  const readFile = (file: string): string | undefined => {
    const real = resolve(file, true);
    if (!real) return undefined;
    try {
      const info = fs.statSync(real);
      if (!info.isFile()) return undefined;
      if (info.size > MAX_SOURCE_BYTES) {
        warn('analysis-limit', `A compiler input exceeds the ${MAX_SOURCE_BYTES}-byte limit.`, file);
        return undefined;
      }
      const bytes = fs.readFileSync(real);
      if (bytes.includes(0)) { warn('analysis-limit', 'A binary compiler input cannot be analyzed as text.', file); return undefined; }
      try { return sourceDecoder.decode(bytes); } catch (error) { if (!(error instanceof TypeError)) throw error; warn('analysis-limit', 'A compiler input is not valid UTF-8.', file); return undefined; }
    } catch { return undefined; }
  };
  const entries = (folder: string): Entries => {
    const result: Entries = { files: [], directories: [] };
    const real = resolve(folder);
    if (!real) return result;
    try {
      for (const item of fs.readdirSync(real, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (item.name === '.git') continue;
        if (item.isDirectory()) result.directories.push(item.name);
        else if (item.isFile()) result.files.push(item.name);
        else if (item.isSymbolicLink()) {
          const full = path.join(folder, item.name);
          const info = stat(full);
          if (info?.isDirectory()) result.directories.push(item.name);
          else if (info?.isFile()) result.files.push(item.name);
          else if (!resolve(full)) warn('blocked-access', 'An inaccessible symbolic link was excluded from compiler discovery.', full);
        }
      }
    } catch { /* Absent or unreadable directories have no compiler inputs. */ }
    return result;
  };
  const realpath = (file: string): string => resolve(file) ?? path.resolve(directory, file);
  // TypeScript's pinned compiler exports its own glob matcher; the filesystem callbacks remain confined above.
  const matchFiles = (ts as unknown as { matchFiles: MatchFiles }).matchFiles;
  const readDirectory = (folder: string, extensions?: readonly string[], excludes?: readonly string[], includes?: readonly string[], depth?: number): string[] => {
    if (!resolve(folder, true)) return [];
    return matchFiles(folder, extensions, excludes, includes, ts.sys.useCaseSensitiveFileNames, directory, depth, entries, realpath);
  };
  const getDirectories = (folder: string): string[] => entries(folder).directories;
  return { directory, warn, resolve, entries, fileExists, directoryExists, readFile, readDirectory, getDirectories, realpath };
}

function discover(io: ReturnType<typeof snapshotFilesystem>): { configs: string[]; sources: string[] } {
  const configs: string[] = [], sources: string[] = [], seen = new Set<string>();
  let count = 0;
  const pending = [io.directory];
  while (pending.length) {
    const folder = pending.pop()!;
    const real = io.resolve(folder);
    if (!real || seen.has(real)) continue;
    seen.add(real);
    const items = io.entries(folder);
    count += items.files.length + items.directories.length;
    if (count > MAX_DISCOVERY) {
      io.warn('analysis-limit', `Compiler discovery exceeded ${MAX_DISCOVERY} filesystem entries.`);
      break;
    }
    for (const file of items.files) {
      const full = path.join(folder, file);
      if (CONFIG.test(file)) configs.push(full);
      if (SOURCE.test(file)) sources.push(full);
    }
    for (const item of items.directories.reverse()) {
      if (!['node_modules', '.git'].includes(item)) pending.push(path.join(folder, item));
    }
  }
  return { configs: configs.sort(), sources: sources.sort() };
}

function diagnosticText(diagnostic: ts.Diagnostic, root: string): string {
  const text = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
  if (!diagnostic.file) return `TS${diagnostic.code}: ${text}`;
  const location = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
  return `${path.relative(root, diagnostic.file.fileName).split(path.sep).join('/')}:${location.line + 1}:${location.character + 1} TS${diagnostic.code}: ${text}`;
}

export function createSnapshotPrograms(root: string): SnapshotPrograms {
  const warnings: Evidence[] = [], programs: ts.Program[] = [], configuredPrograms: ts.Program[] = [];
  let io: ReturnType<typeof snapshotFilesystem>;
  try { io = snapshotFilesystem(root, warnings); }
  catch (error) {
    return { programs, configuredPrograms, warnings: [{ type: 'program-error', message: `Cannot open snapshot: ${String(error)}` }], configured: false };
  }
  const discovered = discover(io);
  const configQueue = [...discovered.configs], parsed = new Set<string>();
  const parseHost: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames, fileExists: io.fileExists, readFile: io.readFile,
    readDirectory: io.readDirectory, directoryExists: io.directoryExists, realpath: io.realpath,
  };
  const createHost = (options: ts.CompilerOptions): ts.CompilerHost => ({
    fileExists: io.fileExists, readFile: io.readFile, directoryExists: io.directoryExists,
    readDirectory: io.readDirectory, getDirectories: io.getDirectories, realpath: io.realpath,
    getCurrentDirectory: () => io.directory, getCanonicalFileName: file => ts.sys.useCaseSensitiveFileNames ? file : file.toLowerCase(),
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames, getNewLine: () => '\n',
    getDefaultLibFileName: opts => path.join(libraryDirectory, ts.getDefaultLibFileName(opts)),
    getDefaultLibLocation: () => libraryDirectory,
    writeFile: () => { throw new Error('Snapshot compiler emission is disabled.'); },
    getSourceFile: (file, languageVersion, onError) => {
      const source = io.readFile(file);
      if (source === undefined) { onError?.(`Cannot read compiler input: ${file}`); return undefined; }
      return ts.createSourceFile(file, source, languageVersion, true);
    },
  });
  const build = (rootNames: string[], options: ts.CompilerOptions, references?: readonly ts.ProjectReference[], configured = true) => {
    try {
      const safeOptions = { ...options, noEmit: true, plugins: [] };
      const program = ts.createProgram({ rootNames, options: safeOptions, host: createHost(safeOptions), projectReferences: references });
      programs.push(program);
      if (configured) configuredPrograms.push(program);
    } catch (error) { io.warn('program-error', `Cannot construct TypeScript program: ${String(error)}`); }
  };
  while (configQueue.length) {
    const config = configQueue.shift()!;
    const real = io.resolve(config, true);
    if (!real || parsed.has(real)) continue;
    parsed.add(real);
    if (parsed.size > 256) { io.warn('analysis-limit', 'Compiler discovery exceeded 256 project configurations.'); break; }
    const input = ts.readConfigFile(config, io.readFile);
    if (input.error) {
      io.warn('configuration-error', diagnosticText(input.error, io.directory), config);
      continue;
    }
    let project: ts.ParsedCommandLine;
    try {
      project = ts.parseJsonConfigFileContent(input.config, parseHost, path.dirname(config), undefined, config);
    } catch (error) {
      io.warn('configuration-error', `Cannot parse project configuration: ${String(error)}`, config);
      continue;
    }
    for (const error of project.errors) {
      // A reference-only solution or an empty base configuration need not contain direct source files.
      if (error.code === 18003 && !project.fileNames.length) continue;
      io.warn('configuration-error', diagnosticText(error, io.directory), `${config}#${error.code}`);
    }
    const references: ts.ProjectReference[] = [];
    for (const reference of project.projectReferences ?? []) {
      const referenceConfig = ts.resolveProjectReferencePath(reference);
      if (!io.resolve(referenceConfig, true)) {
        io.warn('configuration-error', 'A project reference is missing or outside the snapshot.', referenceConfig);
        continue;
      }
      references.push(reference);
      configQueue.push(referenceConfig);
    }
    if (project.fileNames.length) build(project.fileNames, project.options, references.length ? references : undefined);
  }
  // Parse all uncovered source files as well: config exclusions must not hide syntax errors in changed files.
  const covered = new Set(programs.flatMap(program => program.getSourceFiles().map(file => io.realpath(file.fileName))));
  const uncovered = discovered.sources.filter(file => !covered.has(io.realpath(file)));
  if (uncovered.length || !programs.length) {
    build(uncovered, { allowJs: true, checkJs: false, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext, jsx: ts.JsxEmit.Preserve, types: [], skipLibCheck: true }, undefined, false);
  }
  for (const warning of warnings) warning.message = warning.message.split(io.directory).join('<snapshot>');
  return { programs, configuredPrograms, warnings, configured: parsed.size > 0 };
}

const ENVIRONMENT_DIAGNOSTICS = new Set([2307, 2318, 2688, 2792, 5058, 6053, 6305, 7016]);
const BLOCKING_WARNINGS = new Set(['blocked-access', 'analysis-limit', 'configuration-error', 'program-error']);
function environmentDiagnostic(diagnostic: ts.Diagnostic): boolean {
  // A missing local module is a broken prefix, whereas an absent installed package is an unavailable environment.
  if ((diagnostic.code === 2307 || diagnostic.code === 2792) && /(?:module|file) ['"]\.{1,2}\//i.test(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))) return false;
  return ENVIRONMENT_DIAGNOSTICS.has(diagnostic.code);
}

export function diagnoseSnapshot(root: string, semantic: boolean): { syntax: CheckResult; semantic: CheckResult; warnings: Evidence[] } {
  const started = Date.now();
  const snapshot = createSnapshotPrograms(root);
  const syntaxErrors: ts.Diagnostic[] = [], semanticErrors: ts.Diagnostic[] = [];
  try {
    for (const program of snapshot.programs) {
      syntaxErrors.push(...program.getSyntacticDiagnostics());
      if (semantic && snapshot.configuredPrograms.includes(program)) semanticErrors.push(...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics(), ...program.getSemanticDiagnostics());
    }
  } catch (error) { snapshot.warnings.push({ type: 'program-error', message: `Compiler diagnostics failed: ${String(error)}` }); }
  const render = (diagnostics: readonly ts.Diagnostic[]): string => [...new Set(diagnostics.map(item => diagnosticText(item, path.resolve(root))))].sort().join('\n');
  const syntax: CheckResult = {
    name: 'syntax', status: syntaxErrors.length ? 'failed' : snapshot.programs.length && !snapshot.warnings.some(warning => ['analysis-limit', 'program-error', 'blocked-access'].includes(warning.type)) ? 'passed' : 'unavailable',
    message: `Built-in syntax diagnostics use TypeScript ${ts.version} bundled with PR Slicer, not the project's compiler command.`,
    durationMs: Date.now() - started, ...(syntaxErrors.length ? { log: render(syntaxErrors) } : {}),
  };
  if (!semantic) return { syntax, semantic: { name: 'semantic', status: 'skipped', message: 'Semantic verification was not requested.' }, warnings: snapshot.warnings };
  const unavailable = !snapshot.configured || snapshot.warnings.some(warning => BLOCKING_WARNINGS.has(warning.type))
    || semanticErrors.some(environmentDiagnostic);
  const semanticResult: CheckResult = {
    name: 'semantic', status: unavailable ? 'unavailable' : syntaxErrors.length || semanticErrors.length ? 'failed' : 'passed',
    message: `Built-in semantic diagnostics use TypeScript ${ts.version} bundled with PR Slicer, not the project's compiler command.${unavailable ? !snapshot.configured ? ' No project configuration is available for semantic verification.' : ' Semantic verification requires complete, accessible project configuration, dependencies and type declarations.' : ''}`,
    durationMs: Date.now() - started,
    ...(semanticErrors.length ? { log: render(semanticErrors) } : {}),
  };
  return { syntax, semantic: semanticResult, warnings: snapshot.warnings };
}
