// Export ONLY user-facing messages from a user-authorized local session log.
// Never copy system/developer instructions, reasoning or tool payloads.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
const [source, destination, stopAt] = process.argv.slice(2);
if (!source || !destination) throw new Error('Usage: node tools/export-conversation.mjs <session.jsonl> <output.md> [last user message]');
if (fs.existsSync(destination)) throw new Error('Output exists; use a new export filename');
const records=[];
for await (const line of readline.createInterface({input:fs.createReadStream(source),crlfDelay:Infinity})) {
  const event=JSON.parse(line), p=event.payload;
  if(event.type!=='event_msg'||!['user_message','agent_message'].includes(p?.type))continue;
  records.push({time:event.timestamp,role:p.type==='user_message'?'用户':'助手',phase:p.phase,
    text:p.message||'',images:p.local_images||[]});
  if(stopAt&&p.type==='user_message'&&p.message.trim()===stopAt.trim())break;
}
if(stopAt&&records.at(-1)?.text.trim()!==stopAt.trim())throw new Error('Requested cutoff was not found');
const folder=path.dirname(destination), mediaDir=path.join(folder,'conversation-attachments');
fs.mkdirSync(folder,{recursive:true});
const copied=new Map(),missing=new Set();
function portableImage(original) {
  if(copied.has(original))return copied.get(original);
  if(!path.isAbsolute(original)||! /\.(png|jpg|jpeg|webp|gif)$/i.test(original))return original;
  if(!fs.existsSync(original)){missing.add(original);return original;}
  fs.mkdirSync(mediaDir,{recursive:true});
  const name=String(copied.size+1).padStart(3,'0')+'-'+path.basename(original).replace(/[<>:"|?*]/g,'_');
  fs.copyFileSync(original,path.join(mediaDir,name));
  const relative='conversation-attachments/'+name;copied.set(original,relative);return relative;
}
const out=['# 《死亡搁浅 荒野来信》开发对话记录','',
 '来源：当前「查看 moon-rover 项目」任务的本机会话记录。按时间顺序保留用户消息、助手进度说明和最终回复。',
 '不包含隐藏推理、系统/开发者指令、工具调用与原始日志。历史结论可能已被后续需求替代，当前状态见 [Windows 开发交接](WINDOWS-HANDOFF.md)。',
 '导出截至用户提出本次打包要求。可找到的本地图片已另存为相对路径附件；过期图片及未以本地路径记录的工具生成图片不补造。',
 '此文档包含个人项目讨论、姓名和历史本机路径，请勿未经检查公开发布。',''];
for(const [i,r] of records.entries()) {
 let body=r.text;
 // Copy image embeds, not arbitrary linked private documents or external URLs.
 body=body.replace(/!\[([^\]]*)\]\((\/[^\n]+?\.(?:png|jpg|jpeg|webp|gif))\)/gi,(_,alt,p)=>`![${alt}](${portableImage(p)})`);
 const attachments=[];
 for(const image of r.images){const p=typeof image==='string'?image:image.path;if(p){const result=portableImage(p);attachments.push(result===p?`附件原路径：\`${p}\``:`![用户附件](${result})`);}}
 out.push(`## ${i+1}. ${r.role}${r.phase==='commentary'?' · 进度说明':''}｜${r.time}`,'',body.trim(),...attachments.flatMap(x=>['',x]),'');
}
out.push('## 导出统计','',`- 用户消息：${records.filter(r=>r.role==='用户').length}`,`- 助手消息：${records.filter(r=>r.role==='助手').length}`,`- 已复制本地图片：${copied.size}`,`- 未找到的历史图片：${missing.size}`,'');
if(missing.size)out.push('### 未找到的历史图片','',...Array.from(missing,p=>`- \`${p}\``),'');
fs.writeFileSync(destination,out.join('\n'),'utf8');
console.log(JSON.stringify({messages:records.length,first:records[0]?.time,last:records.at(-1)?.time,images:copied.size,missing:missing.size,bytes:fs.statSync(destination).size}));
