'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {assertAppEntries}=require('../scripts/release-integrity.cjs');
const config=require('../electron-builder.json');

test('release contents reject user data, development files and unexpected files',()=>{
  const good=['/app','/app/main.cjs','/package.json'];
  assert.doesNotThrow(()=>assertAppEntries(good));
  for(const extra of ['/settings.json','/app/settings.json','/library.json','/evidence/key.txt','/node_modules/dev/index.js','/app/unexpected.js']) {
    assert.throws(()=>assertAppEntries([...good,extra]),/Unexpected release entry/);
  }
});

test('Windows installer preserves user data and needs no elevated installation',()=>{
  assert.equal(config.appId,'io.github.maosixian.noveltype');
  assert.equal(config.productName,'NovelType');
  assert.equal(config.nsis.perMachine,false);
  assert.equal(config.nsis.oneClick,true);
  assert.equal(config.nsis.allowElevation,false);
  assert.equal(config.nsis.deleteAppDataOnUninstall,false);
  assert.equal(config.publish,null);
  assert.deepEqual(config.win.target.map(t=>t.target),['nsis','zip']);
  assert.ok(config.files.every(file=>!file.includes('**')));
});
