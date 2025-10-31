/* public/app.js — WAM Dashboard frontend (stable, analysis panel, lock) */
(() => {
  const API_BASE = (window.WAM_API_BASE || '').replace(/\/$/, '');
  const API = (path) => (API_BASE ? (API_BASE + path) : path);

  const $ = id => document.getElementById(id);
  const q = sel => document.querySelector(sel);
  const log = (...a) => console.debug('[WAM]', ...a);

  // make on-page log if missing
  function ensurePageLog(){
    if(document.getElementById('wam-log')) return;
    const logDiv = document.createElement('div');
    logDiv.id = 'wam-log';
    logDiv.style.position = 'fixed';
    logDiv.style.right = '12px';
    logDiv.style.bottom = '12px';
    logDiv.style.width = '360px';
    logDiv.style.maxHeight = '240px';
    logDiv.style.overflow = 'auto';
    logDiv.style.background = 'rgba(6,16,36,0.9)';
    logDiv.style.color = '#daf4ee';
    logDiv.style.padding = '8px';
    logDiv.style.borderRadius = '8px';
    logDiv.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Monaco, "Roboto Mono", monospace';
    logDiv.style.fontSize = '12px';
    logDiv.style.zIndex = 9999;
    document.body.appendChild(logDiv);
  }

  function logToPage(msg, level='info'){
    ensurePageLog();
    const container = document.getElementById('wam-log');
    const el = document.createElement('div');
    el.style.marginBottom = '6px';
    el.textContent = msg;
    container.insertBefore(el, container.firstChild);
    while(container.childNodes.length > 80) container.removeChild(container.lastChild);
    if(level === 'err') console.error('[WAM]', msg);
    else if(level === 'warn') console.warn('[WAM]', msg);
    else console.log('[WAM]', msg);
  }

  // DOM refs
  const fileIn = $('fileInput') || (()=>{ const i=document.createElement('input'); i.id='fileInput'; i.type='file'; i.accept='.csv,.xlsx,.xls'; (q('.top-controls')||document.body).appendChild(i); return i; })();
  const analyzeBtn = $('analyzeBtn') || (()=>{ const b=document.createElement('button'); b.id='analyzeBtn'; b.className='btn'; b.textContent='Analyze'; (q('.top-controls')||document.body).appendChild(b); return b; })();
  const mainCanvas = $('mainChart') || (()=>{ const c=document.createElement('canvas'); c.id='mainChart'; (q('.chart-card')||document.body).appendChild(c); return c; })();

  // stats & UI
  const statPH = $('statPH'), statTDS = $('statTDS'), statTURB = $('statTURB'), statIRON = $('statIRON');
  const detectedText = $('detectedText'), treatmentText = $('treatmentText'), tableBody = document.querySelector('#dataTable tbody');
  const donutPHCanvas = $('donutPH'), donutTDSCanvas = $('donutTDS'), donutTURBCanvas = $('donutTURB');
  const thPhLow = $('th_ph_low'), thPhHigh = $('th_ph_high'), thTds = $('th_tds'), thTurb = $('th_turb'), thIron = $('th_iron');
  const siteSelect = $('siteSelect');

  // If treatmentText missing (older UI) create simple container
  if(!treatmentText){
    const parent = q('.suggestion') || document.body;
    const txt = document.createElement('div'); txt.id='treatmentText'; txt.className='treatment'; txt.textContent='—';
    parent.appendChild(txt);
  }

  // create analysis panel if missing
  function ensureAnalysisPanel(){
    if(document.getElementById('analysisPanel')) return;
    const aside = document.createElement('aside');
    aside.id = 'analysisPanel';
    aside.style.position = 'relative';
    aside.style.marginTop = '12px';
    aside.className = 'card';
    const h = document.createElement('h3'); h.textContent = 'Analysis';
    const pre = document.createElement('pre'); pre.id='analysisPre'; pre.style.whiteSpace='pre-wrap'; pre.style.maxHeight='240px'; pre.style.overflow='auto'; pre.style.background='transparent'; pre.style.color='inherit';
    const clearBtn = document.createElement('button'); clearBtn.textContent='Clear analysis'; clearBtn.className='btn'; clearBtn.style.marginTop='8px';
    clearBtn.addEventListener('click', ()=>{ if(treatmentText){ treatmentText.dataset.locked = '0'; treatmentText.textContent='—'; document.getElementById('analysisPre').textContent=''; showStatus('Analysis cleared','info'); }});
    aside.appendChild(h); aside.appendChild(pre); aside.appendChild(clearBtn);
    (q('.right')||document.body).appendChild(aside);
  }
  ensureAnalysisPanel();

  // STATE
  let rawData = [];
  let chartSeries = { ts: [], ph: [], tds: [], turb: [], iron: [] };
  const MAX_POINTS = 1000;
  let mainChart=null, donutPH=null, donutTDS=null, donutTURB=null;

  // utils
  function parseNumber(v){ if(v===null||v===undefined||v==="") return null; const s=String(v).replace(/[^0-9.\-eE]/g,''); const n=Number(s); return Number.isFinite(n)?n:null; }
  function formatTS(ts){ try { return new Date(ts).toLocaleString(); } catch(e) { return String(ts); } }
  function showStatus(msg, type='info'){ const a=$('alerts'); if(a){ a.textContent=msg; a.style.background= type==='ok'? 'linear-gradient(90deg, rgba(0,255,170,0.04), rgba(0,255,170,0.01))' : (type==='warn'? 'linear-gradient(90deg, rgba(255,200,80,0.04), rgba(255,120,0,0.01))' : 'transparent'); } logToPage(msg, type==='warn'?'warn':'info'); }

  // chart update scheduling (in-place update)
  let _chartUpdatePending = false;
  function scheduleChartUpdate(){
    if(_chartUpdatePending) return;
    _chartUpdatePending = true;
    requestAnimationFrame(() => {
      _chartUpdatePending = false;
      if(!mainChart) return;
      try {
        mainChart.data.labels = chartSeries.ts.map(formatTS);
        mainChart.data.datasets[0].data = chartSeries.ph;
        mainChart.data.datasets[1].data = chartSeries.tds;
        mainChart.data.datasets[2].data = chartSeries.turb;
        mainChart.data.datasets[3].data = chartSeries.iron;
        mainChart.update('none');
      } catch(e){ logToPage('chart update failed: '+String(e),'err'); }
      const last = chartSeries.ts.length - 1;
      statPH && (statPH.textContent = last>=0 && chartSeries.ph[last]!=null ? Number(chartSeries.ph[last]).toFixed(2) : '—');
      statTDS && (statTDS.textContent = last>=0 && chartSeries.tds[last]!=null ? Math.round(chartSeries.tds[last]) : '—');
      statTURB && (statTURB.textContent = last>=0 && chartSeries.turb[last]!=null ? Number(chartSeries.turb[last]).toFixed(2) : '—');
      statIRON && (statIRON.textContent = last>=0 && chartSeries.iron[last]!=null ? Number(chartSeries.iron[last]).toFixed(2) : '—');
    });
  }

  // init main charts
  function createDonut(canvas){
    try {
      const ctx = canvas.getContext('2d');
      return new Chart(ctx, { type:'doughnut', data:{ labels:['Low','Mid','High'], datasets:[{ data:[0,0,0] }] }, options:{ plugins:{ legend:{ display:false } }, maintainAspectRatio:false } });
    } catch(e){ logToPage('createDonut failed: '+String(e),'warn'); return null; }
  }
  function initCharts(){
    if(typeof Chart === 'undefined'){ showStatus('Chart.js not loaded','warn'); return; }
    if(!mainChart && mainCanvas){
      try {
        const ctx = mainCanvas.getContext('2d');
        mainChart = new Chart(ctx, {
          type:'line',
          data:{ labels: chartSeries.ts.map(formatTS), datasets:[
            { label:'pH', data: chartSeries.ph, tension:0.25, spanGaps:true, yAxisID:'y1' },
            { label:'TDS', data: chartSeries.tds, tension:0.25, spanGaps:true, yAxisID:'y2' },
            { label:'Turb', data: chartSeries.turb, tension:0.25, spanGaps:true, yAxisID:'y2' },
            { label:'Iron', data: chartSeries.iron, tension:0.25, spanGaps:true, yAxisID:'y2' }
          ]},
          options:{ animation:false, maintainAspectRatio:false, scales:{ x:{ ticks:{ maxRotation:0 } }, y1:{ position:'left' }, y2:{ position:'right', grid:{ drawOnChartArea:false } } }, plugins:{ legend:{ position:'top' } } }
        });
      } catch(e){ logToPage('init mainChart failed: '+String(e),'err'); }
    }
    if(donutPHCanvas && !donutPH) donutPH = createDonut(donutPHCanvas);
    if(donutTDSCanvas && !donutTDS) donutTDS = createDonut(donutTDSCanvas);
    if(donutTURBCanvas && !donutTURB) donutTURB = createDonut(donutTURBCanvas);
  }

  function updateDonuts(){
    if(!donutPH || !donutTDS || !donutTURB) return;
    const thr = { phLow: parseFloat(thPhLow?.value)||6.5, phHigh: parseFloat(thPhHigh?.value)||8.5, tds: parseFloat(thTds?.value)||500, turb: parseFloat(thTurb?.value)||5 };
    const bPH=[0,0,0], bTDS=[0,0,0], bTURB=[0,0,0];
    for(let i=0;i<chartSeries.ph.length;i++){ const v=chartSeries.ph[i]; if(v==null) continue; if(v<thr.phLow) bPH[0]++; else if(v>thr.phHigh) bPH[2]++; else bPH[1]++; }
    for(let i=0;i<chartSeries.tds.length;i++){ const v=chartSeries.tds[i]; if(v==null) continue; if(v < thr.tds/2) bTDS[0]++; else if(v > thr.tds) bTDS[2]++; else bTDS[1]++; }
    for(let i=0;i<chartSeries.turb.length;i++){ const v=chartSeries.turb[i]; if(v==null) continue; if(v <= thr.turb) bTURB[1]++; else bTURB[2]++; }
    try{ donutPH.data.datasets[0].data = bPH; donutPH.update('none'); } catch(e){}
    try{ donutTDS.data.datasets[0].data = bTDS; donutTDS.update('none'); } catch(e){}
    try{ donutTURB.data.datasets[0].data = bTURB; donutTURB.update('none'); } catch(e){}
  }

  function renderTable(){
    if(!tableBody) return;
    tableBody.innerHTML = '';
    const n = chartSeries.ts.length;
    for(let i=n-1;i>=Math.max(0,n-20);i--){
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${formatTS(chartSeries.ts[i])}</td><td>${chartSeries.ph[i]==null?'—':Number(chartSeries.ph[i]).toFixed(2)}</td><td>${chartSeries.tds[i]==null?'—':Math.round(chartSeries.tds[i])}</td><td>${chartSeries.turb[i]==null?'—':Number(chartSeries.turb[i]).toFixed(2)}</td><td>${chartSeries.iron[i]==null?'—':Number(chartSeries.iron[i]).toFixed(2)}</td>`;
      tableBody.appendChild(tr);
    }
  }

  function normalizeRow(r){
    return {
      ts: r.ts || r.time || r.timestamp || r.date || new Date().toISOString(),
      ph: parseNumber(r.ph ?? r.pH ?? r['pH']),
      tds: parseNumber(r.tds ?? r.TDS),
      turb: parseNumber(r.turb ?? r.turbidity),
      iron: parseNumber(r.iron ?? r.Iron),
      site: r.site || r.Site || (siteSelect?.value||'unknown'),
      lat: parseNumber(r.lat ?? r.latitude),
      lon: parseNumber(r.lon ?? r.longitude)
    };
  }

  function ingestNormalized(rows){
    const norm = rows.map(normalizeRow).filter(r => r.ph!==null || r.tds!==null || r.turb!==null || r.iron!==null);
    rawData = norm.sort((a,b) => new Date(a.ts) - new Date(b.ts));
    playIndex = 0;
    updateChartSeriesFromRaw(rawData.length);
    scheduleChartUpdate();
    updateDonuts();
    renderTable();
    evaluateLatest();
  }

  function csvToJson(text){
    const lines = text.split(/\r?\n/).filter(l=>l.trim()!=='');
    if(lines.length===0) return [];
    const headers = lines[0].split(',').map(h=>h.trim());
    return lines.slice(1).map(line=>{
      const cols = line.split(',');
      const obj = {};
      for(let i=0;i<headers.length;i++) obj[headers[i]] = (cols[i]===undefined)?'':cols[i].trim();
      return obj;
    });
  }

  if(fileIn) fileIn.addEventListener('change', e=>{
    const f = e.target.files && e.target.files[0];
    if(!f) return;
    const name = f.name.toLowerCase();
    const r = new FileReader();
    r.onload = ev => {
      try {
        let json;
        if(name.endsWith('.csv')) json = csvToJson(ev.target.result);
        else {
          if(!window.XLSX){ showStatus('SheetJS not available; cannot parse xlsx','warn'); return; }
          const wb = XLSX.read(ev.target.result, { type:'binary' });
          const first = wb.Sheets[wb.SheetNames[0]];
          json = XLSX.utils.sheet_to_json(first, { raw:false, defval:'' });
        }
        ingestNormalized(json);
        logToPage(`Imported ${json.length} rows`);
      } catch(e){ logToPage('file parse error: '+String(e),'err'); showStatus('Import failed','warn'); }
    };
    if(name.endsWith('.csv')) r.readAsText(f); else r.readAsBinaryString(f);
  });

  // playback small helpers used by UI
  let playIndex = 0;
  function updateChartSeriesFromRaw(count = rawData.length){
    chartSeries = { ts: [], ph: [], tds: [], turb: [], iron: [] };
    for(let i=0;i<Math.min(count, rawData.length); i++){
      const r = rawData[i];
      chartSeries.ts.push(r.ts); chartSeries.ph.push(r.ph==null?null:Number(r.ph)); chartSeries.tds.push(r.tds==null?null:Number(r.tds));
      chartSeries.turb.push(r.turb==null?null:Number(r.turb)); chartSeries.iron.push(r.iron==null?null:Number(r.iron));
    }
  }

  function feedRow(r){
    const ts = (typeof r.ts === 'string') ? r.ts : new Date(r.ts).toISOString();
    chartSeries.ts.push(ts);
    chartSeries.ph.push(r.ph==null?null:Number(r.ph));
    chartSeries.tds.push(r.tds==null?null:Number(r.tds));
    chartSeries.turb.push(r.turb==null?null:Number(r.turb));
    chartSeries.iron.push(r.iron==null?null:Number(r.iron));
    if(chartSeries.ts.length > MAX_POINTS) for(const k in chartSeries) chartSeries[k].shift();
    scheduleChartUpdate();
    updateDonuts();
    renderTable();
    evaluateLatest();
  }

  // evaluation - BUT DO NOT overwrite analysis if locked
  function evaluateLatest(){
    const n = chartSeries.ts.length;
    if(n===0){ detectedText && (detectedText.textContent='No data yet'); if(treatmentText && treatmentText.dataset.locked!=='1') treatmentText.textContent='—'; showStatus('No alerts','info'); return; }
    const last = n-1;
    const ph = chartSeries.ph[last], tds = chartSeries.tds[last], turb = chartSeries.turb[last], iron = chartSeries.iron[last];
    const thr = { phLow: parseFloat(thPhLow?.value)||6.5, phHigh: parseFloat(thPhHigh?.value)||8.5, tds: parseFloat(thTds?.value)||500, turb: parseFloat(thTurb?.value)||5, iron: parseFloat(thIron?.value)||0.3 };
    const alertsArr=[];
    if(ph!=null && (ph < thr.phLow || ph > thr.phHigh)) alertsArr.push({k:'ph',v:ph});
    if(tds!=null && tds > thr.tds) alertsArr.push({k:'tds',v:tds});
    if(turb!=null && turb > thr.turb) alertsArr.push({k:'turb',v:turb});
    if(iron!=null && iron > thr.iron) alertsArr.push({k:'iron',v:iron});

    const top = alertsArr.length ? alertsArr[0] : null;
    if(top){
      detectedText && (detectedText.textContent = top.k==='ph'?`pH ${Number(top.v).toFixed(2)}`:`${top.k.toUpperCase()} ${Number(top.v).toFixed(2)}`);
      if(treatmentText && treatmentText.dataset.locked === '1'){
        logToPage('Treatment locked by analysis — not overwriting', 'info');
      } else {
        const treatments = { ph:'Adjust pH: lime for low; acid dosing for high (lab guidance).', tds:'Consider RO or ion-exchange for high TDS.', turb:'Investigate source; coagulation + filtration.', iron:'Oxidation + filtration or aeration.' };
        treatmentText && (treatmentText.textContent = treatments[top.k] || 'Inspect & lab test.');
      }
      showStatus(`${alertsArr.length} immediate alert(s)`, 'warn');
    } else {
      detectedText && (detectedText.textContent='No immediate issues');
      if(!(treatmentText && treatmentText.dataset.locked === '1')) treatmentText && (treatmentText.textContent='—');
      showStatus('All good', 'ok');
    }
  }

  // SSE (single instance, backoff)
  let es = null;
  let reconnectDelay = 1000;
  function startSSE(){
    if(es) return;
    try {
      const url = API('/stream');
      logToPage('SSE -> ' + url);
      es = new EventSource(url);
      es.onopen = () => { logToPage('SSE open'); reconnectDelay = 1000; showStatus('SSE connected','ok'); };
      es.onerror = (e) => { logToPage('SSE error, reconnecting', 'warn'); showStatus('SSE error — reconnecting', 'warn'); try{ es.close(); }catch(e){} es=null; setTimeout(()=>{ reconnectDelay = Math.min(reconnectDelay*1.8,30000); startSSE(); }, reconnectDelay); };
      es.onmessage = ev => {
        try {
          const obj = JSON.parse(ev.data);
          if(obj.type === 'reading' && obj.data) feedRow(obj.data);
          else if(obj.type === 'alert' && obj.data) showStatus('Alert: '+obj.data.message,'warn');
          else if(obj.type === 'thresholds' && obj.data) showStatus('Thresholds updated','info');
        } catch(e){ logToPage('SSE parse: '+String(e),'warn'); }
      };
      window.addEventListener('beforeunload', ()=>{ try{ es && es.close(); }catch(e){} });
    } catch(e){ logToPage('startSSE failed: '+String(e),'err'); es=null; setTimeout(startSSE, reconnectDelay); }
  }

  // fetch initial readings
  async function fetchInitial(){
    try {
      const r = await fetch(API('/api/readings?limit=500'));
      if(!r.ok){ logToPage('init fetch failed: '+r.status,'warn'); showStatus('Could not load readings','warn'); return; }
      const rows = await r.json();
      rawData = rows.map(normalizeRow);
      updateChartSeriesFromRaw(rawData.length);
      scheduleChartUpdate();
      updateDonuts();
      renderTable();
      evaluateLatest();
      showStatus('Loaded readings from server','ok');
    } catch(e){ logToPage('fetchInitial error: '+String(e),'err'); showStatus('Server unreachable','warn'); }
  }

  // ANALYZE (locks displayed analysis)
  let analyzeInFlight = false;
  if(analyzeBtn) analyzeBtn.addEventListener('click', async ()=>{
    if(analyzeInFlight) return;
    analyzeInFlight = true; analyzeBtn.disabled = true;
    try {
      const N = 200;
      const rows = chartSeries.ts.length ? chartSeries.ts.map((ts,i)=>({ ts, ph: chartSeries.ph[i], tds: chartSeries.tds[i], turb: chartSeries.turb[i], iron: chartSeries.iron[i], site: siteSelect?.value })) : [];
      const payload = rows.length ? { rows: rows.slice(-N) } : { inputs: 'Summarize recent readings and suggest treatments.' };
      showStatus('Analyzing...', 'info');
      logToPage('[ANALYZE] sending rows=' + (rows.length));
      const r = await fetch(API('/api/analyze'), { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(payload) });
      const text = await r.text();
      logToPage('[ANALYZE] raw response length=' + text.length);
      let json = null;
      try { json = JSON.parse(text); } catch(e){ json = null; }
      if(!r.ok){
        const errMsg = json && (json.error || json.detail) ? (json.error || json.detail) : (text || `HTTP ${r.status}`);
        showStatus('Analyze failed: ' + errMsg, 'warn');
        if(treatmentText) { treatmentText.textContent = errMsg; treatmentText.dataset.locked = '0'; }
        return;
      }
      ensureAnalysisPanel();
      const pre = document.getElementById('analysisPre');
      if(json){
        // place readable text in treatmentText and lock it
        const resultText = json.generated_text || json.generatedText || json.text || JSON.stringify(json, null, 2);
        if(treatmentText){
          treatmentText.textContent = resultText;
          treatmentText.dataset.locked = '1';
        }
        if(pre) pre.textContent = typeof resultText === 'string' ? resultText : JSON.stringify(resultText, null, 2);
        // if charts returned — apply to chartSeries
        if(Array.isArray(json.charts) && json.charts.length){
          const mainSpec = json.charts.find(c=>c.id==='main') || json.charts[0];
          if(mainSpec){
            try {
              chartSeries.ts = Array.isArray(mainSpec.labels) ? mainSpec.labels.slice() : chartSeries.ts;
              const ds = mainSpec.datasets || [];
              chartSeries.ph = ds[0] && Array.isArray(ds[0].data) ? ds[0].data.slice() : chartSeries.ph;
              chartSeries.tds = ds[1] && Array.isArray(ds[1].data) ? ds[1].data.slice() : chartSeries.tds;
              chartSeries.turb = ds[2] && Array.isArray(ds[2].data) ? ds[2].data.slice() : chartSeries.turb;
              chartSeries.iron = ds[3] && Array.isArray(ds[3].data) ? ds[3].data.slice() : chartSeries.iron;
              scheduleChartUpdate();
            } catch(e){ logToPage('apply mainSpec failed: '+String(e),'warn'); }
          }
        }
        showStatus('Analysis returned', 'ok');
      } else {
        if(treatmentText){ treatmentText.textContent = text; treatmentText.dataset.locked = '1'; }
        if(pre) pre.textContent = text;
        showStatus('Analysis returned', 'ok');
      }
    } catch(e){
      logToPage('analyze request failed: ' + String(e),'err');
      showStatus('Analyze request error','warn');
      if(treatmentText){ treatmentText.textContent = String(e); treatmentText.dataset.locked = '0'; }
    } finally {
      analyzeInFlight = false; analyzeBtn.disabled = false;
    }
  });

  // startup
  function startup(){
    if(!rawData.length){
      const now = Date.now();
      rawData = [ { ts:new Date(now-120000).toISOString(), ph:7.1, tds:320, turb:1.2, iron:0.05, site:'demo' }, { ts:new Date(now-60000).toISOString(), ph:7.0, tds:325, turb:1.0, iron:0.04, site:'demo' } ];
    }
    updateChartSeriesFromRaw(rawData.length);
    initCharts();
    scheduleChartUpdate();
    updateDonuts();
    renderTable();
    startSSE();
    fetchInitial();
    logToPage('startup done', 'info');
  }

  // expose for debug
  window.__WAM = { rawData, chartSeries, feedRow, ingestNormalized };

  setTimeout(startup, 80);
})();
