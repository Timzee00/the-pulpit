import {env,missing,reply} from './access.mjs';
const run=async event=>{
 if(event.httpMethod!=='GET')return reply(405,{error:'Method not allowed.'},{allow:'GET'});
 const absent=missing();if(!env('GROQ_API_KEY')&&!env('OPENROUTER_API_KEY'))absent.push('GROQ_API_KEY or OPENROUTER_API_KEY');
 return reply(absent.length?503:200,{ok:!absent.length,service:'the-pulpit',version:'1.1.0',release:event.deployId||'local',readiness:'configuration-only',liveProvidersVerified:false,missing:absent,turnstileSiteKey:env('TURNSTILE_SITE_KEY'),features:{licensedBibles:env('BIBLE_LICENSE_CONFIRMED')==='true'&&!!env('BIBLE_API_KEY'),voice:!!env('ELEVENLABS_API_KEY')}});
};

export {run};
export default {run};
