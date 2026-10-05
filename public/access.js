(() => {
 'use strict';
 const originalFetch=window.fetch.bind(window);
 let verifiedUntil=0, pending=null, settings=null;
 async function config(){if(!settings){const r=await originalFetch('/api/health',{cache:'no-store'});settings=await r.json();}if(!settings.ok)throw new Error('AI access is not configured yet. Open Setup check for details.');return settings;}
 async function verify(){if(verifiedUntil>Date.now())return;if(pending)return pending;pending=(async()=>{
 const cfg=await config();
 const modal=document.createElement('dialog');modal.setAttribute('aria-label','Verify public AI access');modal.style.cssText='background:#17130c;color:#f5edd6;border:1px solid #c9a84c;border-radius:16px;padding:24px;max-width:90vw';
 modal.innerHTML='<h2>Verify to continue</h2><p>This helps keep public AI access available.</p><div id="pulpit-challenge"></div><p id="pulpit-verification-status" role="status"></p><button type="button">Cancel</button>';
 document.body.appendChild(modal);modal.showModal();
 try{await new Promise((resolve,reject)=>{
 let widget;let finished=false;const timer=setTimeout(()=>done(new Error('Verification timed out. Please try again.')),90000);
 function done(error){if(finished)return;finished=true;clearTimeout(timer);if(widget!==undefined && window.turnstile)window.turnstile.remove(widget);error?reject(error):resolve();}
 modal.querySelector('button').onclick=()=>done(new Error('Verification cancelled. Your message is still available.'));
 modal.addEventListener('cancel',e=>{e.preventDefault();done(new Error('Verification cancelled.'));});
 function render(){if(finished)return;widget=window.turnstile.render(modal.querySelector('#pulpit-challenge'),{sitekey:cfg.turnstileSiteKey,action:'pulpit_access',theme:'dark',callback:async token=>{try{const r=await originalFetch('/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token}),signal:AbortSignal.timeout(15000)});const data=await r.json();if(!r.ok)throw new Error(data.error||'Verification failed.');verifiedUntil=Date.now()+14*60000;done();}catch(e){done(e);}},'error-callback':()=>done(new Error('Verification could not load. Check your connection and retry.')),'expired-callback':()=>done(new Error('Verification expired. Please retry.'))});}
 if(window.turnstile){render();return;}
 const script=document.createElement('script');script.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';script.onload=render;script.onerror=()=>done(new Error('Verification could not load.'));document.head.appendChild(script);
 });}finally{modal.close();modal.remove();}
 })();try{await pending;}finally{pending=null;}}
 window.fetch=async(input,options={})=>{
 const url=new URL(typeof input==='string'?input:input.url,location.href);
 const protectedNames=['versiah','generate-sermon','text-to-speech','pedia-research','bible'];
 const name=url.pathname.split('/').pop();const guarded=url.origin===location.origin && (url.pathname.startsWith('/api/')||url.pathname.startsWith('/.netlify/functions/'))&&protectedNames.includes(name);
 if(!guarded)return originalFetch(input,options);
 if(name==='bible'){const cfg=await originalFetch('/api/health').then(r=>r.json());if(!cfg.features?.licensedBibles)return originalFetch(input,options);}
 await verify();let response=await originalFetch(input,options);
 if(response.status===401){verifiedUntil=0;await verify();response=await originalFetch(input,options);}return response;
 };
 document.addEventListener('DOMContentLoaded',()=>{
 const footer=document.createElement('p');footer.style.cssText='text-align:center;font:13px/1.6 Arial;padding:18px;color:#c9a84c';footer.innerHTML='<a href="/privacy.html" style="color:inherit">Privacy & AI limits</a> · <a href="/setup.html" style="color:inherit">Setup check</a>';document.body.appendChild(footer);
 });
})();
