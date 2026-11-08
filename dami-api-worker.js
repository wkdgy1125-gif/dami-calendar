// 담이 전용 캘린더 - 가족 공유 서버 (Cloudflare Worker)
// 설정: 바인딩에서 KV 네임스페이스를 변수 이름 CAL 로 연결하세요.
// 편집 비밀번호 기본값: 123
const APP_URL='https://wkdgy1125-gif.github.io/dami-calendar/';
const SEED_URL=APP_URL+'seed.json';
const DEFAULT_HASH='a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3';
const CORS={'access-control-allow-origin':'*','access-control-allow-methods':'GET,POST,PUT,DELETE,OPTIONS','access-control-allow-headers':'content-type,x-edit-password','access-control-max-age':'86400'};
const json=(o,st=200)=>new Response(JSON.stringify(o),{status:st,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...CORS}});
const s=(v,n)=>typeof v==='string'?v.slice(0,n):'';
async function sha(t){const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(t));return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');}
function cleanL(a){return (Array.isArray(a)?a:[]).slice(0,5).map(x=>({t:s(x&&x.t,60),u:s(x&&x.u,400)})).filter(x=>/^https?:\/\/\S+$/i.test(x.u));}
function cleanEvent(d){
  if(!d||!/^\d{4}-\d{2}-\d{2}$/.test(d.date||''))return null;
  const cats=['deadline','money','check','vax','work','day','shop'];
  return {title:s(d.title,80)||'(제목 없음)',date:d.date,ampm:(d.ampm==='AM'||d.ampm==='PM')?d.ampm:'',
    hour:Math.min(12,Math.max(1,Number(d.hour)||12)),min:Math.min(59,Math.max(0,Number(d.min)||0)),
    memo:s(d.memo,500),author:s(d.author,30),cat:cats.includes(d.cat)?d.cat:'',
    createdAt:s(d.createdAt,40)||new Date().toISOString(),updatedAt:new Date().toISOString(),
    links:cleanL(d.links),sources:cleanL(d.sources)};
}
async function load(env){
  let ev=await env.CAL.get('events','json'), baby=await env.CAL.get('baby','json');
  if(!ev){ try{ const r=await fetch(SEED_URL); const seed=await r.json(); ev=seed.events||{}; baby=baby||seed.baby||null; }catch(e){ ev={}; }
    await env.CAL.put('events',JSON.stringify(ev)); if(baby) await env.CAL.put('baby',JSON.stringify(baby)); }
  return {ev,baby};
}
async function authed(req,env){
  let pw='';try{pw=decodeURIComponent(req.headers.get('x-edit-password')||'');}catch(e){}
  if(!pw)return false;
  return (await sha(pw))===((await env.CAL.get('lockHash'))||DEFAULT_HASH);
}
// ---------- 폰 캘린더 연동 (.ics 구독 주소) ----------
function icsEsc(t){ return String(t||'').replace(/\\/g,'\\\\').replace(/;/g,'\;').replace(/,/g,'\\,').replace(/\r?\n/g,'\\n'); }
function icsFold(line){
  const enc=new TextEncoder(); if(enc.encode(line).length<=75) return line;
  const out=[]; let cur='', len=0;
  for(const ch of line){ const n=enc.encode(ch).length; if(len+n>(out.length?74:75)){ out.push(cur); cur=''; len=0; } cur+=ch; len+=n; }
  out.push(cur); return out.join('\r\n ');
}
const ymd=d=>d.toISOString().slice(0,10).replace(/-/g,'');
const utc=d=>d.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');
function buildIcs(ev, host){
  const now=utc(new Date());
  const L=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//dami-calendar//KO','CALSCALE:GREGORIAN','METHOD:PUBLISH',
    'X-WR-CALNAME:담이 전용 캘린더','X-WR-TIMEZONE:Asia/Seoul','REFRESH-INTERVAL;VALUE=DURATION:PT6H','X-PUBLISHED-TTL:PT6H'];
  for(const [id,e] of Object.entries(ev)){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(e.date||'')) continue;
    const [y,mo,da]=e.date.split('-').map(Number);
    L.push('BEGIN:VEVENT','UID:'+id+'@'+host,'DTSTAMP:'+now);
    if(e.ampm){
      let h=Number(e.hour)%12; if(e.ampm==='PM') h+=12;
      const st=new Date(Date.UTC(y,mo-1,da,h-9,Number(e.min)||0)); const en=new Date(st.getTime()+3600e3);
      L.push('DTSTART:'+utc(st),'DTEND:'+utc(en));
    } else {
      const st=new Date(Date.UTC(y,mo-1,da)), en=new Date(Date.UTC(y,mo-1,da+1));
      L.push('DTSTART;VALUE=DATE:'+ymd(st),'DTEND;VALUE=DATE:'+ymd(en),'TRANSP:TRANSPARENT');
    }
    const links=(e.links||[]).map(x=>(x.t?x.t+': ':'')+x.u).join('\n');
    const desc=[e.memo, links?('관련 링크\n'+links):'', e.author?('작성자: '+e.author):''].filter(Boolean).join('\n\n');
    L.push(icsFold('SUMMARY:'+icsEsc(e.title)));
    if(desc) L.push(icsFold('DESCRIPTION:'+icsEsc(desc)));
    if(e.links&&e.links[0]) L.push(icsFold('URL:'+e.links[0].u));
    if(e.cat==='deadline'){
      // 마감 하루 전 오전 9시에 알림 (종일 일정 기준), 시간 일정은 하루 전 같은 시각
      L.push('BEGIN:VALARM','ACTION:DISPLAY',icsFold('DESCRIPTION:'+icsEsc('내일 마감: '+e.title)),e.ampm?'TRIGGER:-P1D':'TRIGGER:-PT15H','END:VALARM');
    }
    L.push('END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return L.join('\r\n')+'\r\n';
}


