export function setupAccount({api,changeAccount,settingsChanged,beforeOpen=()=>{}}){
 const dialog=document.createElement('dialog');dialog.id='account-dialog';
 dialog.innerHTML='<form id="account-form"><div class="modal-heading"><h2>账号与同步</h2><button type="button" id="account-close" class="icon-button" aria-label="关闭">×</button></div><p id="account-summary" class="modal-intro"></p><div id="account-login-fields"><label for="account-server">服务器</label><input id="account-server" type="url" value="https://noveltype.kinoraworks.com" required><label for="account-name">账号</label><input id="account-name" autocomplete="username" required><label for="account-password">密码</label><input id="account-password" type="password" autocomplete="current-password" required><p class="field-help">登录后可在其他电脑接着练习。首次创建空账号书库时，会上传这台电脑已有的小说和进度。</p></div><p id="account-message" class="form-message" role="status"></p><div id="account-conflicts"></div><div class="modal-actions"><button type="button" id="account-upload-key" class="button secondary">使用本机已保存的 API</button><button type="button" id="account-logout" class="button secondary">退出账号</button><button type="button" id="account-sync" class="button primary">同步并刷新</button><button id="account-login" class="button primary">登录</button></div></form>';
 document.body.append(dialog);const $=id=>document.getElementById(id);let running=false;
 const button=document.createElement('button');button.id='open-account';button.className='toolbar-button';button.textContent='登录 / 同步';document.querySelector('.topbar-tools').prepend(button);
 function render(status){
  const connected=status?.connected;button.textContent=connected?`${status.user.username} · ${status.pending?'待同步':'账号'}`:'登录 / 同步';
  $('account-login-fields').hidden=!!connected;$('account-login').hidden=!!connected;
  for(const id of ['account-upload-key','account-logout','account-sync'])$(id).hidden=!connected;
  for(const input of $('account-login-fields').querySelectorAll('input'))input.disabled=!!connected;
  $('account-summary').textContent=connected?`已登录 ${status.user.username} · ${status.user.role==='admin'?'管理员':'用户'}。${status.pending} 项待同步。${status.lastSyncAt?'上次同步 '+new Date(status.lastSyncAt).toLocaleString():''}。后台同步不移动正在练习的位置；换设备后用“同步并刷新”接续。`:'书库、译文、打字位置和游戏进度随账号同步；断网时继续保存本机记录。';
  $('account-conflicts').replaceChildren();
  for(const item of status?.conflictItems||[]){const row=document.createElement('div');row.className='privacy-note';const text=document.createElement('p');text.textContent=`${({progress:'打字进度',games:'游戏进度',chunk:'小说译文',selection:'当前书籍'})[item.kind]||'书库内容'}在另一台电脑上也有修改，请选择保留哪一份。`;row.append(text);for(const [choice,label] of [['local','保留这台电脑'],['remote','使用云端']]){const b=document.createElement('button');b.type='button';b.className='button secondary';b.textContent=label;b.onclick=()=>run(()=>changeAccount(()=>api.resolveSync({mutationId:item.mutationId,choice})),'冲突已处理。');row.append(b);}$('account-conflicts').append(row);}
  if(status?.error)$('account-message').textContent=status.error;
 }
 async function refresh(){render(await api.getAccount());}
 async function run(action,message){if(running)return;running=true;dialog.querySelectorAll('button').forEach(b=>b.disabled=true);$('account-message').textContent='正在处理，请稍候…';try{await action();await refresh();$('account-message').textContent=message;}catch(e){$('account-message').textContent=e.message;}finally{running=false;dialog.querySelectorAll('button').forEach(b=>b.disabled=false);}}
 button.onclick=async()=>{beforeOpen();await refresh();dialog.showModal();};$('account-close').onclick=()=>{if(!running)dialog.close();};dialog.addEventListener('cancel',e=>{if(running)e.preventDefault();});
 $('account-form').onsubmit=e=>{e.preventDefault();const payload={serverUrl:$('account-server').value,username:$('account-name').value,password:$('account-password').value};$('account-password').value='';void run(()=>changeAccount(()=>api.login(payload)),'已登录，同步结果已载入。');};
 $('account-sync').onclick=()=>run(()=>changeAccount(()=>api.syncAccount()),'已同步。若有冲突，请先选择保留的记录。');
 $('account-logout').onclick=()=>run(()=>changeAccount(()=>api.logout()),'已退出，返回原来的本机书库。');
 $('account-upload-key').onclick=()=>run(async()=>settingsChanged(await api.uploadLocalSettings()),'API 配置已加密保存在服务器，其他电脑无需再填写。');
 setInterval(()=>{if(!running)void refresh().catch(()=>{});},15000);void refresh().catch(()=>{});
 return {refresh};
}
