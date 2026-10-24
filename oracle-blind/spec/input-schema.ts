export type AttrValue = string | number | boolean;

export interface ModelNode {
export interface ModelNode {
  id: string;
  id: string;
  type: string;
  type: string;
  attrs: Record<string, AttrValue>;
  attrs: Record<string, AttrValue>;
}
}
export interface ModelEdge {
  id: string;
  type: string;
  src: string;
  tgt: string;
}
export interface SysMLLikeModel {
  id: string;
  nodes: ModelNode[];
  edges: ModelEdge[];
}
export type DomainSpec =
  | { kind: 'enum'; values: AttrValue[] }
  | { kind: 'range'; min: number; max: number }
  | { kind: 'nonEmptyString' };
export interface TracePolicySpec {
  id: string;
  sourceType: string;
  /** edge types usable in the path (path language = (t1|t2|...)+ ) */
  edgeTypes: string[];
  targetType: string;
}
export interface ViewPolicySpec {
  viewType: string;
  subjectEdgeType: string;
  exposeEdgeType: string;
  containEdgeType: string;
}
export interface Catalog {
  id: string;
  nodeTypes: string[];
  edgeTypes: string[];
  /** edge type -> allowed source/target node types */
  allowed: Record<string, { src: string[]; tgt: string[] }>;
  /** node type -> required attribute names */
  requiredAttr: Record<string, string[]>;
  /** "NodeType.attr" -> value domain */
  domain: Record<string, DomainSpec>;
  /** "NodeType|edgeType|out" or "...|in" -> [min, max]; max = -1 means unbounded */
  multiplicity: Record<string, [number, number]>;
  /** edge types that must not contain a cycle */
  acyclic: string[];
  tracePolicy: TracePolicySpec[];
  /** node types that must not be isolated (degree 0) */
  nonIsolated: string[];
  viewPolicy?: ViewPolicySpec;
}
