/**
 * Core data types: SysML v2-like model, typed attributed graph, catalog, rule language L_C.
 * Section 4.5 of the paper.
 */

export type AttrValue = string | number | boolean;

export interface ModelNode {
  id: string;
  type: string;
  attrs: Record<string, AttrValue>;
}

export interface ModelEdge {
  id: string;
  type: string;
  src: string;
  tgt: string;
}

/** SysML v2-like exchange format (JSON). */
export interface SysMLLikeModel {
  id: string;
  nodes: ModelNode[];
  edges: ModelEdge[];
}

/** Typed attributed graph G = (V, E, src, tgt, tau_V, tau_E, A) with adjacency indices. */
export interface TypedGraph {
  id: string;
  nodes: Map<string, ModelNode>;
  edges: Map<string, ModelEdge>;
  /** node id -> outgoing edge ids */
  out: Map<string, string[]>;
  /** node id -> incoming edge ids */
  in: Map<string, string[]>;
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

/** Metamodel catalog C = (T_V, T_E, Allowed, RequiredAttr, Domain, Multiplicity, Acyclic, TracePolicy). */
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

/**
 * Rules of L_C, derived from the catalog.
 * `radius` is the guard-graph diameter k_r (Lemma, section 4.7). Global rules use transitive closure.
 */
export type Rule =
  | { id: string; kind: 'relationType'; radius: 1; global: false; edgeType: string; srcTypes: string[]; tgtTypes: string[] }
  | { id: string; kind: 'requiredAttr'; radius: 0; global: false; nodeType: string; attr: string }
  | { id: string; kind: 'attrDomain'; radius: 0; global: false; nodeType: string; attr: string; domain: DomainSpec }
  | { id: string; kind: 'multiplicity'; radius: 1; global: false; nodeType: string; edgeType: string; dir: 'out' | 'in'; min: number; max: number }
  | { id: string; kind: 'isolated'; radius: 1; global: false; nodeType: string }
  | { id: string; kind: 'viewConsistency'; radius: 2; global: false; policy: ViewPolicySpec }
  | { id: string; kind: 'acyclic'; radius: -1; global: true; edgeType: string }
  | { id: string; kind: 'tracePolicy'; radius: -1; global: true; policy: TracePolicySpec };

export interface Violation {
  ruleId: string;
  kind: Rule['kind'];
  /** witness tuple: element ids, canonically sorted */
  witness: string[];
  message: string;
  /**
   * Grounding anchor: the node that determines whether this violation belongs to the
   * recomputed scope N_k(delta). Not part of the violation identity (Theorem 2).
   */
  anchor: string;
}

export type Change =
  | { kind: 'addNode'; node: ModelNode }
  | { kind: 'delNode'; id: string }
  | { kind: 'setAttr'; id: string; attr: string; value: AttrValue | undefined }
  | { kind: 'addEdge'; edge: ModelEdge }
  | { kind: 'delEdge'; id: string };
