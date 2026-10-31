const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Library}=require('../app/library.cjs');
let getDemoAlignment;try{({getDemoAlignment}=require('../app/demo-alignment.cjs'));}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e;}
test('every built-in demo has authored semantic alignment without a model or key',t=>{
  assert.equal(typeof getDemoAlignment,'function');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'noveltype-demo-map-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const book=new Library(dir).getState().books[0];
  for(const s of book.segments){const a=getDemoAlignment(s.source,s.translation);assert.ok(a?.spans.length>1);assert.equal(getDemoAlignment(s.source,s.translation+'!'),null);}
  const s=book.segments[0],a=getDemoAlignment(s.source,s.translation);assert.equal(s.source.slice(a.spans[0].sourceStart,a.spans[0].sourceEnd),'清晨');
});
