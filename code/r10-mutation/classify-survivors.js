#!/usr/bin/env node
'use strict';
/**
 * R10 classification of the 128 R8 survivors (results-v4/mutation/m4-mutation-analysis.json).
 *
 *   node r10-mutation/classify-survivors.js <r10 mutation json> <oracle replay json> <out json>
 *
 * Classes (code-review judgment, not a proof; mechanical evidence attached where it exists):
 *   B   discrimination gap of the R8 harness: killed by the R10 stages (killedBy from the R10 run)
 *   EQ  equivalent: no input admitted by the documented API changes any observable result
 *       (unreachable branch, fall-through into a no-op case, dead function, invariant-protected
 *       guard, identical exception). Sub-reason in `why`.
 *   EQC output-equivalent: violation sets, graph and every checked contract are unchanged; only
 *       internal work counters / store layout differ (cost-only)
 *   C   shared code (rule derivation and value domains used by both engine and reference):
 *       invisible to engine-vs-reference by construction; oracle replay result attached
 */
const fs = require('fs');

const [r10File, replayFile, outFile] = process.argv.slice(2);
if (fs.existsSync(outFile)) throw new Error(`refusing to overwrite ${outFile}`);
const r8 = JSON.parse(fs.readFileSync(`${__dirname}/../results-v4/mutation/m4-mutation-analysis.json`, 'utf8'));
const r10 = JSON.parse(fs.readFileSync(r10File, 'utf8'));
const replay = JSON.parse(fs.readFileSync(replayFile, 'utf8'));
const r10ById = new Map(r10.mutants.map((m) => [m.id, m]));
const repById = new Map(replay.rows.map((r) => [r.id, r]));

const EQ = {
  27: 'holds(): default branch unreachable, holds is only called for local rule kinds',
  59: 'BFS `head <= queue.length`: the extra iteration reads undefined and scans nothing',
  82: 'anchor index: a key with two anchors arises only for VIEW (v1,v2)/(v2,v1); a change that can alter either grounding has support within distance 1 of both, so both anchors are in S (k = 2) and the key is re-derived; equivalent for the current rule language',
  107: 'delEdge guard unreachable: expand() emits delEdge only for an edge present at expansion time and applies it immediately',
  113: 'fall-through from delEdge into delNode case: p.id is undefined, nodes.has(undefined) is false, break',
  115: 'delNode guard unreachable: expand() emits delNode only for a present node',
  119: 'fall-through from delNode into setAttr on the removed node: setAttr ignores a missing node',
  120: 'break removed after the last switch case',
  135: 'default configuration takes the eager branch: same local set (eager and indexed removal are both checked in R10-SES), only the materialisation time differs',
  150: 'version counter decremented instead of incremented: values stay distinct per step, the stale-read check is unchanged',
  155: 'cidOf: `v === null && v === undefined` is false, compId.get(null) is undefined either way',
  178: 'slice(): non-null order entries are always live nodes (onDelNode writes a tombstone)',
  179: 'slice(): same invariant as 178',
  194: 'onDelNode: incident edges are deleted first (Expand order), so the node is a trivial component when it is removed',
  195: 'same as 194',
  196: 'onAddEdge: endpoints are always registered (addNode precedes, rebuild registers all), onAddNode returns immediately',
  197: 'same as 196',
  202: 'pu === pv only when u === v, handled before',
  204: 'onDelEdge: both endpoints are always registered (edges are deleted before nodes)',
  206: 'self loop falls through to the same-component branch, which reindexes the same range',
  207: 'same as 206',
  210: 'sort tie impossible: distinct components have disjoint member lists',
  259: 'report(): violating never holds a deleted node (onDelNode removes it)',
  260: 'sort tie impossible: node ids are unique',
  297: 'maxLocalRadius: `>=` yields the same maximum',
  302: 'inDomain(undefined): every caller (engine, engineCsr, reference, specEngine) tests undefined first',
  312: 'setEqual has no caller in the code base (dead function)',
  313: 'setEqual dead function',
  314: 'setEqual dead function',
  315: 'setEqual dead function',
  316: 'setEqual dead function',
  317: 'setEqual dead function',
  332: 'duplicate node id: InputError with the same defect list is thrown whether or not the later node overwrites the first',
  334: 'duplicate edge id: same InputError is thrown at the end of normalisation',
  372: 'applyChanges fall-through from delNode into setAttr on the removed node: no-op, duplicate id in a Set',
  375: 'applyChanges fall-through from addEdge into delEdge with c.id undefined: no-op',
  377: 'break removed after the last switch case',
  378: 'changeSupportNodes fall-through: adds undefined, which kHopNodes ignores',
  379: 'changeSupportNodes: endpoints of the deleted node’s edges are within distance 1 of the node and are added again from the post-state primitives; scope unchanged (checked by the scope specification in R10-SES)',
  380: 'fall-through adds the same id twice to a Set',
  382: 'fall-through into delEdge with c.id undefined: no-op',
  384: 'break removed after the last switch case',
};
// 193 is the acyclic `if (!this.pos.has(v)) return` negation: the deleted node keeps a stale
// position/component id; its edges were removed first, so it is a trivial singleton and the
// stale slot is filtered by slice(); id reuse re-registers nothing but needs no edge invariant.
EQ[193] = 'acyclic onDelNode negated: the deleted node keeps a stale slot as an edge-less trivial singleton (edges removed first, slice() filters non-nodes); re-adding the id needs no ordering constraint';

