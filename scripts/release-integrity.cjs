'use strict';
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const asar=require('@electron/asar');

const appFiles=['main.cjs','preload.cjs','library.cjs','security.cjs','translation.cjs','typing.mjs','stream.mjs','renderer.js','index.html','styles.css','alignment.cjs','alignment.mjs','demo-alignment.cjs','practice.cjs'];
const allowed=new Set(['app','package.json','使用说明.md',...appFiles.map(name=>'app/'+name)]);
function assertAppEntries(entries){
  for(const entry of entries){
    const name=entry.replaceAll('\\','/').replace(/^\//,'');
    assert.ok(allowed.has(name),'Unexpected release entry: '+name);
  }
}

function verify(root=path.resolve(__dirname,'..')){
  const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
  const archive=path.join(root,'dist/win-unpacked/resources/app.asar');
  assertAppEntries(asar.listPackage(archive));
  for(const name of appFiles)assert.deepEqual(asar.extractFile(archive,'app/'+name),fs.readFileSync(path.join(root,'app',name)),'Packaged source mismatch: '+name);
  const bundled=JSON.parse(asar.extractFile(archive,'package.json'));
  assert.equal(bundled.name,pkg.name);assert.equal(bundled.version,pkg.version);assert.equal(bundled.main,'app/main.cjs');
  assert.ok(!bundled.dependencies||Object.keys(bundled.dependencies).length===0,'Review newly added runtime dependencies');
  const names=[`NovelType-Setup-${pkg.version}-x64.exe`,`NovelType-${pkg.version}-win-x64.zip`];
  for(const name of names)assert.ok(fs.statSync(path.join(root,'dist',name)).size>50*1024*1024,'Incomplete release asset: '+name);
  const setup=fs.readFileSync(path.join(root,'dist',names[0]));assert.equal(setup.subarray(0,2).toString(),'MZ');
  const sevenZip=require('7zip-bin').path7za;
  const zip=path.join(root,'dist',names[1]);
  const listing=execFileSync(sevenZip,['l','-slt',zip],{encoding:'utf8',maxBuffer:16*1024*1024});
  const entries=listing.split('----------')[1].split(/\r?\n/).filter(line=>line.startsWith('Path = ')).map(line=>line.slice(7).replaceAll('\\','/'));
  assert.ok(entries.includes('NovelType.exe')&&entries.includes('resources/app.asar'),'Missing ZIP runtime');
  for(const entry of entries){
    assert.ok(!entry.startsWith('/')&&!entry.split('/').includes('..'),'Unsafe ZIP path');
    assert.ok(!/(^|\/)(settings\.json|library\.json(?:\.bak)?|evidence|test|research|\.git|\.env)(\/|$)/i.test(entry),'Private or development content in ZIP: '+entry);
  }
  const zippedAsar=execFileSync(sevenZip,['e','-so',zip,'resources/app.asar'],{maxBuffer:32*1024*1024});
  assert.deepEqual(zippedAsar,fs.readFileSync(archive),'ZIP differs from verified app archive');
  const sums=names.map(name=>crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'dist',name))).digest('hex')+'  '+name).join('\n')+'\n';
  fs.writeFileSync(path.join(root,'dist/SHA256SUMS.txt'),sums);
  console.log(JSON.stringify({version:pkg.version,applicationFilesVerified:appFiles.length,zipVerified:true,assets:names,checksums:'SHA256SUMS.txt',note:'Content verification only; Windows launch and installer acceptance are separate checks.'}));
}
module.exports={assertAppEntries,verify};
if(require.main===module)verify();
