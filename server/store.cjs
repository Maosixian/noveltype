'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {randomBytes,randomUUID,createHash,scrypt,timingSafeEqual,createCipheriv,createDecipheriv}=require('node:crypto');
const {promisify}=require('node:util');
const {validateSettings}=require('../app/translation.cjs');
const {validateAlignment}=require('../app/alignment.cjs');
const derive=promisify(scrypt);
const digest=v=>createHash('sha256').update(v).digest('hex');
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const exact=(v,keys)=>plain(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const text=(v,max,empty=true)=>typeof v==='string'&&v.length<=max&&(empty||v.trim().length>0)&&v.isWellFormed()&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);
const id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(v);
const number=(v,max=1e12)=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=max;
const integer=(v,max=1e12)=>Number.isSafeInteger(v)&&number(v,max);
class Fault extends Error {constructor(status,code,message){super(message);this.status=status;this.code=code;}}
const bad=()=>{throw new Fault(400,'INVALID_INPUT','请求内容无效或超出限制。');};
const userPublic=row=>({id:row.id,username:row.username,role:row.role});

class Store {
  constructor({directory,masterKey,allowedBaseUrls,clock=Date.now,recoverJobs=true}) {
    if(!Buffer.isBuffer(masterKey)||masterKey.length!==32)throw Error('A 32-byte master key is required');
    if(!Array.isArray(allowedBaseUrls)||!allowedBaseUrls.length)throw Error('Provider allowlist is required');
    this.masterKey=masterKey;this.clock=clock;this.allowed=new Set(allowedBaseUrls.map(v=>validateSettings({provider:'custom',baseUrl:v,model:'validation'}).baseUrl));
    fs.mkdirSync(directory,{recursive:true,mode:0o700});
    this.db=new DatabaseSync(path.join(directory,'cloud.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, role TEXT NOT NULL, salt TEXT NOT NULL, password_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS revisions(id INTEGER PRIMARY KEY AUTOINCREMENT);
      CREATE TABLE IF NOT EXISTS entities(user_id TEXT NOT NULL,kind TEXT NOT NULL,key TEXT NOT NULL,revision INTEGER NOT NULL,value TEXT NOT NULL, PRIMARY KEY(user_id,kind,key));
      CREATE INDEX IF NOT EXISTS entity_changes ON entities(user_id,revision);
      CREATE TABLE IF NOT EXISTS mutations(user_id TEXT NOT NULL,id TEXT NOT NULL,digest TEXT NOT NULL,kind TEXT NOT NULL,key TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(user_id,id));
      CREATE TABLE IF NOT EXISTS usage(user_id TEXT PRIMARY KEY,bytes INTEGER NOT NULL);
      INSERT OR IGNORE INTO usage SELECT user_id,sum(length(CAST(value AS BLOB))) FROM entities GROUP BY user_id;
      CREATE TABLE IF NOT EXISTS settings(user_id TEXT PRIMARY KEY,provider TEXT NOT NULL,base_url TEXT NOT NULL,model TEXT NOT NULL,encrypted_key TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(user_id TEXT NOT NULL,id TEXT NOT NULL,book_id TEXT NOT NULL,segment_index INTEGER NOT NULL,state TEXT NOT NULL,result TEXT,PRIMARY KEY(user_id,id));`);
    if(recoverJobs)this.db.exec("UPDATE jobs SET state='unknown' WHERE state='running'");
    try{fs.chmodSync(path.join(directory,'cloud.sqlite'),0o600);}catch{}
  }
  transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const out=fn();this.db.exec('COMMIT');return out;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  async createUser({username,password,role='user'}) {
    if(typeof username!=='string'||! /^[A-Za-z0-9][A-Za-z0-9_.-]{2,39}$/.test(username)||!text(password,256,false)||password.length<6||!['admin','user'].includes(role))bad();
    const salt=randomBytes(24).toString('hex');const hash=await derive(password,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024});
    const user={id:randomUUID(),username,role};
    try{this.db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(user.id,username,role,salt,hash.toString('hex'));}catch{throw new Fault(409,'USER_EXISTS','账号已存在，未修改原账号。');}
    return user;
  }
  async login({username,password}={}) {
    if(typeof username!=='string'||username.length>40||!text(password,256,false))bad();
    const row=this.db.prepare('SELECT * FROM users WHERE username=?').get(username);
    const hash=await derive(password,row?.salt||'noveltype-no-such-account',64,{N:32768,r:8,p:1,maxmem:64*1024*1024});
    if(!row||!timingSafeEqual(hash,Buffer.from(row.password_hash,'hex')))throw new Fault(401,'AUTH_FAILED','账号或密码不正确。');
    const token=randomBytes(32).toString('base64url');
    this.db.prepare('DELETE FROM sessions WHERE expires<?').run(this.clock());
    this.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(token),row.id,this.clock()+7*86400000);
    return {token,user:userPublic(row)};
  }
  authenticate(token){
    if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))throw new Fault(401,'UNAUTHENTICATED','请先登录账号。');
    const row=this.db.prepare('SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.hash=? AND sessions.expires>?').get(digest(token),this.clock());
    if(!row)throw new Fault(401,'UNAUTHENTICATED','登录已失效，请重新登录。');return userPublic(row);
  }
  logout(token){this.db.prepare('DELETE FROM sessions WHERE hash=?').run(digest(token));}
  entity(userId,kind,key){const row=this.db.prepare('SELECT kind,key,revision,value FROM entities WHERE user_id=? AND kind=? AND key=?').get(userId,kind,key);return row?{...row,value:JSON.parse(row.value)}:null;}
  put(userId,kind,key,value){
    const serialized=JSON.stringify(value);
    const previous=this.db.prepare('SELECT length(CAST(value AS BLOB)) bytes FROM entities WHERE user_id=? AND kind=? AND key=?').get(userId,kind,key)?.bytes||0;
    const total=this.db.prepare('SELECT bytes FROM usage WHERE user_id=?').get(userId)?.bytes||0;
    if(total-previous+Buffer.byteLength(serialized)>128*1024*1024)throw new Fault(413,'ACCOUNT_QUOTA','账号同步数据已达 128 MB 上限，请联系管理员。');
    const revision=Number(this.db.prepare('INSERT INTO revisions DEFAULT VALUES').run().lastInsertRowid);
    this.db.prepare('INSERT INTO entities VALUES(?,?,?,?,?) ON CONFLICT(user_id,kind,key) DO UPDATE SET revision=excluded.revision,value=excluded.value').run(userId,kind,key,revision,serialized);
    this.db.prepare('INSERT INTO usage VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET bytes=excluded.bytes').run(userId,total-previous+Buffer.byteLength(serialized));
    return revision;
  }
  validateEntity(userId,kind,key,value){
    if(!plain(value)||typeof key!=='string'||key.length>100||Buffer.byteLength(JSON.stringify(value))>2*1024*1024)bad();
    if(kind==='book'){
      if(!id(key)||!exact(value,['id','title','demo','segmentCount'])||value.id!==key||!text(value.title,200,false)||typeof value.demo!=='boolean'||!integer(value.segmentCount,100000)||value.segmentCount<1)bad();
      const old=this.entity(userId,kind,key);
      if(old&&old.value.segmentCount!==value.segmentCount)throw new Fault(409,'SOURCE_IMMUTABLE','已同步书籍的原文不可替换，请另行导入。');
      if(!old&&this.db.prepare("SELECT COUNT(*) n FROM entities WHERE user_id=? AND kind='book'").get(userId).n>=100)bad();return;
    }
    if(kind==='selection') {if(key!=='active'||!exact(value,['bookId'])||!id(value.bookId)||!this.entity(userId,'book',value.bookId))bad();return;}
    const bookId=['chunk','alignment'].includes(kind)?value.bookId||key.split(':')[0]:key;
    const book=this.entity(userId,'book',bookId)?.value;if(!book&&!(kind==='games'&&key==='sample'))bad();
    if(kind==='chunk'){
      if(!exact(value,['bookId','start','segments'])||!integer(value.start,99999)||value.start%128!==0||key!==`${bookId}:${value.start/128}`||!Array.isArray(value.segments)||value.segments.length!==Math.min(128,book.segmentCount-value.start)||value.segments.length<1)bad();
      for(const s of value.segments)if(!exact(s,['source','translation'])||!text(s.source,260)||s.source.length===0||!text(s.translation,10000))bad();
      const old=this.entity(userId,kind,key);if(old&&old.value.segments.some((s,i)=>s.source!==value.segments[i].source))throw new Fault(409,'SOURCE_IMMUTABLE','已同步书籍的原文不可替换，请另行导入。');
      return;
    }
    if(kind==='progress'){
      if(!exact(value,['position','draft','completed','stats'])||!integer(value.position,book.segmentCount-1)||!text(value.draft,10000)||!Array.isArray(value.completed)||value.completed.length>book.segmentCount||new Set(value.completed).size!==value.completed.length||value.completed.some(i=>!integer(i,book.segmentCount-1))||!exact(value.stats,['sessions','characters','seconds'])||!integer(value.stats.sessions,1e9)||!integer(value.stats.characters)||!number(value.stats.seconds))bad();return;
    }
    if(kind==='games'){
      if(!exact(value,['levels','bestRaces','recent'])||!plain(value.levels)||!plain(value.bestRaces)||!Array.isArray(value.recent)||value.recent.length>20||Object.keys(value.levels).length>12||Object.keys(value.bestRaces).length>40)bad();
      for(const [k,v] of Object.entries(value.levels))if(!/^(?:[1-9]|1[0-2])$/.test(k)||!exact(v,['stars','score','seconds','accuracy'])||!integer(v.stars,3)||v.stars<1||!number(v.score,1e7)||!number(v.seconds,3600)||!number(v.accuracy,100)||(Number(k)>1&&!value.levels[Number(k)-1]))bad();
      for(const [k,v] of Object.entries(value.bestRaces))if(!/^[a-f0-9]{64}$/.test(k)||!exact(v,['seconds','wpm','accuracy'])||!number(v.seconds,3600)||!number(v.wpm,1e5)||!number(v.accuracy,100))bad();
      for(const v of value.recent){if(!exact(v,['bookId','runId','mode','levelId','passageId','stars','score','seconds','accuracy','wpm','won'])||v.bookId!==bookId||!id(v.runId)||!['race','defense'].includes(v.mode)||!(v.levelId===null||(integer(v.levelId,12)&&v.levelId>0))||!(v.passageId===null||/^[a-f0-9]{64}$/.test(v.passageId))||typeof v.won!=='boolean'||!integer(v.stars,3)||(v.won?v.stars<1:v.stars!==0)||!number(v.score,1e7)||!number(v.seconds,3600)||!number(v.accuracy,100)||!number(v.wpm,1e5))bad();}return;
    }
    if(kind==='alignment'){
      if(!exact(value,['source','translation','alignment']))bad();const index=Number(key.split(':')[1]);if(key!==`${bookId}:${index}`||!integer(index,book.segmentCount-1))bad();
      const s=this.segment(userId,bookId,index);if(s.source!==value.source||s.translation!==value.translation)bad();
      try{validateAlignment(value.source,value.translation,value.alignment);}catch{bad();}return;
    }
    bad();
  }
  sync(userId,body){
    if(!exact(body,['deviceId','cursor','mutations','limit'])||!id(body.deviceId)||!integer(body.cursor)||!integer(body.limit,50)||body.limit<1||!Array.isArray(body.mutations)||body.mutations.length>32)bad();
    return this.transaction(()=>{
      const acknowledged=[],accepted=[],conflicts=[];
      for(const m of body.mutations){
        if(!exact(m,['mutationId','kind','key','baseRevision','value'])||!id(m.mutationId)||typeof m.kind!=='string'||!integer(m.baseRevision))bad();
        const hash=digest(JSON.stringify([m.kind,m.key,m.baseRevision,m.value]));const seen=this.db.prepare('SELECT * FROM mutations WHERE user_id=? AND id=?').get(userId,m.mutationId);
        if(seen){if(seen.digest!==hash)throw new Fault(409,'MUTATION_REUSED','同步操作标识已用于不同内容。');acknowledged.push(m.mutationId);accepted.push({mutationId:m.mutationId,kind:seen.kind,key:seen.key,revision:seen.revision});continue;}
        this.validateEntity(userId,m.kind,m.key,m.value);
        const current=this.entity(userId,m.kind,m.key);
        if((current?.revision||0)!==m.baseRevision){conflicts.push({mutationId:m.mutationId,current});continue;}
        const revision=this.put(userId,m.kind,m.key,m.value);
        this.db.prepare('INSERT INTO mutations VALUES(?,?,?,?,?,?)').run(userId,m.mutationId,hash,m.kind,m.key,revision);
        acknowledged.push(m.mutationId);accepted.push({mutationId:m.mutationId,kind:m.kind,key:m.key,revision});
      }
      const rows=this.db.prepare('SELECT kind,key,revision,value FROM entities WHERE user_id=? AND revision>? ORDER BY revision LIMIT ?').all(userId,body.cursor,body.limit+1);
      const changes=[];let bytes=0;
      for(const row of rows.slice(0,body.limit)){if(changes.length&&bytes+Buffer.byteLength(row.value)>8*1024*1024)break;bytes+=Buffer.byteLength(row.value);changes.push({...row,value:JSON.parse(row.value)});}
      return {acknowledged,accepted,conflicts,changes,cursor:changes.at(-1)?.revision||body.cursor,hasMore:rows.length>changes.length};
    });
  }
  segment(userId,bookId,index){const book=this.entity(userId,'book',bookId)?.value;if(!book||!integer(index,book.segmentCount-1))bad();const chunk=this.entity(userId,'chunk',`${bookId}:${Math.floor(index/128)}`)?.value;const segment=chunk?.segments[index%128];if(!segment)throw new Fault(409,'BOOK_INCOMPLETE','书籍尚未同步完成，请先同步后再翻译。');return structuredClone(segment);}
  encrypt(value,userId){if(!value)return '';const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',this.masterKey,iv);cipher.setAAD(Buffer.from(userId));return Buffer.concat([iv,cipher.update(value,'utf8'),cipher.final(),cipher.getAuthTag()]).toString('base64');}
  decrypt(value,userId){if(!value)return '';try{const b=Buffer.from(value,'base64');const decipher=createDecipheriv('aes-256-gcm',this.masterKey,b.subarray(0,12));decipher.setAAD(Buffer.from(userId));decipher.setAuthTag(b.subarray(-16));return Buffer.concat([decipher.update(b.subarray(12,-16)),decipher.final()]).toString('utf8');}catch{throw new Fault(503,'KEY_UNAVAILABLE','服务器无法解密 API Key，请管理员重新保存。');}}
  settings(userId,secret=false){const r=this.db.prepare('SELECT * FROM settings WHERE user_id=?').get(userId);const pub=r?{provider:r.provider,baseUrl:r.base_url,model:r.model,hasKey:!!r.encrypted_key}:{provider:'glm',baseUrl:'https://open.bigmodel.cn/api/paas/v4',model:'glm-5.3',hasKey:false};return secret?{settings:pub,apiKey:r?this.decrypt(r.encrypted_key,userId):''}:pub;}
  saveSettings(user,input){
    if(user.role!=='admin')throw new Fault(403,'FORBIDDEN','只有管理员可以修改翻译设置。');
    if(!plain(input)||Object.keys(input).some(k=>!['provider','baseUrl','model','apiKey','clearKey','hasKey'].includes(k)))bad();
    let settings;try{settings=validateSettings(input);}catch{bad();}
    if(!this.allowed.has(settings.baseUrl))throw new Fault(400,'PROVIDER_NOT_ALLOWED','该 API 地址不在服务器允许列表中。');
    const old=this.db.prepare('SELECT * FROM settings WHERE user_id=?').get(user.id);
    if(input.apiKey!==undefined&&typeof input.apiKey!=='string')bad();
    const incoming=typeof input.apiKey==='string'?input.apiKey.trim():'';
    if(!text(incoming,4096)||/[\r\n]/.test(incoming)||(input.clearKey!==undefined&&typeof input.clearKey!=='boolean'))bad();
    if(old?.encrypted_key&&(old.base_url!==settings.baseUrl||old.provider!==settings.provider)&&!incoming&&!input.clearKey)throw new Fault(400,'REENTER_KEY','更换 API 地址时请重新填写密钥。');
    const encrypted=incoming?this.encrypt(incoming,user.id):input.clearKey?'':old?.encrypted_key||'';
    this.db.prepare('INSERT INTO settings VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET provider=excluded.provider,base_url=excluded.base_url,model=excluded.model,encrypted_key=excluded.encrypted_key').run(user.id,settings.provider,settings.baseUrl,settings.model,encrypted);
    return this.settings(user.id);
  }
  close(){if(this.db.isOpen)this.db.close();}
}
module.exports={Store,Fault,id,integer,bad,exact};
