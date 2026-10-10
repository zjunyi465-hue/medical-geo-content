#!/usr/bin/env node
// Read-only draft hash, body count and exact single-line excerpt locator.
import {constants} from 'node:fs';
import {lstat,open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {countBodyRange} from './advantage-metrics.mjs';

export async function inspectDraft(filename,range,excerpt=null){
  if(typeof filename!=='string'||!filename.trim())throw new TypeError('需指定正文文件');
  const stat=await lstat(filename);
  if(stat.isSymbolicLink()||!stat.isFile())throw new Error('正文需为普通文件，不能是符号链接');
  if(excerpt!==null && (typeof excerpt!=='string'||!excerpt.trim()||/[\r\n]/u.test(excerpt)))throw new TypeError('摘录需为非空单行准确原文');
  let handle;
  try{
    handle=await open(filename,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
    if(!(await handle.stat()).isFile())throw new Error('正文需为普通文件');
    const bytes=await handle.readFile();
    const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
    const metrics=countBodyRange(text,range);
    const lines=text.replace(/^\uFEFF/u,'').split(/\r\n|\n|\r/u),matches=[];
    if(excerpt!==null)for(let i=0;i<lines.length;i++){
      let from=0,index;
      while((index=lines[i].indexOf(excerpt,from))!==-1){
        matches.push({line:i+1,start_utf16:index,end_utf16:index+excerpt.length,excerpt,line_counted_as_body:metrics.counted_body_lines.includes(i+1)});
        from=index+1;
      }
    }
    return {draft_sha256:createHash('sha256').update(bytes).digest('hex'),...metrics,excerpt_matches:matches,excerpt_found:excerpt===null?null:matches.length>0,scope:'byte_hash_and_declared_range_only',certifies_semantics:false,publication_ready:false};
  }finally{if(handle)await handle.close();}
}

async function main(){
  const args=process.argv.slice(2);
  if(args.length===1&&['--help','-h'].includes(args[0])){console.log('用法：node scripts/draft-tools.mjs <draft.md> --start-line <首行> --end-line <末行> [--excerpt "准确单行原文"]\n只读文件，输出JSON；行号首尾包含，需自行确认完整正文边界。');return;}
  const filename=args.shift(),options={};
  while(args.length){const key=args.shift();if(!['--start-line','--end-line','--excerpt'].includes(key)||key in options||!args.length)throw new Error('参数不完整、重复或不支持，请使用--help');options[key]=args.shift();}
  if(!/^\d+$/u.test(options['--start-line']??'')||!/^\d+$/u.test(options['--end-line']??''))throw new Error('需明确正文首末行号');
  const report=await inspectDraft(filename,{start_line:Number(options['--start-line']),end_line:Number(options['--end-line'])},options['--excerpt']??null);
  console.log(JSON.stringify(report,null,2));
  if(report.excerpt_found===false)process.exitCode=1;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error('正文工具未完成：'+error.message);process.exitCode=1;});
