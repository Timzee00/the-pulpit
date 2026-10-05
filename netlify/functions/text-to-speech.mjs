import access from './_shared/access.mjs';
import core from './_shared/text-to-speech.mjs';
export default async function(req,context) {
 let event;try{event=await access.toEvent(req,context);}catch{return access.web(access.reply(413,{error:'Request too large.'}));}
 return access.web(await core.run(event));
}
