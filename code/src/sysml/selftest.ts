/**
 * Self-test of S1 on a hand-written model whose expected typed graph is stated below.
 * Run: node dist/cli-sysml.js selftest   (exit code 1 on failure)
 */

import { Library } from './corpus';
import { normalizeSysML } from './normalize';
import { parseSysML } from './parser';
import { SemanticModel } from './semantics';

const MODEL = `
package Mini {
  private import ScalarValues::*;
  port def FuelPort { out item fuel; }
  part def Engine {
    attribute mass = 180 [kg];
    port fuelIn : ~FuelPort;
  }
  part def V8 :> Engine;
  part def Tank { port fuelOut : FuelPort; }
  part def Vehicle {
    attribute mass;
    part engine : V8;
    part tank : Tank;
    connect tank.fuelOut to engine.fuelIn;
  }
  requirement def MassReq { doc /* mass limit */ }
  requirement massReq : MassReq;
  part vehicle1 : Vehicle {
    :>> mass = 1500;
  }
  part context {
    ref design :> vehicle1;
    satisfy massReq by design;
  }
  verification def MassTest {
    objective { verify massReq; }
  }
  action def Drive { action accelerate; }
  allocate Drive to vehicle1;
  dependency vehicle1 to massReq;
  use case def Commute;
}
`;

export function runSelfTest(lib: Library): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  const pf = parseSysML(MODEL, 'mini.sysml');
  if (!pf.ok) return { ok: false, failures: [`parse: ${pf.error}`] };
  const check = (cond: boolean, msg: string) => {
    if (!cond) failures.push(msg);
  };
  for (const mode of ['keyword', 'specialization'] as const) {
    const sm = new SemanticModel(pf.roots, lib.roots);
    const r = normalizeSysML(sm, mode, 'all');
    const byName = (n: string) => r.model.nodes.filter((x) => x.attrs.name === n);
    const edge = (t: string, a: string, b: string) => r.model.edges.some((e) => e.type === t && r.model.nodes.find((n) => n.id === e.src)?.attrs.name === a && r.model.nodes.find((n) => n.id === e.tgt)?.attrs.name === b);
    check(byName('Engine')[0]?.type === 'Component', `${mode}: Engine is a Component`);
    check(byName('fuelIn')[0]?.type === 'Port', `${mode}: fuelIn is a Port`);
    check(edge('contain', 'Engine', 'fuelIn'), `${mode}: Engine contains fuelIn`);
    check(edge('connect', 'fuelOut', 'fuelIn'), `${mode}: connect fuelOut -> fuelIn through feature chains`);
    check(edge('allocate', 'Drive', 'vehicle1'), `${mode}: allocate Drive -> vehicle1`);
    check(edge('dependOn', 'vehicle1', 'massReq'), `${mode}: dependency vehicle1 -> massReq`);
    check(edge('verify', 'MassTest', 'massReq'), `${mode}: verify from enclosing verification case`);
    check(byName('Engine')[0]?.attrs.mass === 180, `${mode}: literal attribute with unit`);
    if (mode === 'keyword') {
      check(!edge('satisfy', 'vehicle1', 'massReq'), 'keyword: satisfy by a reference feature is lost');
      check(byName('engine')[0]?.attrs.mass === undefined, 'keyword: no attribute inheritance');
      check(byName('Commute').length === 0, 'keyword: use case is not mapped');
      check(byName('fuelIn')[0]?.attrs.direction === undefined, 'keyword: no port direction through typing');
    } else {
      check(edge('satisfy', 'vehicle1', 'massReq'), 'specialization: satisfy resolved through ref design :> vehicle1');
      check(byName('engine')[0]?.attrs.mass === 180, 'specialization: engine : V8 :> Engine inherits mass = 180');
      check(byName('vehicle1')[0]?.attrs.mass === 1500, 'specialization: redefinition value of vehicle1');
      check(r.classes.get(byName('MassTest')[0]?.id ?? '')?.has('Function') === true, 'specialization: verification def conforms to Action (Function)');
      check(r.classes.get(byName('Commute')[0]?.id ?? '')?.has('Function') === true, 'specialization: use case def conforms to Action (Function)');
      check(byName('fuelIn')[0]?.attrs.direction === 'in', 'specialization: conjugated port flips out -> in');
      check(byName('fuelOut')[0]?.attrs.direction === 'out', 'specialization: port direction from its definition');
    }
  }
  return { ok: failures.length === 0, failures };
}
