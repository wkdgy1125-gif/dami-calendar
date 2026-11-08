// 담이 전용 캘린더 - 가족 공유 서버 (Cloudflare Worker) v2
// 설정: 바인딩 → KV 네임스페이스 → 변수 이름 CAL
//       트리거 → Cron → "0 * * * *" (매시간: 알림 보내기 + 새 정보 반영)
// 편집 비밀번호 기본값: 123
const APP_URL = 'https://wkdgy1125-gif.github.io/dami-calendar/';
const SEED_URL = APP_URL + 'seed.json';
const UPDATES_URL = APP_URL + 'updates.json';
const AUTO_AUTHOR = '육아 지원 일정';
const DEFAULT_HASH = 'a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3';
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type,x-edit-password', 'access-control-max-age': '86400' };
const json = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS } });
const s = (v, n) => typeof v === 'string' ? v.slice(0, n) : '';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const REMINDS = ['d0', 'd1', 'd3', 'd7', 'h1'];
const enc = new TextEncoder();

async function sha(t) { const b = await crypto.subtle.digest('SHA-256', enc.encode(t)); return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join(''); }
function cleanL(a) { return (Array.isArray(a) ? a : []).slice(0, 5).map(x => ({ t: s(x && x.t, 60), u: s(x && x.u, 400) })).filter(x => /^https?:\/\/\S+$/i.test(x.u)); }
function cleanEvent(d) {
  if (!d || !DATE_RE.test(d.date || '')) return null;
  const cats = ['deadline', 'money', 'check', 'vax', 'work', 'day', 'shop'];
  const end = DATE_RE.test(d.endDate || '') && d.endDate > d.date ? d.endDate : '';
  return {
    title: s(d.title, 80) || '(제목 없음)', date: d.date, endDate: end, ampm: (d.ampm === 'AM' || d.ampm === 'PM') ? d.ampm : '',
    hour: Math.min(12, Math.max(1, Number(d.hour) || 12)), min: Math.min(59, Math.max(0, Number(d.min) || 0)),
    memo: s(d.memo, 500), author: s(d.author, 30), cat: cats.includes(d.cat) ? d.cat : '',
    remind: Array.isArray(d.remind) ? [...new Set(d.remind.filter(x => REMINDS.includes(x)))] : [],
    createdAt: s(d.createdAt, 40) || new Date().toISOString(), updatedAt: new Date().toISOString(),
    links: cleanL(d.links), sources: cleanL(d.sources)
  };
}
// 예전 기본 일정: 신청 기한은 기본으로 하루 전 알림
const remindOf = e => Array.isArray(e.remind) ? e.remind : (e.cat === 'deadline' && e.author === AUTO_AUTHOR ? ['d1'] : []);

async function load(env) {
  let ev = await env.CAL.get('events', 'json'), baby = await env.CAL.get('baby', 'json');
  if (!ev) {
    try { const r = await fetch(SEED_URL); const seed = await r.json(); ev = seed.events || {}; baby = baby || seed.baby || null; } catch (e) { ev = {}; }
    await env.CAL.put('events', JSON.stringify(ev)); if (baby) await env.CAL.put('baby', JSON.stringify(baby));
  }
  return { ev, baby };
}
async function authed(req, env) {
  let pw = ''; try { pw = decodeURIComponent(req.headers.get('x-edit-password') || ''); } catch (e) { }
  if (!pw) return false;
  return (await sha(pw)) === ((await env.CAL.get('lockHash')) || DEFAULT_HASH);
}

// ---------- 매주 새 정보 반영 (GitHub의 updates.json) ----------
async function applyUpdates(env, force) {
  const last = Number(await env.CAL.get('updCheckedAt') || 0);
  if (!force && Date.now() - last < 50 * 60e3) return { skipped: true };
  await env.CAL.put('updCheckedAt', String(Date.now()));
  let u; try { const r = await fetch(UPDATES_URL + '?t=' + Date.now(), { cf: { cacheTtl: 0 } }); if (!r.ok) return { none: true }; u = await r.json(); } catch (e) { return { error: true }; }
  const ver = String(u.version || ''); if (!ver || ver === (await env.CAL.get('updVersion'))) return { same: true };
  const { ev } = await load(env); let added = 0, changed = 0, removed = 0;
  const deleted = new Set((await env.CAL.get('deleted', 'json')) || []);
  for (const [id, raw] of Object.entries(u.events || {})) {
    const d = cleanEvent({ ...raw, author: raw.author || AUTO_AUTHOR }); if (!d) continue;
    if (!ev[id]) { if (deleted.has(id)) continue; ev[id] = d; added++; }
    else if (!ev[id].userEdited && ev[id].author === AUTO_AUTHOR) { d.createdAt = ev[id].createdAt; ev[id] = d; changed++; }
  }
  for (const id of (u.remove || [])) { if (ev[id] && !ev[id].userEdited && ev[id].author === AUTO_AUTHOR) { delete ev[id]; removed++; } }
  await env.CAL.put('events', JSON.stringify(ev)); await env.CAL.put('updVersion', ver);
  return { ver, added, changed, removed };
}

