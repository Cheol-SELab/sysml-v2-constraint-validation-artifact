/**
 * Hub-model generator (E6 v2, review item M7): an adversarial variant of the clean-model
 * generator with one high-degree component.
 *
 * Starting from generateCleanModel, the last component H (highest topological index):
 *   - becomes the owner of a share of all ports (portShare),
 *   - becomes the subject of a share of all views (viewShare); every view exposes its
 *     subject and all ports of the subject,
 *   - receives dependOn edges from a share of the other components (dependShare); H is last
 *     in the dependOn order, so no cycle is created.
 * The degree of H and the exposure lists of hub views grow linearly with n, so the view
 * rule (three variables: view, exposed element, subject) is no longer evaluated in
 * bounded-degree neighbourhoods. The result is asserted clean (no violation) by the caller.
 */

import { Catalog } from '../model/types';
import { Rng } from '../util/rng';
import { GeneratedModel, GeneratorOptions, generateCleanModel } from './syntheticModelGenerator';

export interface HubOptions {
  portShare: number;
  viewShare: number;
  /** absolute number of hub views; overrides viewShare when given */
  hubViews?: number;
  dependShare: number;
}

export function generateHubModel(c: Catalog, opts: GeneratorOptions, hub: HubOptions): GeneratedModel {
  const gen = generateCleanModel(c, opts);
  const m = gen.model;
  const rng = new Rng(opts.seed * 7 + 13);
  const comps = gen.componentOrder;
  const H = comps[comps.length - 1];
  let seq = 0;
  const newId = (): string => `h${seq++}`;

  // ports: move ownership of a share of ports to H
  const ports = m.nodes.filter((n) => n.type === 'Port').map((n) => n.id);
  const moved = new Set(rng.shuffle(ports).slice(0, Math.round(ports.length * hub.portShare)));
  for (const e of m.edges) {
    if (e.type === 'contain' && moved.has(e.tgt) && e.src !== H) e.src = H;
  }
  // recompute portsOf
  const portsOf = new Map<string, string[]>();
  for (const cmp of comps) portsOf.set(cmp, []);
  const portSet = new Set(ports);
  for (const e of m.edges) if (e.type === 'contain' && portsOf.has(e.src) && portSet.has(e.tgt)) portsOf.get(e.src)!.push(e.tgt);

  // views: retarget a share to H, then rebuild every view's exposure list
  const views = m.nodes.filter((n) => n.type === 'View').map((n) => n.id);
  const hubViews = new Set(rng.shuffle(views).slice(0, hub.hubViews ?? Math.round(views.length * hub.viewShare)));
  const subjectOf = new Map<string, string>();
  for (const e of m.edges) {
    if (e.type !== 'subject') continue;
    if (hubViews.has(e.src)) e.tgt = H;
    subjectOf.set(e.src, e.tgt);
  }
  m.edges = m.edges.filter((e) => e.type !== 'expose');
  for (const w of views) {
    const s = subjectOf.get(w);
    if (!s) continue;
    m.edges.push({ id: newId(), type: 'expose', src: w, tgt: s });
    for (const p of portsOf.get(s) ?? []) m.edges.push({ id: newId(), type: 'expose', src: w, tgt: p });
  }

  // dependOn edges into H
  for (const cmp of comps) {
    if (cmp === H) continue;
    if (rng.bernoulli(hub.dependShare)) m.edges.push({ id: newId(), type: 'dependOn', src: cmp, tgt: H });
  }

  // restore invariant (vi): no isolated node
  const deg = new Map<string, number>();
  for (const n of m.nodes) deg.set(n.id, 0);
  for (const e of m.edges) {
    deg.set(e.src, (deg.get(e.src) ?? 0) + 1);
    deg.set(e.tgt, (deg.get(e.tgt) ?? 0) + 1);
  }
  for (const n of m.nodes) {
    if ((deg.get(n.id) ?? 0) > 0) continue;
    if (n.type === 'Component' && n.id !== H) m.edges.push({ id: newId(), type: 'dependOn', src: n.id, tgt: H });
  }

  m.id = `${m.id}-hub`;
  return { ...gen, model: m, portsOf, subjectOf };
}
