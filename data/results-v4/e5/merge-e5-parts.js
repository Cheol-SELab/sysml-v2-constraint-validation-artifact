// merged view of results-v4/e5 parts A/B/C (no new measurement), same layout as results-v2/e5-incremental-v2.json
const fs=require('fs'),path=require('path');const D=process.argv[2];
const parts=['partA','partB','partC'].map(p=>({file:`e5-incremental-v2-${p}.json`,d:JSON.parse(fs.readFileSync(path.join(D,`e5-incremental-v2-${p}.json`),'utf8'))}));
const [A,B,C]=parts.map(p=>p.d);
const same=(k)=>JSON.stringify(A[k])===JSON.stringify(B[k])&&JSON.stringify(A[k])===JSON.stringify(C[k]);
for(const k of ['experiment','catalog','protocol','paths','opsDefinition','counterexampleFamilies']) if(!same(k)) throw new Error('parts differ in '+k);
const out={derived:'merged view of e5-incremental-v2-partA/B/C.json (no new measurement); rows copied verbatim',
 parts:parts.map(p=>({file:p.file,meta:p.d.meta,partition:p.d.partition})),
 experiment:A.experiment,catalog:A.catalog,protocol:A.protocol,paths:A.paths,opsDefinition:A.opsDefinition,counterexampleFamilies:A.counterexampleFamilies,
 speedup:[...A.speedup,...B.speedup],speedupLarge:C.speedupLarge};
fs.writeFileSync(path.join(D,'e5-incremental-v4.json'),JSON.stringify(out,null,2)+'\n',{flag:'wx'});
console.log('rows',out.speedup.length,out.speedupLarge.length, 'A large',A.speedupLarge.length,'B large',B.speedupLarge.length,'C small',C.speedup.length);
