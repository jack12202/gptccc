// Operational read-only probe. Never imports the recharge service or submits orders.
import dns from 'node:dns/promises';
import https from 'node:https';
import crypto from 'node:crypto';
import { zzshuCredentialStore } from '/app/src/zzshu-credential-store.js';
import { config } from '/app/src/config.js';
const base = 'https://card.zzshu.pro';
const dummy = 'GPTC-PROBE-INVALID-KEY';
const meta = (label, status, headers, text) => {
  let body; try {body = JSON.parse(text);} catch {}
  return {label, status, server:headers.get('server'), ray:headers.get('cf-ray'), type:headers.get('content-type'),
    errorType:headers.get('cf-error-type'),errorOrigin:headers.get('cf-error-origin'),
    code:Number.isInteger(body?.code)?body.code:null,points:body?.data?.points,total:body?.data?.total,
    htmlTitle:text.match(/<title>([^<]{0,180})<\/title>/i)?.[1], bytes:Buffer.byteLength(text)};
};
async function probe(label, path, options = {}) {
  try {
    const r = await fetch(base+path, {...options,signal:AbortSignal.timeout(20000)});
    console.log(JSON.stringify(meta(label,r.status,r.headers,await r.text())));
  } catch(e) {console.log(JSON.stringify({label,error:e.name,code:e.cause?.code}));}
}
console.log(JSON.stringify({label:'runtime',node:process.version,baseUrl:config.zzshuBaseUrl,
  enabled:config.zzshuEnabled,keySource:zzshuCredentialStore.status().source,
  keyDigest:crypto.createHash('sha256').update(zzshuCredentialStore.key()).digest('hex').slice(0,12),
  proxyVariables:Object.keys(process.env).filter(k=>/^(https?_proxy|all_proxy|no_proxy|node_use_env_proxy)$/i.test(k))}));
let addresses=[];
try {addresses=await dns.resolve4('card.zzshu.pro');console.log(JSON.stringify({label:'dns',ipv4:addresses,ipv6:await dns.resolve6('card.zzshu.pro')}));} catch(e) {console.log(JSON.stringify({label:'dns',error:e.code}));}
await probe('public-home','/');
await probe('dummy-default','/api/v1/third-party/user',{headers:{'X-API-Key':dummy}});
try {
  const relay = await fetch('https://gptc-zzs-connectivity-probe.zjk12202.workers.dev/probe', {signal:AbortSignal.timeout(20000)});
  const result = await relay.json();
  console.log(JSON.stringify({label:'worker-relay-dummy',httpStatus:relay.status,upstreamStatus:result.status,upstreamCode:result.code,upstreamRay:result.ray,error:result.error}));
} catch (error) { console.log(JSON.stringify({label:'worker-relay-dummy',error:error.name,code:error.cause?.code})); }
await probe('dummy-browser','/api/v1/third-party/user',{headers:{'X-API-Key':dummy,Accept:'application/json','User-Agent':'Mozilla/5.0'}});
for (const address of addresses.slice(0,2)) {
  await new Promise(resolve=>{
    const req=https.request(base+'/api/v1/third-party/user',{method:'GET',agent:false,timeout:20000,
      lookup:(host,opts,cb)=>opts.all?cb(null,[{address,family:4}]):cb(null,address,4),
      headers:{'X-API-Key':dummy,Accept:'application/json'}},r=>{
      let raw='';r.on('data',b=>{if(raw.length<100000)raw+=b;});r.on('end',()=>{
        console.log(JSON.stringify(meta('https-ip-'+address,r.statusCode,new Headers(Object.entries(r.headers).filter(([k,v])=>typeof v==='string')),raw)));resolve();});
    });req.on('timeout',()=>req.destroy());req.on('error',e=>{console.log(JSON.stringify({label:'https-ip-'+address,error:e.code}));resolve();});req.end();
  });
}
const key=zzshuCredentialStore.key();
if(key){
  await probe('saved-key-user','/api/v1/third-party/user',{headers:{'X-API-Key':key,Accept:'application/json'}});
  await probe('saved-key-history','/api/v1/third-party/orders/history',{method:'POST',headers:{'X-API-Key':key,'Content-Type':'application/json'},body:JSON.stringify({page:1,page_size:1})});
}
