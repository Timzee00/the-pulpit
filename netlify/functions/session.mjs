import access from './_shared/access.mjs';
export default async function(req,context) {
 if(req.method!=='POST')return access.web(access.reply(405,{error:'Method not allowed.'},{allow:'POST'}));
 let event;try{event=await access.toEvent(req,context,4096);}catch{return access.web(access.reply(413,{error:'Request too large.'}));}
 const denied=await access.protect(event,{session:true,maxBytes:4096});if(denied)return access.web(denied);
 let body;try{body=JSON.parse(event.body);}catch{return access.web(access.reply(400,{error:'Invalid JSON.'}));}
 if(!body || typeof body.token!=='string' || body.token.length>2048)return access.web(access.reply(400,{error:'Verification token required.'}));
 try{const verified=await access.timedJson('https://challenges.cloudflare.com/turnstile/v0/siteverify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({secret:access.env('TURNSTILE_SECRET_KEY'),response:body.token,remoteip:event.trustedIp})});if(!verified.success || verified.hostname!==access.site().hostname || verified.action!=='pulpit_access')return access.web(access.reply(403,{error:'Verification expired or failed. Please try again.'}));return access.web(access.reply(200,{ok:true},{'set-cookie':access.issueSession(event)}));}catch{return access.web(access.reply(503,{error:'Verification service unavailable. Please try later.'}));}
}