// ---------- 웹 푸시 (VAPID + aes128gcm, RFC 8291/8292) ----------
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = str => { str = str.replace(/-/g, '+').replace(/_/g, '/'); const b = atob(str + '==='.slice((str.length + 3) % 4)); return Uint8Array.from(b, c => c.charCodeAt(0)); };
const concat = (...a) => { const n = a.reduce((x, y) => x + y.length, 0), o = new Uint8Array(n); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
async function hmac(key, data) { const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); return new Uint8Array(await crypto.subtle.sign('HMAC', k, data)); }
async function vapidKeys(env) {
  let v = await env.CAL.get('vapid', 'json');
  if (!v) {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    v = { priv: await crypto.subtle.exportKey('jwk', kp.privateKey), pub: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)) };
    await env.CAL.put('vapid', JSON.stringify(v));
  }
  return v;
}
async function vapidAuth(env, endpoint) {
  const v = await vapidKeys(env);
  const aud = new URL(endpoint).origin;
  const h = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const p = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: APP_URL })));
  const key = await crypto.subtle.importKey('jwk', v.priv, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(h + '.' + p));
  return `vapid t=${h}.${p}.${b64u(sig)}, k=${v.pub}`;
}
async function encryptPayload(sub, text) {
  const uaPub = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const prkKey = await hmac(auth, shared);
  const ikm = await hmac(prkKey, concat(enc.encode('WebPush: info\0'), uaPub, asPub, new Uint8Array([1])));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const k = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, k, concat(enc.encode(text), new Uint8Array([2]))));
  const header = concat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([asPub.length]), asPub);
  return concat(header, ct);
}
async function sendPush(env, sub, msg) {
  const body = await encryptPayload(sub, JSON.stringify(msg));
  const r = await fetch(sub.endpoint, { method: 'POST', body, headers: { 'TTL': '86400', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', 'Urgency': 'normal', 'Authorization': await vapidAuth(env, sub.endpoint) } });
  return r.status;
}
async function pushAll(env, msg) {
  const subs = (await env.CAL.get('subs', 'json')) || {}; let sent = 0, gone = false;
  for (const [id, x] of Object.entries(subs)) {
    try { const st = await sendPush(env, x.sub, msg); if (st === 404 || st === 410) { delete subs[id]; gone = true; } else if (st < 300) sent++; } catch (e) { }
  }
  if (gone) await env.CAL.put('subs', JSON.stringify(subs));
  return sent;
}

// ---------- 알림 시각 계산 (한국 시간) ----------
const KST = 9 * 3600e3;
function fireTimes(e) {
  const [y, m, d] = e.date.split('-').map(Number);
  const at9 = n => Date.UTC(y, m - 1, d - n, 9, 0) - KST;
  const out = [];
  for (const r of remindOf(e)) {
    if (r === 'h1') { if (!e.ampm) continue; let h = Number(e.hour) % 12; if (e.ampm === 'PM') h += 12; out.push([r, Date.UTC(y, m - 1, d, h, Number(e.min) || 0) - KST - 3600e3]); }
    else out.push([r, at9(Number(r.slice(1)))]);
  }
  return out;
}
const WHEN = { d0: '오늘', d1: '내일', d3: '3일 뒤', d7: '일주일 뒤', h1: '1시간 뒤' };
async function runReminders(env) {
  const { ev } = await load(env); const now = Date.now();
  const sent = (await env.CAL.get('sent', 'json')) || {}; let n = 0;
  for (const [id, e] of Object.entries(ev)) {
    for (const [r, t] of fireTimes(e)) {
      const k = `${id}|${e.date}|${r}`;
      if (t <= now && t > now - 3 * 3600e3 && !sent[k]) {
        const title = e.title.replace(/^⏰\s*/, '');
        await pushAll(env, { title: `${WHEN[r]}: ${title}`, body: (e.memo || '').split('\n')[0].slice(0, 120) || '담이 캘린더에서 확인해 보세요', url: APP_URL, tag: k });
        sent[k] = now; n++;
      }
    }
  }
  for (const k in sent) if (now - sent[k] > 60 * 86400e3) delete sent[k];
  await env.CAL.put('sent', JSON.stringify(sent));
  return n;
}

// ---------- 폰 캘린더 연동 (.ics) ----------
function icsEsc(t) { return String(t || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
function icsFold(line) {
  if (enc.encode(line).length <= 75) return line;
  const out = []; let cur = '', len = 0;
  for (const ch of line) { const n = enc.encode(ch).length; if (len + n > (out.length ? 74 : 75)) { out.push(cur); cur = ''; len = 0; } cur += ch; len += n; }
  out.push(cur); return out.join('\r\n ');
}
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, '');
const utc = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
function buildIcs(ev, host) {
  const now = utc(new Date());
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//dami-calendar//KO', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:담이 전용 캘린더', 'X-WR-TIMEZONE:Asia/Seoul', 'REFRESH-INTERVAL;VALUE=DURATION:PT6H', 'X-PUBLISHED-TTL:PT6H'];
  for (const [id, e] of Object.entries(ev)) {
    if (!DATE_RE.test(e.date || '')) continue;
    const [y, mo, da] = e.date.split('-').map(Number);
    L.push('BEGIN:VEVENT', 'UID:' + id + '@' + host, 'DTSTAMP:' + now);
    if (e.ampm && !e.endDate) {
      let h = Number(e.hour) % 12; if (e.ampm === 'PM') h += 12;
      const st = new Date(Date.UTC(y, mo - 1, da, h - 9, Number(e.min) || 0)); L.push('DTSTART:' + utc(st), 'DTEND:' + utc(new Date(st.getTime() + 3600e3)));
    } else {
      const end = e.endDate ? e.endDate.split('-').map(Number) : [y, mo, da];
      L.push('DTSTART;VALUE=DATE:' + ymd(new Date(Date.UTC(y, mo - 1, da))), 'DTEND;VALUE=DATE:' + ymd(new Date(Date.UTC(end[0], end[1] - 1, end[2] + 1))), 'TRANSP:TRANSPARENT');
    }
    const links = (e.links || []).map(x => (x.t ? x.t + ': ' : '') + x.u).join('\n');
    const desc = [e.memo, links ? ('관련 링크\n' + links) : '', e.author ? ('작성자: ' + e.author) : ''].filter(Boolean).join('\n\n');
    L.push(icsFold('SUMMARY:' + icsEsc(e.title)));
    if (desc) L.push(icsFold('DESCRIPTION:' + icsEsc(desc)));
    if (e.links && e.links[0]) L.push(icsFold('URL:' + e.links[0].u));
    for (const r of remindOf(e)) {
      const n = Number(r.slice(1)), hrs = n * 24 - 9;
      const trig = r === 'h1' ? 'TRIGGER:-PT1H' : (e.ampm && !e.endDate ? (n ? `TRIGGER:-P${n}D` : 'TRIGGER:-PT0M') : (hrs < 0 ? `TRIGGER:PT${-hrs}H` : `TRIGGER:-PT${hrs}H`));
      L.push('BEGIN:VALARM', 'ACTION:DISPLAY', icsFold('DESCRIPTION:' + icsEsc(e.title)), trig, 'END:VALARM');
    }
    L.push('END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return L.join('\r\n') + '\r\n';
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url), p = url.pathname, m = req.method;
    if (m === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (!env.CAL) return new Response('KV(CAL) 연결이 필요해요: 설정 → 바인딩 → KV 네임스페이스 → 변수 이름 CAL', { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8', ...CORS } });
    if (p === '/' || p === '') return Response.redirect(APP_URL, 302);
    if (p === '/calendar.ics' && m === 'GET') { const { ev } = await load(env); return new Response(buildIcs(ev, url.host), { headers: { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'max-age=900', ...CORS } }); }
    if (p === '/api/state' && m === 'GET') {
      ctx && ctx.waitUntil && ctx.waitUntil(applyUpdates(env, false).catch(() => { }));
      const { ev, baby } = await load(env); return json({ events: ev, baby, updVersion: await env.CAL.get('updVersion') });
    }
    if (p === '/api/check' && m === 'POST') return (await authed(req, env)) ? json({ ok: true }) : json({ error: 'bad_password' }, 401);
    // 알림 (비밀번호 없이 가족 누구나 받을 수 있어요)
    if (p === '/api/push/key' && m === 'GET') return json({ key: (await vapidKeys(env)).pub });
    if (p === '/api/push/subscribe' && m === 'POST') {
      let b = {}; try { b = await req.json(); } catch (e) { return json({ error: 'bad_json' }, 400); }
      const sub = b.sub; if (!sub || !/^https:\/\//.test(sub.endpoint || '') || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return json({ error: 'bad_sub' }, 400);
      const subs = (await env.CAL.get('subs', 'json')) || {}; const id = (await sha(sub.endpoint)).slice(0, 24);
      subs[id] = { sub: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }, name: s(b.name, 30), at: Date.now() };
      if (Object.keys(subs).length > 30) return json({ error: 'too_many' }, 400);
      await env.CAL.put('subs', JSON.stringify(subs)); return json({ ok: true });
    }
    if (p === '/api/push/test' && m === 'POST') {
      let b = {}; try { b = await req.json(); } catch (e) { }
      const subs = (await env.CAL.get('subs', 'json')) || {}; const x = Object.values(subs).find(v => v.sub.endpoint === b.endpoint);
      if (!x) return json({ error: 'not_subscribed' }, 404);
      const st = await sendPush(env, x.sub, { title: '🔔 담이 캘린더 알림 테스트', body: '알림이 잘 와요! 신청 기한 전에 이렇게 알려 드릴게요.', url: APP_URL, tag: 'test' });
      return st < 300 ? json({ ok: true }) : json({ error: 'push_failed', status: st }, 502);
    }
    if (!p.startsWith('/api/')) return new Response('Not found', { status: 404, headers: CORS });
    if (!(await authed(req, env))) return json({ error: 'bad_password' }, 401);
    if (p === '/api/updates/run' && m === 'POST') return json(await applyUpdates(env, true));
    let body = {}; if (m !== 'DELETE') { try { body = await req.json(); } catch (e) { return json({ error: 'bad_json' }, 400); } }
    const { ev } = await load(env);
    if (p === '/api/events' && m === 'POST') {
      const d = cleanEvent(body); if (!d) return json({ error: 'bad_event' }, 400); d.userEdited = true;
      const id = 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); ev[id] = d; await env.CAL.put('events', JSON.stringify(ev)); return json({ ok: true, id });
    }
    const mm = p.match(/^\/api\/events\/([A-Za-z0-9_\-.~:@+%]{1,120})$/);
    if (mm) {
      const id = decodeURIComponent(mm[1]);
      if (m === 'PUT') { const d = cleanEvent(body); if (!d) return json({ error: 'bad_event' }, 400); if (ev[id] && ev[id].createdAt) d.createdAt = ev[id].createdAt; d.userEdited = true; ev[id] = d; }
      else if (m === 'DELETE') { delete ev[id]; const del = (await env.CAL.get('deleted', 'json')) || []; del.push(id); await env.CAL.put('deleted', JSON.stringify(del.slice(-500))); }
      else return json({ error: 'method' }, 405);
      await env.CAL.put('events', JSON.stringify(ev)); return json({ ok: true });
    }
    if (p === '/api/baby' && m === 'PUT') {
      if (!DATE_RE.test(body.date || '')) return json({ error: 'bad_date' }, 400);
      const regions = Array.isArray(body.regions) ? body.regions.filter(r => ['chungbuk', 'seoul', 'gyeonggi'].includes(r)) : [];
      await env.CAL.put('baby', JSON.stringify({ date: body.date, born: body.born === true, order: body.order === '2' ? '2' : '1', regions, imported: body.imported === true })); return json({ ok: true });
    }
    if (p === '/api/password' && m === 'POST') { const np = s(body.password, 100); if (!np) return json({ error: 'empty' }, 400); await env.CAL.put('lockHash', await sha(np)); return json({ ok: true }); }
    return json({ error: 'not_found' }, 404);
  },
  // 매시간 실행: 알림 보내기 + 새 정보 반영
  async scheduled(event, env, ctx) {
    if (!env.CAL) return;
    ctx.waitUntil((async () => { try { await applyUpdates(env, false); } catch (e) { } try { await runReminders(env); } catch (e) { } })());
  }
};