export default {
  async fetch(req,env){
    const url=new URL(req.url),p=url.pathname,m=req.method;
    if(m==='OPTIONS')return new Response(null,{status:204,headers:CORS});
    if(!env.CAL)return new Response('KV(CAL) 연결이 필요해요: 설정 → 바인딩 → KV 네임스페이스 → 변수 이름 CAL',{status:500,headers:{'content-type':'text/plain; charset=utf-8'}});
    if(p==='/'||p==='')return Response.redirect(APP_URL,302);
    if(p==='/calendar.ics'&&m==='GET'){const {ev}=await load(env);return new Response(buildIcs(ev,url.host),{headers:{'content-type':'text/calendar; charset=utf-8','cache-control':'max-age=900',...CORS}});}
    if(p==='/api/state'&&m==='GET'){const {ev,baby}=await load(env);return json({events:ev,baby});}
    if(p==='/api/check'&&m==='POST')return (await authed(req,env))?json({ok:true}):json({error:'bad_password'},401);
    if(!p.startsWith('/api/'))return new Response('Not found',{status:404,headers:CORS});
    if(!(await authed(req,env)))return json({error:'bad_password'},401);
    let body={};if(m!=='DELETE'){try{body=await req.json();}catch(e){return json({error:'bad_json'},400);}}
    const {ev}=await load(env);
    if(p==='/api/events'&&m==='POST'){const d=cleanEvent(body);if(!d)return json({error:'bad_event'},400);
      const id='e'+Date.now().toString(36)+Math.random().toString(36).slice(2,7);ev[id]=d;await env.CAL.put('events',JSON.stringify(ev));return json({ok:true,id});}
    const mm=p.match(/^\/api\/events\/([A-Za-z0-9_\-.~:@+%]{1,120})$/);
    if(mm){const id=decodeURIComponent(mm[1]);
      if(m==='PUT'){const d=cleanEvent(body);if(!d)return json({error:'bad_event'},400);if(ev[id]&&ev[id].createdAt)d.createdAt=ev[id].createdAt;ev[id]=d;}
      else if(m==='DELETE'){delete ev[id];} else return json({error:'method'},405);
      await env.CAL.put('events',JSON.stringify(ev));return json({ok:true});}
    if(p==='/api/baby'&&m==='PUT'){
      if(!/^\d{4}-\d{2}-\d{2}$/.test(body.date||''))return json({error:'bad_date'},400);
      const regions=Array.isArray(body.regions)?body.regions.filter(r=>['chungbuk','seoul','gyeonggi'].includes(r)):[];
      await env.CAL.put('baby',JSON.stringify({date:body.date,born:body.born===true,order:body.order==='2'?'2':'1',regions,imported:body.imported===true}));return json({ok:true});}
    if(p==='/api/password'&&m==='POST'){const np=s(body.password,100);if(!np)return json({error:'empty'},400);await env.CAL.put('lockHash',await sha(np));return json({ok:true});}
    return json({error:'not_found'},404);
  }
};
