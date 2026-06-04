// server.ts — a tiny HTTP + SSE dashboard for the bounty abuse-monitor.
//
// Same process as the reindex loop: the loop pushes to `bus`, this server streams those
// events to browsers over Server-Sent Events so the flagged feed updates live as pump.fun
// bounties are indexed (and before they're deleted). Routes:
//   GET /            → the dashboard (self-contained HTML, vanilla EventSource)
//   GET /events      → SSE stream: snapshot first, then live `pass` / `flagged` events
//   GET /api/report  → current ranked flagged bounties as JSON
//   GET /api/stats   → health + latest pass stats (also the Fly health check)

import { createServer } from 'node:http';
import { bus } from './events.ts';

const PORT = Number(process.env.BOUNTIES_PORT || process.env.PORT || 8080);

export function startServer(): void {
  const server = createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];

    if (url === '/api/stats') {
      const { stats } = bus.getSnapshot();
      return json(res, { ok: true, ...stats });
    }

    if (url === '/api/report') {
      const { ranked } = bus.getSnapshot();
      return json(res, ranked.filter((r) => r.tier !== 'BENIGN'));
    }

    if (url === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      // instant paint: snapshot + recent backlog
      const { ranked, stats } = bus.getSnapshot();
      sse(res, 'snapshot', { ranked: ranked.filter((r) => r.tier !== 'BENIGN'), stats });
      for (const ev of bus.backlog()) sse(res, ev.type, ev);
      const unsub = bus.subscribe((ev) => sse(res, ev.type, ev));
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* gone */ } }, 15000);
      req.on('close', () => { clearInterval(ping); unsub(); });
      return;
    }

    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(PAGE);
    }

    res.writeHead(404); res.end('not found');
  });

  server.listen(PORT, '0.0.0.0', () => console.log(`[server] dashboard on :${PORT}  (/, /events, /api/report)`));
}

function json(res: import('node:http').ServerResponse, data: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(data));
}
function sse(res: import('node:http').ServerResponse, event: string, data: unknown): void {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ }
}

