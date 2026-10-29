const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {SettingsStore,decodeText}=require('../app/security.cjs');
const cipher={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from([...s].reverse().join('')),decryptString:b=>[...b.toString()].reverse().join('')};
function setup(){return {dir:fs.mkdtempSync(path.join(os.tmpdir(),'noveltype-security-'))};}
test('settings never return raw keys and reload encrypted credentials',()=>{const {dir}=setup(); const s=new SettingsStore(dir,cipher); s.save({provider:'glm',baseUrl:'https://open.bigmodel.cn/api/paas/v4',model:'glm-test',apiKey:'private-test-value'}); assert.equal(s.public().hasKey,true); assert.equal(s.key(),'private-test-value'); assert.ok(!JSON.stringify(s.public()).includes('private-test-value')); assert.ok(!fs.readFileSync(path.join(dir,'settings.json'),'utf8').includes('private-test-value')); assert.equal(new SettingsStore(dir,cipher).key(),'private-test-value');});
test('changing endpoint never silently forwards stored key',()=>{const {dir}=setup();const s=new SettingsStore(dir,cipher);s.save({provider:'glm',baseUrl:'https://open.bigmodel.cn/api/paas/v4',model:'test',apiKey:'fake'});assert.throws(()=>s.save({provider:'custom',baseUrl:'https://example.com/v1',model:'test'}),/重新/);assert.equal(s.public().provider,'glm');});
test('key storage fails closed without OS encryption',()=>{const {dir}=setup();const s=new SettingsStore(dir,{isEncryptionAvailable:()=>false});assert.throws(()=>s.save({provider:'glm',baseUrl:'https://open.bigmodel.cn/api/paas/v4',model:'test',apiKey:'fake'}),/加密/);assert.equal(s.public().hasKey,false);});
test('clear credential persists and malformed file is never overwritten silently',()=>{const {dir}=setup(); const s=new SettingsStore(dir,cipher);s.save({provider:'glm',baseUrl:'https://open.bigmodel.cn/api/paas/v4',model:'test',apiKey:'fake'});s.save({...s.public(),clearKey:true});assert.equal(new SettingsStore(dir,cipher).public().hasKey,false);fs.writeFileSync(path.join(dir,'settings.json'),'invalid');assert.throws(()=>new SettingsStore(dir,cipher),/设置文件/);});
test('UTF8 UTF16 and GB18030 TXT decode and binary rejection',()=>{assert.equal(decodeText(Buffer.from('山里有座小屋。')),'山里有座小屋。');assert.equal(decodeText(Buffer.concat([Buffer.from([255,254]),Buffer.from('你好','utf16le')])),'你好');assert.equal(decodeText(Buffer.from([0xc4,0xe3,0xba,0xc3])),'你好');assert.throws(()=>decodeText(Buffer.from([0,1,2,3])),/文本/);});
