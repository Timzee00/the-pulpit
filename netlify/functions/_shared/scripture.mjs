import {redis,timedJson} from './access.mjs';
import {createHash,randomUUID} from 'node:crypto';
async function passage(reference,deadline) {
 if(!/^[1-3]? ?[A-Za-z]+(?: [A-Za-z]+)* \d{1,3}(?::\d{1,3}(?:-\d{1,3})?)?$/.test(reference))return null;
 const key='pulpit:verse:'+createHash('sha256').update(reference.toLowerCase()).digest('hex');
 try {const cached=await redis(['GET',key]);if(cached)return JSON.parse(cached);
 // Shared upstream allowance stays below Bible API's published IP allowance.
 const lua="redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',ARGV[1]-30000);if redis.call('ZCARD',KEYS[1])>=12 then return 0 end;redis.call('ZADD',KEYS[1],ARGV[1],ARGV[2]);redis.call('EXPIRE',KEYS[1],60);return 1";
 if(Number(await redis(['EVAL',lua,'1','pulpit:bible-window',String(Date.now()),randomUUID()]))!==1)return null;
 if(deadline-Date.now()<1000)return null;
 const data=await timedJson('https://bible-api.com/'+encodeURIComponent(reference)+'?translation=web&single_chapter_book_matching=indifferent',{headers:{accept:'application/json'}},Math.min(5000,deadline-Date.now()));
 if(data.translation_id!=='web'||!Array.isArray(data.verses)||!data.verses.length||data.verses.length>40)return null;
 if(data.verses.some(v=>!Number.isInteger(v.chapter)||!Number.isInteger(v.verse)||typeof v.text!=='string'||v.text.length>2000))return null;
 const result={reference:String(data.reference||reference).slice(0,100),verses:data.verses.map(v=>({chapter:v.chapter,verse:v.verse,text:v.text.trim()}))};
 await redis(['SET',key,JSON.stringify(result),'EX','604800']);return result;
 }catch{return null;}
}
export {passage};
export default {passage};
