import {readFile,readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join,dirname} from 'node:path';
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
async function files(dir){const list=[];for(const ent of await readdir(dir,{withFileTypes:true})){const p=join(dir,ent.name);if(ent.isDirectory())list.push(...await files(p));else list.push(p);}return list;}
let count=0;
for(const p of [...await files(join(root,'netlify/functions')),...await files(join(root,'public'))]){
 const text=await readFile(p,'utf8');let code;
 if(/\.(?:cjs|mjs|js)$/.test(p))code=text;
 else if(p.endsWith('.html'))code=[...text.matchAll(/<script(?![^>]*type=["']application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/gi)].map(m=>m[1]).join('\n');else continue;
 const result=p.endsWith('.mjs')?spawnSync(process.execPath,['--check',p],{encoding:'utf8'}):spawnSync(process.execPath,['--check'],{input:code,encoding:'utf8'});if(result.status!==0)throw Error(p+': '+result.stderr);
 if(p.includes('/public/')&&/gsk-[A-Za-z0-9_-]{10,}|sk-or-v1-[A-Za-z0-9_-]{10,}/.test(text))throw Error('Possible frontend secret: '+p);count++;
}
console.log(`Syntax and frontend secret checks passed for ${count} files.`);
