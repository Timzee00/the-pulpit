import access from './_shared/access.mjs';
import core from './_shared/versiah.mjs';
export default async function(req,context) {
 let event;try {event=await access.toEvent(req,context,24000);}catch{return access.web(access.reply(413,{error:'Request too large.'}));}
 return access.web(await core.run(event));
}
