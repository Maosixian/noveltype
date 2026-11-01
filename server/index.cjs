'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {createService}=require('./service.cjs');
function configuration(){
  const keyFile=process.env.NOVELTYPE_MASTER_KEY_FILE;
  const encoded=keyFile?fs.readFileSync(keyFile,'utf8').trim():process.env.NOVELTYPE_MASTER_KEY||'';
  const masterKey=Buffer.from(encoded,'base64');
  if(!/^[A-Za-z0-9+/]{43}=$/.test(encoded)||masterKey.length!==32)throw Error('Invalid master key');
  return {directory:process.env.NOVELTYPE_DATA_DIR||path.join(__dirname,'data'),masterKey,trustedProxy:process.env.TRUSTED_PROXY||null,allowedBaseUrls:(process.env.NOVELTYPE_ALLOWED_API_BASES||'https://open.bigmodel.cn/api/paas/v4').split(',').map(v=>v.trim()).filter(Boolean)};
}
async function main(){
  process.umask(0o077);const service=createService({...configuration(),recoverJobs:process.argv[2]!=='create-user'});
  if(process.argv[2]==='create-user'){
    const chunks=[];let length=0;for await(const chunk of process.stdin){length+=chunk.length;if(length>4096)throw Error('Input too large');chunks.push(chunk);}
    const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));const user=await service.store.createUser(input);process.stdout.write(JSON.stringify({created:true,user})+'\n');await service.close();return;
  }
  const host=process.env.NOVELTYPE_HOST||'127.0.0.1';const port=Number(process.env.NOVELTYPE_PORT||8787);
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid port');
  await new Promise((resolve,reject)=>{service.server.once('error',reject);service.server.listen(port,host,resolve);});
  process.stdout.write(`NovelType service listening on ${host}:${port}\n`);
  let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;await service.close();process.exit(0);};process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
if(require.main===module)main().catch(()=>{process.stderr.write('NovelType service startup or user creation failed. Check private server configuration.\n');process.exitCode=1;});
module.exports={configuration};