const PAGE = /* html */ `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>pump.fun bounty watch — live</title>
<style>
  :root{--bg:#0b0d12;--card:#151922;--mut:#8a93a6;--line:#222838;--fg:#e7ecf5}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto}
  header{padding:14px 18px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:12px;flex-wrap:wrap;position:sticky;top:0;background:var(--bg);z-index:2}
  h1{font-size:16px;margin:0;font-weight:650}
  .sub{color:var(--mut);font-size:12px}
  .dot{width:9px;height:9px;border-radius:50%;background:#f5b042;display:inline-block}
  .dot.live{background:#37d67a;box-shadow:0 0 8px #37d67a}
  .dot.dead{background:#e5484d}
  .pills{display:flex;gap:8px;flex-wrap:wrap;margin-left:auto}
  .pill{background:var(--card);border:1px solid var(--line);border-radius:999px;padding:3px 10px;font-size:12px;color:var(--mut)}
  .pill b{color:var(--fg)}
  main{padding:16px 18px;max-width:1100px;margin:0 auto}
  .summary{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:0 0 16px}
  .summary .stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:11px 13px}
  .summary .wide{grid-column:1/-1}
  .summary .k{color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.05em}
  .summary .v{font-size:22px;font-weight:700;margin-top:3px;font-variant-numeric:tabular-nums}
  .summary .ksub{color:var(--mut);font-size:11.5px;margin-top:2px}
  .summary .v.cats{font-size:13px;font-weight:500;line-height:1.7}
  .summary .v.cats span{display:inline-block;background:#1b2230;border:1px solid var(--line);border-radius:6px;padding:1px 8px;margin:2px 4px 2px 0;color:#cdd5e3}
  @media(max-width:680px){.summary{grid-template-columns:repeat(2,1fr)}}
  .feed{display:flex;flex-direction:column;gap:10px}
  .b{background:var(--card);border:1px solid var(--line);border-left-width:4px;border-radius:10px;padding:11px 13px}
  .b .top{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .score{font-weight:700;font-variant-numeric:tabular-nums;font-size:15px}
  .tier{font-size:11px;letter-spacing:.06em;font-weight:700;padding:2px 7px;border-radius:6px}
  .CRITICAL{border-left-color:#e5484d}.b.CRITICAL .tier{background:#3a1416;color:#ff6b6f}
  .HIGH{border-left-color:#f5803e}.b.HIGH .tier{background:#3a2412;color:#ffa666}
  .MEDIUM{border-left-color:#f5b042}.b.MEDIUM .tier{background:#3a3112;color:#ffd27a}
  .LOW{border-left-color:#4a90d9}.b.LOW .tier{background:#13243a;color:#7ab6ff}
  .title{font-weight:600}
  .cats{color:var(--mut);font-size:12px}
  .meta{color:var(--mut);font-size:11.5px;margin-top:5px;display:flex;gap:12px;flex-wrap:wrap}
  .meta a{color:#7ab6ff;text-decoration:none}
  .rat{margin-top:6px;font-size:12.5px;color:#cdd5e3}
  .empty{color:var(--mut);text-align:center;padding:40px 0}
  .new{animation:flash 1.2s ease-out}
  @keyframes flash{from{background:#1f2a1f}to{background:var(--card)}}
  .note{color:var(--mut);font-size:11.5px;margin:0 0 12px}
</style></head>
<body>
<header>
  <span id="dot" class="dot"></span>
  <div><h1>pump.fun bounty watch</h1><div class="sub" id="status">connecting…</div></div>
  <div class="pills">
    <span class="pill">CRITICAL <b id="cCRITICAL">0</b></span>
    <span class="pill">HIGH <b id="cHIGH">0</b></span>
    <span class="pill">MEDIUM <b id="cMEDIUM">0</b></span>
    <span class="pill">indexed <b id="cTotal">0</b></span>
  </div>
</header>
<main>
  <p class="note">Live abuse index of pump.fun bounties — enumerated on-chain (program <code>goGz…KiV</code>, un-deletable) and ranked by harm severity. Captured for reporting (platform T&S / NCMEC / IC3 / Action Fraud). Named targets are victims — do not contact or expose them.</p>
  <section id="summary" class="summary">
    <div class="stat"><div class="k">bounties indexed</div><div class="v" id="sTotal">—</div></div>
    <div class="stat"><div class="k">total reward pool</div><div class="v" id="sUsd">—</div><div class="ksub" id="sSol">—</div></div>
    <div class="stat"><div class="k">flagged</div><div class="v" id="sFlagged">—</div></div>
    <div class="stat"><div class="k">newest bounty</div><div class="v" id="sNewest">—</div><div class="ksub" id="sPrice">—</div></div>
    <div class="stat wide"><div class="k">harm breakdown</div><div class="v cats" id="sCats">—</div></div>
  </section>
  <div id="feed" class="feed"><div class="empty" id="empty">waiting for the first index pass…</div></div>
</main>
<script>
const feed = document.getElementById('feed'), empty = document.getElementById('empty');
const byId = new Map();
function counts(){const c={CRITICAL:0,HIGH:0,MEDIUM:0};for(const r of byId.values())if(c[r.tier]!=null)c[r.tier]++;
  cCRITICAL.textContent=c.CRITICAL;cHIGH.textContent=c.HIGH;cMEDIUM.textContent=c.MEDIUM;}
function card(r){
  const id='b_'+btoa(r.bounty.id).replace(/=/g,'');
  let el=document.getElementById(id);
  const cats=[...new Set((r.hits||[]).map(h=>h.category.replace(/_/g,' ')))].join(', ')||'—';
  const t=(r.bounty.title||r.bounty.description||'(untitled)');
  const link=r.bounty.url?'<a href="'+r.bounty.url+'" target="_blank" rel="noopener">open ↗</a>':'';
  const html='<div class="top"><span class="score">'+r.score+'</span><span class="tier">'+r.tier+'</span>'
    +'<span class="title">'+esc(t).slice(0,140)+'</span></div>'
    +'<div class="cats">'+esc(cats)+(r.targetsNamedPerson?' · <b style="color:#ff9a9a">named target</b>':'')+'</div>'
    +'<div class="rat">'+esc(r.rationale||'')+'</div>'
    +'<div class="meta">'+(r.bounty.author?'<span>by '+esc(r.bounty.author)+'</span>':'')
    +(r.bounty.reward?'<span>💰 '+esc(r.bounty.reward)+(r.bounty.raw&&r.bounty.raw.rewardSol&&SOLP?' (~'+usd(r.bounty.raw.rewardSol*SOLP)+')':'')+'</span>':'')+'<span>report: '+esc((r.reportTo||[]).join('; '))+'</span>'+link+'</div>';
  if(!el){el=document.createElement('div');el.id=id;el.className='b '+r.tier+' new';el.innerHTML=html;}
  else{el.className='b '+r.tier;el.innerHTML=html;}
  return el;
}
function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
function render(){
  const rows=[...byId.values()].sort((a,b)=>b.score-a.score||a.bounty.id.localeCompare(b.bounty.id));
  if(empty)empty.remove();
  feed.replaceChildren(...rows.map(card));counts();
}
function upsert(r){if(r.tier==='BENIGN')return;byId.set(r.bounty.id,r);}
const CATLABEL={csam_or_minor_sexual:'CSAM/minor',violence_solicitation:'violence',targeted_threat:'targeted threat',doxxing_pii:'doxxing',sexual_exploitation:'sexual exploit',harassment_named:'harassment',hate_protected:'hate',property_or_fraud_crime:'fraud/property',self_harm:'self-harm',other_flag:'other'};
let SOLP=0;
const usd=n=>'$'+Number(n).toLocaleString(undefined,{maximumFractionDigits:0});
function summarize(s){if(!s)return;
  if(s.solPriceUsd)SOLP=s.solPriceUsd;
  if(s.total!=null){sTotal.textContent=s.total;cTotal.textContent=s.total;}
  if(s.rewardUsd!=null)sUsd.textContent=usd(s.rewardUsd);
  if(s.rewardSol!=null)sSol.textContent=Number(s.rewardSol).toLocaleString(undefined,{maximumFractionDigits:1})+' SOL';
  if(SOLP)sPrice.textContent='SOL ≈ $'+SOLP.toLocaleString(undefined,{maximumFractionDigits:2});
  if(s.flagged!=null)sFlagged.textContent=s.flagged;
  if(s.newest)sNewest.textContent=new Date(s.newest).toLocaleDateString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
  if(s.categories){const ent=Object.entries(s.categories).sort((a,b)=>b[1]-a[1]);
    sCats.innerHTML=ent.length?ent.map(([k,v])=>'<span>'+esc(CATLABEL[k]||k)+' '+v+'</span>').join(''):'—';}
}
const es=new EventSource('/events');
es.addEventListener('snapshot',e=>{const d=JSON.parse(e.data);(d.ranked||[]).forEach(upsert);render();summarize(d.stats);});
es.addEventListener('flagged',e=>{upsert(JSON.parse(e.data).scored);render();});
es.addEventListener('pass',e=>{const d=JSON.parse(e.data);summarize(d);
  document.getElementById('status').textContent='last pass '+new Date(d.ts).toLocaleTimeString()+' · fetched '+d.fetched+' · flagged '+d.flagged;});
es.onopen=()=>{dot.className='dot live';if(status.textContent==='connecting…')status.textContent='connected — waiting for a pass';};
es.onerror=()=>{dot.className='dot dead';};
</script>
</body></html>`;