const EQC = {
  95: 'invalid store also notified of addNode; invalid stores are rebuilt in the same step',
  101: 'invalid store also notified of addEdge; rebuilt in the same step',
  109: 'invalid store also notified of delEdge; rebuilt in the same step',
  117: 'invalid store also notified of delNode; rebuilt in the same step',
  153: 'cidOf always undefined: the reindex interval widens to the whole order (correct, more work)',
  154: 'same as 153',
  156: 'lower expansion one step past 0: interval starts at -1, positions stay ordered (more work)',
  159: 'lower expansion crosses other components: interval over-expanded, still whole components',
  165: 'upper expansion one step past the end: a trailing tombstone slot is added',
  166: 'same as 165, two slots',
  168: 'upper expansion crosses other components (as 159)',
  219: 'rebuild BFS one extra empty iteration (work +1)',
  230: 'propagateFrom one extra empty iteration (work +1)',
  245: 'invalidate keeps stale child links; later over-invalidation is re-resolved (reresolve + propagateFrom)',
  246: 'same as 245',
  249: 're-resolution of already reaching nodes: evidence re-set, stale child links only',
  254: 're-resolution continues after the first evidence edge: extra child links only',
};

const C = new Set([294, 295, 304, 305, 306, 307, 309, 310, 311]);

const rows = [];
for (const s of r8.survivors) {
  const m = r10ById.get(s.id);
  const killed = m && m.killedBy !== null && m.killedBy.match(/R10/);
  let cls;
  let why;
  if (killed) {
    cls = 'B';
    why = `killed by ${m.killedBy}: ${m.detail.slice(0, 160)}`;
  } else if (m && m.killedBy !== null) {
    cls = 'B';
    why = `killed by ${m.killedBy} (R8 stage, non-deterministic timing?)`;
  } else if (C.has(s.id)) {
    cls = 'C';
    why = 'shared rule-derivation/value-domain code (catalog/rules.ts)';
  } else if (EQ[s.id]) {
    cls = 'EQ';
    why = EQ[s.id];
  } else if (EQC[s.id]) {
    cls = 'EQC';
    why = EQC[s.id];
  } else {
    cls = 'UNCLASSIFIED';
    why = '';
  }
  const rep = repById.get(s.id);
  rows.push({ ...s, r10KilledBy: m ? m.killedBy : 'not run', class: cls, why, oracleReplay: rep ? { caughtShacl: rep.caughtO, caughtBlind: rep.caughtB, crashes: rep.crashes, engineVsReference: rep.engineVsReference, cases: rep.cases } : null });
}
const count = (f) => rows.filter(f).length;
const summary = {
  survivorsR8: rows.length,
  B: count((r) => r.class === 'B'),
  EQ: count((r) => r.class === 'EQ'),
  EQC: count((r) => r.class === 'EQC'),
  C: count((r) => r.class === 'C'),
  C_caughtByShacl: count((r) => r.class === 'C' && r.oracleReplay && r.oracleReplay.caughtShacl > 0),
  C_caughtByBlind: count((r) => r.class === 'C' && r.oracleReplay && r.oracleReplay.caughtBlind > 0),
  unclassified: count((r) => r.class === 'UNCLASSIFIED'),
  newR8Code: count((r) => [82, 135, 136, 150].includes(r.id) || (r.file === 'model/graph.ts' && r.line <= 110) || r.id === 363),
};
fs.writeFileSync(outFile, JSON.stringify({ experiment: 'r10-survivor-classification', method: 'see header of r10-mutation/classify-survivors.js', summary, rows }, null, 2), { flag: 'wx' });
console.log(JSON.stringify(summary));
