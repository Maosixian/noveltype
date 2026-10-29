'use strict';
const fs=require('node:fs');
const path=require('node:path');

class SettingsStore {
  constructor(dir,cipher){
    this.file=path.join(dir,'settings.json'); this.cipher=cipher;
    this.data={provider:'glm',baseUrl:'https://open.bigmodel.cn/api/paas/v4',model:'glm-4.7-flash',encryptedKey:''};
    fs.mkdirSync(dir,{recursive:true});
    if(fs.existsSync(this.file)) {
      try { const data=JSON.parse(fs.readFileSync(this.file,'utf8')); if(!data||typeof data.baseUrl!=='string'||typeof data.model!=='string'||typeof data.encryptedKey!=='string')throw Error(); this.data=data; }
      catch {throw new Error('设置文件损坏。原文件已保留，请先备份数据目录再修复。');}
    }
  }
  public(){const {provider,baseUrl,model,encryptedKey}=this.data;return {provider,baseUrl,model,hasKey:!!encryptedKey};}
  key(){
    if(!this.data.encryptedKey)throw new Error('请先在翻译设置中填写 API Key。');
    try {if(!this.cipher.isEncryptionAvailable())throw Error();return this.cipher.decryptString(Buffer.from(this.data.encryptedKey,'base64'));}
    catch {throw new Error('无法解密 API Key，请在这台电脑重新填写。');}
  }
  save(input){
    if(!input||typeof input!=='object')throw new Error('设置格式不正确。');
    const {provider,baseUrl,model}=input;
    if(!['glm','deepseek','openai','custom'].includes(provider)||typeof baseUrl!=='string'||typeof model!=='string'||!model.trim()||model.length>200)throw new Error('请填写服务商、接口地址和模型名。');
    let url;try{url=new URL(baseUrl);}catch{throw new Error('接口地址无效。');}
    if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new Error('接口地址必须是 HTTPS，且不能包含密码或查询参数。');
    const normalized=url.href.replace(/\/+$/,'');
    const incoming=typeof input.apiKey==='string'?input.apiKey.trim():'';
    if(incoming.length>4096||/[\r\n]/.test(incoming))throw new Error('API Key 格式不正确。');
    if((normalized!==this.data.baseUrl||provider!==this.data.provider)&&this.data.encryptedKey&&!incoming&&!input.clearKey)throw new Error('更换服务商或接口地址时，请重新填写 API Key。');
    let encryptedKey=input.clearKey?'':this.data.encryptedKey;
    if(incoming){if(!this.cipher.isEncryptionAvailable())throw new Error('Windows 加密不可用，无法安全保存 API Key。');encryptedKey=this.cipher.encryptString(incoming).toString('base64');}
    const next={provider,baseUrl:normalized,model:model.trim(),encryptedKey};
    const temp=this.file+'.tmp'; fs.writeFileSync(temp,JSON.stringify(next,null,2),{mode:0o600});fs.renameSync(temp,this.file);this.data=next;
    return this.public();
  }
}
function decodeText(buffer){
  if(!Buffer.isBuffer(buffer)||buffer.length>10*1024*1024)throw new Error('请选择 10 MB 以内的 TXT 文本。');
  let text;
  if(buffer[0]===255&&buffer[1]===254)text=new TextDecoder('utf-16le',{fatal:true}).decode(buffer.subarray(2));
  else if(buffer[0]===254&&buffer[1]===255)text=new TextDecoder('utf-16be',{fatal:true}).decode(buffer.subarray(2));
  else {try{text=new TextDecoder('utf-8',{fatal:true}).decode(buffer);}catch{try{text=new TextDecoder('gb18030',{fatal:true}).decode(buffer);}catch{throw new Error('无法识别文本编码，请另存为 UTF-8 TXT。');}}}
  if(/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text))throw new Error('文件不是可读取的纯文本，请选择 TXT 文件。');
  return text.replace(/^\uFEFF/,'');
}
module.exports={SettingsStore,decodeText};
