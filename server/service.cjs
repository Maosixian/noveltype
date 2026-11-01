'use strict';
const http=require('node:http');
const {isIP}=require('node:net');
const {Store,Fault,id,integer,bad,exact}=require('./store.cjs');
const {translateAlignedText,alignExistingText,testConnection}=require('../app/translation.cjs');
const {validateAlignment}=require('../app/alignment.cjs');
const {getDemoAlignment}=require('../app/demo-alignment.cjs');

function json(res,status,value){const body=JSON.stringify(value);res.writeHead(status,{'content-type':'application/json; charset=utf-8','content-length':Buffer.byteLength(body),'cache-control':'no-store','x-content-type-options':'nosniff'});res.end(body);}
async function readBody(req){
  if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw new Fault(415,'JSON_REQUIRED','请使用 JSON 请求。');
  const chunks=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>16*1024*1024)throw new Fault(413,'TOO_LARGE','请求超过大小限制。');chunks.push(chunk);}
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{bad();}
}
function createService(options){
  const store=new Store(options);const fetchImpl=options.fetchImpl||globalThis.fetch;const jobs=new Map();const attempts=new Map();const clock=options.clock||Date.now;
  let closing=false,activeAuth=0;
  function rateLimit(req,username){
    const peer=(req.socket.remoteAddress||'unknown').replace(/^::ffff:/,'');
    const supplied=req.headers['x-noveltype-client-ip'];
    const address=options.trustedProxy===peer&&typeof supplied==='string'&&isIP(supplied)?supplied:peer;
    for(const key of [`ip:${address}`,`user:${username}`]){
      const old=attempts.get(key);const entry=old&&old.until>clock()?old:{until:clock()+60000,count:0};entry.count++;attempts.set(key,entry);
      if(entry.count>(key.startsWith('ip:')?30:10))throw new Fault(429,'RATE_LIMITED','登录尝试过多，请稍后再试。');
    }
    if(attempts.size>10000){for(const [key,value] of attempts)if(value.until<=clock())attempts.delete(key);if(attempts.size>10000)throw new Fault(429,'RATE_LIMITED','登录繁忙，请稍后再试。');}
  }
  async function prepare(user,input){
    if(!exact(input,['bookId','index','requestId'])||!id(input.bookId)||!integer(input.index,99999)||!id(input.requestId))bad();
    const {bookId,index,requestId}=input;
    const seen=store.db.prepare('SELECT * FROM jobs WHERE user_id=? AND id=?').get(user.id,requestId);
    if(seen){
      if(seen.book_id!==bookId||seen.segment_index!==index)throw new Fault(409,'REQUEST_REUSED','翻译请求标识已用于不同段落。');
      if(seen.state==='complete')return JSON.parse(seen.result);
      if(seen.state!=='running')throw new Fault(409,'TRANSLATION_STOPPED','此翻译请求已停止或结果未知。请检查后手动重试。');
    }
    const before=store.segment(user.id,bookId,index);
    const cached=store.entity(user.id,'alignment',`${bookId}:${index}`)?.value;
    const alignment=before.translation&&(cached?.source===before.source&&cached?.translation===before.translation?cached.alignment:getDemoAlignment(before.source,before.translation));
    if(alignment){
      const result={translation:before.translation,alignment,cached:true};
      store.db.prepare("INSERT INTO jobs VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,id) DO UPDATE SET state='complete',result=excluded.result").run(user.id,requestId,bookId,index,'complete',JSON.stringify(result));
      return result;
    }
    const key=`${user.id}:${bookId}:${index}`;
    if(seen&&!jobs.has(key))throw new Fault(409,'TRANSLATION_UNKNOWN','上次请求结果未知，请检查后手动重试。');
    if(!seen)store.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,NULL)').run(user.id,requestId,bookId,index,'running');
    let promise=jobs.get(key);
    if(!promise){
      // A single active provider request per account prevents competing devices
      // from increasing the normal current-plus-three prefetch window.
      if([...jobs.keys()].some(k=>k.startsWith(`${user.id}:`))){store.db.prepare("UPDATE jobs SET state='failed' WHERE user_id=? AND id=?").run(user.id,requestId);throw new Fault(409,'AI_BUSY','账号已有翻译请求，请等待完成后重试。');}
      promise=(async()=>{
        const credentials=store.settings(user.id,true);
        if(!credentials.apiKey)throw new Fault(409,'KEY_REQUIRED','请管理员先保存 API Key。');
        if(!store.allowed.has(credentials.settings.baseUrl))throw new Fault(409,'PROVIDER_NOT_ALLOWED','当前服务地址不在服务器允许列表中。');
        const options={source:before.source,...credentials,fetchImpl};
        const result=before.translation?await alignExistingText({...options,translation:before.translation}):await translateAlignedText(options);
        if(before.translation&&before.translation!==result.translation)throw new Fault(409,'TRANSLATION_CHANGED','原有译文不可被自动更改。');
        const validated=validateAlignment(before.source,result.translation,result.alignment);
        store.transaction(()=>{
          const current=store.segment(user.id,bookId,index);
          if(current.source!==before.source||current.translation!==before.translation)throw new Fault(409,'CONTEXT_CHANGED','此段内容已更改，旧翻译结果未覆盖新内容。');
          if(!before.translation){const chunk=store.entity(user.id,'chunk',`${bookId}:${Math.floor(index/128)}`).value;chunk.segments[index%128].translation=result.translation;store.put(user.id,'chunk',`${bookId}:${Math.floor(index/128)}`,chunk);}
          store.put(user.id,'alignment',`${bookId}:${index}`,{source:before.source,translation:result.translation,alignment:validated});
        });
        return {translation:result.translation,alignment:validated,cached:false};
      })();
      jobs.set(key,promise);
      // Keep the job indexed until all awaiters have observed the same result.
      promise.finally(()=>{if(jobs.get(key)===promise)jobs.delete(key);}).catch(()=>{});
    }
    try{const result=await promise;store.db.prepare("UPDATE jobs SET state='complete',result=? WHERE user_id=? AND id=?").run(JSON.stringify(result),user.id,requestId);return result;}
    catch(error){store.db.prepare("UPDATE jobs SET state='failed' WHERE user_id=? AND id=?").run(user.id,requestId);if(error instanceof Fault)throw error;throw new Fault(409,'TRANSLATION_FAILED','翻译未完成，已停止。请检查服务器 API 设置和额度后手动重试。');}
  }
  const server=http.createServer(async(req,res)=>{
    try{
      if(closing)throw new Fault(503,'SHUTTING_DOWN','服务器正在维护，请稍后再试。');
      // Native clients send no Origin. This API has no browser CORS surface.
      if(req.headers.origin)throw new Fault(403,'ORIGIN_DENIED','不允许的请求来源。');
      if(req.url==='/health'&&req.method==='GET'){store.db.prepare('SELECT 1').get();return json(res,200,{ok:true,service:'noveltype',protocol:1});}
      if(req.url==='/v1/auth/login'&&req.method==='POST'){
        const body=await readBody(req);if(!exact(body,['username','password']))bad();rateLimit(req,String(body.username).slice(0,40));
        if(activeAuth>=4)throw new Fault(429,'RATE_LIMITED','登录繁忙，请稍后再试。');
        activeAuth++;try{return json(res,200,await store.login(body));}finally{activeAuth--;}
      }
      const auth=req.headers.authorization||'';const token=auth.startsWith('Bearer ')?auth.slice(7):'';const user=store.authenticate(token);
      if(req.url==='/v1/auth/me'&&req.method==='GET')return json(res,200,{user});
      if(req.url==='/v1/auth/logout'&&req.method==='POST'){store.logout(token);return json(res,200,{ok:true});}
      if(req.url==='/v1/sync'&&req.method==='POST')return json(res,200,store.sync(user.id,await readBody(req)));
      if(req.url==='/v1/settings'&&req.method==='GET')return json(res,200,store.settings(user.id));
      if(req.url==='/v1/settings'&&req.method==='PUT'){
        if([...jobs.keys()].some(k=>k.startsWith(`${user.id}:`)))throw new Fault(409,'AI_BUSY','翻译进行中，请完成后再修改设置。');
        return json(res,200,store.saveSettings(user,await readBody(req)));
      }
      if(req.url==='/v1/prepare'&&req.method==='POST')return json(res,200,await prepare(user,await readBody(req)));
      if(req.url==='/v1/test-connection'&&req.method==='POST'){
        if(user.role!=='admin')throw new Fault(403,'FORBIDDEN','只有管理员可以测试 API 设置。');
        if([...jobs.keys()].some(k=>k.startsWith(`${user.id}:`)))throw new Fault(409,'AI_BUSY','已有翻译请求进行中。');
        const credentials=store.settings(user.id,true);if(!store.allowed.has(credentials.settings.baseUrl))bad();
        try{return json(res,200,await testConnection({...credentials,fetchImpl}));}catch{throw new Fault(409,'CONNECTION_FAILED','API 测试未成功，请检查配置和额度。');}
      }
      throw new Fault(404,'NOT_FOUND','接口不存在。');
    }catch(error){if(!res.headersSent)json(res,error instanceof Fault?error.status:500,{error:error instanceof Fault?error.message:'服务器处理失败，请稍后重试。',code:error instanceof Fault?error.code:'SERVER_ERROR'});else res.end();}
  });
  server.requestTimeout=20000;server.headersTimeout=10000;server.keepAliveTimeout=5000;
  return {server,store,prepare,async close(){closing=true;await Promise.allSettled([...jobs.values()]);if(server.listening)await new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();});store.close();}};
}
module.exports={createService};
