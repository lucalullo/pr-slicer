export const TOOL_VERSION = '0.1.0';
export type ChangeKind = 'add' | 'delete' | 'modify' | 'rename' | 'mode-change' | 'binary';
export type SyntaxKind = 'function' | 'method' | 'class' | 'interface' | 'type' | 'import' | 'export' | 'test' | 'module' | 'file';
export type EdgeKind = 'must_with' | 'before' | 'affinity' | 'separate' | 'unknown';
export interface Evidence { type: string; message: string; symbol?: string; paths?: string[]; details?: Record<string, unknown> }
export interface GitRange { start: number; count: number }
export interface DiffHunk { id: string; oldPath: string | null; newPath: string | null; oldRange: GitRange; newRange: GitRange; lines: string[]; binary: boolean }
export interface FileChange { id: string; oldPath: string | null; newPath: string | null; oldOid: string; newOid: string; oldMode: string; newMode: string; changeKind: ChangeKind; hunks: DiffHunk[]; atomic: boolean; addedLines: number; deletedLines: number; renameScore?: number }
export interface Repository { root: string; gitDir: string; commonDir: string; objectFormat: string; baseRef: string; headRef: string; baseOid: string; mergeBaseOid: string; headOid: string; baseTreeOid: string; headTreeOid: string }
export interface ChangeUnit { id: string; fileId: string; changeKind: ChangeKind; syntaxKind: SyntaxKind; oldPath: string | null; newPath: string | null; hunkIds: string[]; symbolIds: string[]; packageId: string | null; area: string | null; addedLines: number; deletedLines: number; isTest: boolean; isGenerated: boolean; isAtomic: boolean }
export interface ChangeEdge { id: string; from: string; to: string; kind: EdgeKind; weight: number; evidence: Evidence[] }
export interface PlanGroup { id: string; title: string; unitIds: string[]; dependsOn: string[]; files: string[]; addedLines: number; deletedLines: number; reasons: Evidence[] }
export interface Candidate { id: string; groups: PlanGroup[]; cost: number; reasons: Evidence[] }
export interface Check { name: string; command: string; args: string[]; timeoutMs: number }
export interface CheckResult { name: string; status: 'passed' | 'failed' | 'skipped' | 'unavailable' | 'timeout'; exitCode?: number; durationMs?: number; log?: string; message?: string }
export interface Config { schemaVersion: 1; base: string; head: string; language: 'typescript'; limits: { maxGroups: number; targetChangedLines: number; hardMaxChangedLines: number; targetFiles: number; hardMaxFiles: number; maxAnalysisFiles: number; maxFileBytes: number }; paths: { include: string[]; exclude: string[] }; relations: { keepTestsWithImplementation: boolean; testPatterns: string[]; generatedPatterns: string[]; generatedFrom: { source: string; generated: string[] }[] }; areas: { name: string; patterns: string[] }[]; checks: Check[]; environment: { inherit: boolean; allow: string[] }; }
export interface Metrics { reviewability: number; structuralCohesion: number; dependencyIntegrity: number; boundaryConfidence: 'low' | 'medium' | 'high'; verificationCoverage: { passed: number; total: number } }
export interface Verification { status: 'not-run' | 'passed' | 'failed' | 'verification-unavailable'; level: 'reconstructed' | 'syntax' | 'semantic' | 'project'; digest: string; trees: string[]; checks: Record<string, CheckResult[]>; commandsExecuted: boolean }
export interface SlicePlan { schemaVersion: 1; toolVersion: string; repository: Repository; config: Config; analysisMode: 'fast' | 'deep'; status: 'single-change' | 'split-recommended' | 'split-unverified' | 'split-verified' | 'cannot-safely-split'; files: FileChange[]; units: ChangeUnit[]; edges: ChangeEdge[]; groups: PlanGroup[]; candidates: Candidate[]; checks: Record<string, CheckResult[]>; warnings: Evidence[]; metrics: Metrics; verification: Verification; integrity: { finalTreeOid: string; exactReconstruction: boolean; digest: string } }
export interface AnalysisResult { units: ChangeUnit[]; edges: ChangeEdge[]; warnings: Evidence[] }
