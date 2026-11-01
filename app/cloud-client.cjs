'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID, createHash} = require('node:crypto');
const MAX_BYTES = 16 * 1024 * 1024;
const KINDS = new Set(['book','chunk','progress','games','selection','alignment']);
const digest = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const validRevision = value => Number.isSafeInteger(value) && value >= 0;
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
const validEntity = value => plain(value) && KINDS.has(value.kind) && typeof value.key === 'string' && value.key.length > 0 && value.key.length <= 200 && validRevision(value.revision) && plain(value.value);
function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive:true});
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value), 'utf8'); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
function read(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  if (fs.statSync(file).size > MAX_BYTES) throw new Error('同步记录超出大小限制，原文件已保留。');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('同步记录无法读取，原文件已保留。'); }
}
function endpoint(input, allowHttpForTests = false) {
  let url;
  try { url = new URL(input); } catch { throw new Error('服务器地址无效。'); }
  const testHttp = allowHttpForTests && url.protocol === 'http:' && ['127.0.0.1','[::1]','localhost'].includes(url.hostname);
  if ((!testHttp && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash || String(input).length > 2048) throw new Error('服务器必须使用 HTTPS，且地址不能包含账号、密码或参数。');
  return url.href.replace(/\/+$/, '');
}
function userInfo(user) {
  if (!plain(user) || !validId(user.id) || typeof user.username !== 'string' || user.username.length > 80 || !['admin','user'].includes(user.role)) throw new Error('服务器返回的账号信息无效。');
  return {id:user.id, username:user.username, role:user.role};
}
function remove(file) { if (fs.existsSync(file)) fs.unlinkSync(file); }

class CloudClient {
  constructor({directory, cipher, fetchImpl = globalThis.fetch, allowHttpForTests = false}) {
    this.directory = directory; this.cipher = cipher; this.fetchImpl = fetchImpl;
    this.allowHttpForTests = allowHttpForTests; this.sessionFile = path.join(directory, 'cloud-session.json');
    this.session = read(this.sessionFile); this.inFlight = null; this.epoch = 0;
    if (this.session) {
      this.session.serverUrl = endpoint(this.session.serverUrl, allowHttpForTests);
      this.session.user = userInfo(this.session.user);
      if (typeof this.session.encryptedToken !== 'string' || !this.session.encryptedToken) throw new Error('登录记录无效，请重新登录。');
      this._loadAccount();
    }
  }
  _loadAccount() {
    const namespace = digest(`${this.session.serverUrl}\0${this.session.user.id}`);
    this.accountDir = path.join(this.directory, 'accounts', namespace);
    this.syncDir = path.join(this.accountDir, 'cloud');
    this.metadataFile = path.join(this.syncDir, 'state.json');
    this.metadata = read(this.metadataFile, {version:1, deviceId:randomUUID(), cursor:0, lastSyncedAt:null});
    if (this.metadata.version !== 1 || !validId(this.metadata.deviceId) || !validRevision(this.metadata.cursor)) throw new Error('账号同步记录无效，原文件已保留。');
    atomic(this.metadataFile, this.metadata);
    this.recordIndexes = new Map();
    for (const folder of ['outbox','conflicts']) this.recordIndexes.set(folder,new Map(this._records(folder).map(op=>[op.mutationId,op])));
  }
  _assertAccount() { if (!this.session) throw new Error('请先登录账号。'); }
  _token() {
    this._assertAccount();
    try {
      if (!this.cipher.isEncryptionAvailable()) throw Error();
      const token = this.cipher.decryptString(Buffer.from(this.session.encryptedToken, 'base64'));
      if (typeof token !== 'string' || !token || token.length > 4096 || /[\r\n]/.test(token)) throw Error();
      return token;
    } catch { throw new Error('本机无法解密登录凭证，请重新登录。'); }
  }
  _file(folder, name) { this._assertAccount(); return path.join(this.syncDir, folder, `${name}.json`); }
  _records(folder) {
    this._assertAccount(); const dir = path.join(this.syncDir, folder);
    if(this.recordIndexes?.has(folder))return [...this.recordIndexes.get(folder).values()];
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(name => /^[a-f0-9-]+\.json$/.test(name)).map(name => read(path.join(dir,name)));
  }
  _writeRecord(folder,record) { atomic(this._file(folder,record.mutationId),record);this.recordIndexes?.get(folder)?.set(record.mutationId,record); }
  _removeRecord(folder,id) { remove(this._file(folder,id));this.recordIndexes?.get(folder)?.delete(id); }
  accountDirectory() { this._assertAccount(); return this.accountDir; }
  // Main-process transaction checkpoint; encrypted credentials never cross preload.
  sessionCheckpoint() { return clone(this.session); }
  restoreSession(checkpoint) {
    if(this.inFlight)throw new Error('请等同步结束后恢复账号。');
    if(checkpoint){endpoint(checkpoint.serverUrl,this.allowHttpForTests);userInfo(checkpoint.user);atomic(this.sessionFile,checkpoint);}
    else remove(this.sessionFile);
    this.epoch++;this.session=clone(checkpoint);
    if(this.session)this._loadAccount();else{this.metadata=null;this.accountDir=null;this.syncDir=null;this.recordIndexes=new Map();}
  }
  public() {
    if (!this.session) return {loggedIn:false, connected:false, user:null, serverUrl:'', pending:0, conflicts:[], cursor:0, lastSyncAt:null};
    return {loggedIn:true, connected:true, user:clone(this.session.user), serverUrl:this.session.serverUrl, pending:this.outbox().length, conflicts:this.conflicts().map(({mutationId,kind,key,current})=>({mutationId,kind,key,currentRevision:current?.revision||0})), cursor:this.metadata.cursor, lastSyncAt:this.metadata.lastSyncedAt};
  }
  async _request(route, {method='GET', body, connection, timeoutMs=30000} = {}) {
    if (!connection) this._assertAccount();
    const serverUrl = connection?.serverUrl || this.session.serverUrl;
    const token = connection ? connection.token : this._token();
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const serialized = body === undefined ? undefined : JSON.stringify(body);
      if (serialized && Buffer.byteLength(serialized) > MAX_BYTES) throw new Error('请求过大，请分批同步。');
      const response = await this.fetchImpl(serverUrl + route, {method, body:serialized, redirect:'error', credentials:'omit', signal:controller.signal, headers:{Accept:'application/json', ...(serialized ? {'Content-Type':'application/json'} : {}), ...(token ? {Authorization:`Bearer ${token}`} : {})}});
      if (response.redirected || (response.status >= 300 && response.status < 400)) throw new Error('服务器发生重定向，请使用直接的 HTTPS 地址。');
      let text = '';
      if (response.body?.getReader) {
        const reader = response.body.getReader(); const chunks=[]; let size=0;
        try { while (true) { const {done,value}=await reader.read(); if(done)break; size+=value.byteLength; if(size>MAX_BYTES){void reader.cancel();throw new Error('服务器响应过大。');}chunks.push(Buffer.from(value));} }
        finally { reader.releaseLock(); }
        text=Buffer.concat(chunks).toString('utf8');
      } else { text=JSON.stringify(await response.json()); if(Buffer.byteLength(text)>MAX_BYTES)throw new Error('服务器响应过大。'); }
      let data; try { data=JSON.parse(text); } catch { throw new Error('服务器响应格式不正确。'); }
      if (!response.ok) {
        const error = new Error(({401:'登录已失效或账号密码不正确，请重新登录。',403:'此账号没有操作权限。',409:'服务器状态已变化或上次任务尚未完成，请刷新后重试。',413:'同步数据过大，请分批处理。',429:'请求过于频繁，请稍后重试。'})[response.status] || '服务器暂时无法完成请求，请稍后手动重试。');
        error.httpStatus=response.status; if(typeof data.code==='string'&&/^[A-Z0-9_]{1,80}$/.test(data.code))error.code=data.code;
        throw error;
      }
      return data;
    } catch(error) {
      if(error.httpStatus)throw error;
      if(controller.signal.aborted)throw new Error('服务器请求超时，本机待同步记录已保留。');
      // Never expose provider messages, URLs containing credentials, or fetch diagnostics.
      throw new Error('无法完成服务器请求，本机记录已保留，请检查连接后手动重试。');
    } finally {clearTimeout(timer);}
  }
  async login({serverUrl, username, password}) {
    if(this.inFlight)throw new Error('正在同步，请完成后再切换账号。');
    const normalized=endpoint(serverUrl,this.allowHttpForTests);
    if(!this.cipher?.isEncryptionAvailable())throw new Error('Windows 加密不可用，无法保存登录凭证。');
    if(typeof username!=='string'||!username.trim()||username.length>80||typeof password!=='string'||!password||password.length>1024)throw new Error('请填写有效的账号和密码。');
    const data=await this._request('/v1/auth/login',{method:'POST',body:{username:username.trim(),password},connection:{serverUrl:normalized}});
    const user=userInfo(data.user);
    if(typeof data.token!=='string'||!data.token||data.token.length>4096||/[\r\n]/.test(data.token))throw new Error('服务器登录响应无效。');
    const session={version:1,serverUrl:normalized,user,encryptedToken:this.cipher.encryptString(data.token).toString('base64')};
    atomic(this.sessionFile,session); this.epoch++; this.session=session; this._loadAccount(); return this.public();
  }
  async logout() {
    if(this.inFlight)throw new Error('正在同步，请完成后再退出账号。');
    if(!this.session)return this.public();
    let token;try{token=this._token();}catch{}
    const connection={serverUrl:this.session.serverUrl,token};
    // Remove local access first, even if session revocation cannot reach the server.
    remove(this.sessionFile); this.epoch++; this.session=null; this.metadata=null; this.accountDir=null; this.syncDir=null;
    if(token)try{await this._request('/v1/auth/logout',{method:'POST',body:{},connection,timeoutMs:5000});}catch{}
    return this.public();
  }
  async me() { const result=await this._request('/v1/auth/me'); const user=userInfo(result.user); if(user.id!==this.session.user.id)throw new Error('服务器账号发生变化，请重新登录。');return {user}; }
  outbox() { return this._records('outbox').sort((a,b)=>a.order-b.order||a.mutationId.localeCompare(b.mutationId)); }
  conflicts() { return this._records('conflicts'); }
  hasPending(kind,key) { return [...this.outbox(),...this.conflicts()].some(op=>op.kind===kind&&op.key===key); }
  getEntity(kind,key) { return read(this._file('entities',digest(JSON.stringify([kind,key])))); }
  entities() { return this._records('entities'); }
  _cache(entity) {
    if(!validEntity(entity))throw new Error('服务器同步数据格式无效，尚未确认同步。');
    const old=this.getEntity(entity.kind,entity.key);
    if(!old||entity.revision>=old.revision)atomic(this._file('entities',digest(JSON.stringify([entity.kind,entity.key]))),entity);
  }
  enqueue(kind,key,value,{baseRevision}={}) {
    this._assertAccount();
    if(!KINDS.has(kind)||typeof key!=='string'||!key||key.length>200||!plain(value)||Buffer.byteLength(JSON.stringify(value))>2*1024*1024||(baseRevision!==undefined&&!validRevision(baseRevision)))throw new Error('待同步的数据无效或过大。');
    const pending=this.outbox(); const related=pending.filter(op=>op.kind===kind&&op.key===key);
    const previous=related.at(-1);
    if(previous&&!previous.attempted){this._writeRecord('outbox',{...previous,value:clone(value)});return previous.mutationId;}
    const conflict=this.conflicts().find(op=>op.kind===kind&&op.key===key);
    const operation={mutationId:randomUUID(),kind,key,value:clone(value),baseRevision:baseRevision??this.getEntity(kind,key)?.revision??0,attempted:false,dependsOn:previous?.mutationId||conflict?.mutationId||null,order:Math.max(Date.now(),(pending.at(-1)?.order||0)+1)};
    this._writeRecord('outbox',operation);return operation.mutationId;
  }
  sync(applyChanges=async()=>{}) {
    this._assertAccount(); if(this.inFlight)return this.inFlight;
    this.inFlight=this._sync(applyChanges).finally(()=>{this.inFlight=null;});return this.inFlight;
  }
  async _sync(applyChanges) {
    const incomingFile=path.join(this.syncDir,'incoming.json');
    let incoming=read(incomingFile);
    if(!incoming){
      const queue=this.outbox(),blocked=new Set([...queue,...this.conflicts()].map(op=>op.mutationId));
      const selected=[];let bytes=0;
      for(const op of queue.filter(op=>!op.dependsOn||!blocked.has(op.dependsOn))){const size=Buffer.byteLength(JSON.stringify(op));if(selected.length&&(selected.length>=32||bytes+size>4*1024*1024))break;selected.push(op);bytes+=size;}
      for(const op of selected){op.attempted=true;this._writeRecord('outbox',op);}
      const mutations=selected.map(({mutationId,kind,key,baseRevision,value})=>({mutationId,kind,key,baseRevision,value}));
      const response=await this._request('/v1/sync',{method:'POST',body:{deviceId:this.metadata.deviceId,cursor:this.metadata.cursor,mutations,limit:32}});
      this._validateSync(response,selected);
      incoming={response,submitted:selected};atomic(incomingFile,incoming);
    }
    const {response,submitted}=incoming;
    this._validateSync(response,submitted);
    // Cache is durable staging; advancing the pull cursor requires the caller's successful apply.
    for(const item of response.accepted){const sent=submitted.find(op=>op.mutationId===item.mutationId);if(sent)this._cache({kind:item.kind,key:item.key,revision:item.revision,value:sent.value});}
    for(const item of response.changes)this._cache(item);
    for(const conflict of response.conflicts)if(conflict.current)this._cache(conflict.current);
    const changes=response.changes.filter(item=>this.getEntity(item.kind,item.key)?.revision===item.revision);
    await applyChanges({...clone(response),changes:clone(changes)});
    for(const conflict of response.conflicts){
      const op=submitted.find(item=>item.mutationId===conflict.mutationId);
      if(op){this._writeRecord('conflicts',{...op,current:conflict.current});this._removeRecord('outbox',op.mutationId);}
    }
    for(const accepted of response.accepted){
      for(const child of this.outbox().filter(op=>op.dependsOn===accepted.mutationId))this._writeRecord('outbox',{...child,baseRevision:accepted.revision,dependsOn:null});
      this._removeRecord('outbox',accepted.mutationId);
    }
    this.metadata.cursor=response.cursor;this.metadata.lastSyncedAt=new Date().toISOString();atomic(this.metadataFile,this.metadata);remove(incomingFile);
    return {...clone(response),changes:clone(changes)};
  }
  _validateSync(response,submitted) {
    const ids=new Set(submitted.map(op=>op.mutationId));
    if(!plain(response)||!Array.isArray(response.acknowledged)||!Array.isArray(response.accepted)||!Array.isArray(response.changes)||!Array.isArray(response.conflicts)||!validRevision(response.cursor)||response.cursor<this.metadata.cursor||typeof response.hasMore!=='boolean'||response.changes.some(item=>!validEntity(item)))throw new Error('服务器同步响应无效，待同步记录已保留。');
    if(response.acknowledged.some(id=>!ids.has(id))||new Set(response.acknowledged).size!==response.acknowledged.length||response.accepted.length!==response.acknowledged.length)throw new Error('服务器同步确认不一致，待同步记录已保留。');
    const acceptedIds=new Set();
    for(const accepted of response.accepted){const op=submitted.find(item=>item.mutationId===accepted.mutationId);if(!op||acceptedIds.has(accepted.mutationId)||!response.acknowledged.includes(accepted.mutationId)||accepted.kind!==op.kind||accepted.key!==op.key||!validRevision(accepted.revision))throw new Error('服务器版本确认无效。');acceptedIds.add(accepted.mutationId);}
    const conflictIds=new Set();
    for(const conflict of response.conflicts){const op=submitted.find(item=>item.mutationId===conflict.mutationId);if(!op||acceptedIds.has(conflict.mutationId)||conflictIds.has(conflict.mutationId)||(conflict.current!==null&&(!validEntity(conflict.current)||conflict.current.kind!==op.kind||conflict.current.key!==op.key)))throw new Error('服务器冲突记录无效。');conflictIds.add(conflict.mutationId);}
    if(acceptedIds.size+conflictIds.size!==submitted.length)throw new Error('服务器未确认全部变更，待同步记录已保留。');
  }
  resolveLocal(mutationId) {
    if(this.inFlight)throw new Error('请等当前同步完成后处理冲突。');
    const conflict=this.conflicts().find(op=>op.mutationId===mutationId);if(!conflict)throw new Error('找不到此冲突。');
    const dependents=this.outbox().filter(op=>op.dependsOn===mutationId); const latest=dependents.at(-1);
    const next={...conflict,value:latest?.value||conflict.value,mutationId:randomUUID(),baseRevision:conflict.current?.revision||0,attempted:false,dependsOn:null,order:Date.now()};delete next.current;
    this._writeRecord('outbox',next);
    for(const op of dependents)this._removeRecord('outbox',op.mutationId);this._removeRecord('conflicts',mutationId);return next.mutationId;
  }
  resolveRemote(mutationId) {
    if(this.inFlight)throw new Error('请等当前同步完成后处理冲突。');
    const conflict=this.conflicts().find(op=>op.mutationId===mutationId);if(!conflict)throw new Error('找不到此冲突。');
    for(const op of this.outbox().filter(item=>item.dependsOn===mutationId))this._removeRecord('outbox',op.mutationId);
    this._removeRecord('conflicts',mutationId);return clone(conflict.current);
  }
  settings() { return this._request('/v1/settings'); }
  saveSettings(input) { return this._request('/v1/settings',{method:'PUT',body:input}); }
  testConnection() { return this._request('/v1/test-connection',{method:'POST',body:{},timeoutMs:120000}); }
  async prepare({bookId,index,retryFailed=false}) {
    this._assertAccount();if(!validId(bookId)||!Number.isSafeInteger(index)||index<0)throw new Error('段落位置无效。');
    const epoch=this.epoch,file=this._file('prepare',digest(JSON.stringify([bookId,index])));
    const previous=read(file);
    const pending=previous&&!(retryFailed&&previous.failed) ? previous : {bookId,index,requestId:randomUUID()};
    const request={bookId:pending.bookId,index:pending.index,requestId:pending.requestId};atomic(file,pending);
    try {
      const result=await this._request('/v1/prepare',{method:'POST',body:request,timeoutMs:120000});
      if(epoch!==this.epoch)throw new Error('账号已切换，旧请求的结果不会写入当前账号。');
      remove(file);return result;
    } catch(error) {
      // A definite rejection can be retried manually with a new job; an unknown
      // network outcome retains the same id, so the server cannot charge twice.
      if(['TRANSLATION_STOPPED','TRANSLATION_FAILED'].includes(error.code))atomic(file,{...pending,failed:true});
      else if(error.httpStatus&&error.httpStatus<500&&!['TRANSLATION_UNKNOWN','REQUEST_REUSED'].includes(error.code))remove(file);
      throw error;
    }
  }
}
module.exports={CloudClient};
