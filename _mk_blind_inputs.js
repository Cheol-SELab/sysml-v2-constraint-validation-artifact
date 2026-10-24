const path=require('path');const fs=require('fs');
const C=process.argv[2], out=process.argv[3];
const d=require(path.join(C,'dist/catalog/domains.js'));
const rm=require(path.join(C,'dist/oracle/randomModels.js'));
const rngMod=require(path.join(C,'dist/util/rng.js'));
const RngCls=rngMod.Rng||rngMod.default||Object.values(rngMod).find(v=>typeof v==='function');
const batches=[];
for(const cat of d.allCatalogs()){const rng=new RngCls(20261022);const models=[];for(let i=0;i<300;i++)models.push({caseId:`${cat.id}-${i}`,model:rm.randomModel(rng,cat,`${cat.id}-${i}`,8,12)});batches.push({catalog:cat,models});}
for(let k=0;k<20;k++){const rng=new RngCls(7000+k);const cat=rm.randomCatalog(rng,`rc${k}`);const models=[];for(let i=0;i<100;i++)models.push({caseId:`rc${k}-${i}`,model:rm.randomModel(rng,cat,`rc${k}-${i}`,8,12)});batches.push({catalog:cat,models});}
fs.writeFileSync(out,JSON.stringify({batches}));console.log(batches.length, batches.reduce((a,b)=>a+b.models.length,0));
