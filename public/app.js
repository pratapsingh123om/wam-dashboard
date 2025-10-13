/* public/app.js — robust WAM frontend (safe, no duplicate declarations)
   - Uses window.WAM_API_BASE when provided
   - Runs after DOMContentLoaded
   - Single SSE connection with backoff
   - Single Chart instance updated in-place
   - Safe fallbacks to avoid ReferenceErrors
*/

(() => {
  // run after DOM ready
  document.addEventListener('DOMContentLoaded', () => {

    // --- config / API helper (single declaration) ---
    const API_BASE = (window.WAM_API_BASE || '').replace(/\/$/, '');
    const API = (path) => (API_BASE ? (API_BASE + path) : path);

    // --- small helpers ---
    const $ = id => document.getElementById(id);
    const q = sel => document.querySelector(sel);
    const log = (...a) => console.debug('[WAM]', ...a);
    function showStatus(msg, type='info'){
      const alertsBar = $('alerts');
      if(!alertsBar) return;
      alertsBar.textContent = msg;
      alertsBar.style.background = type==='ok' ? 'linear-gradient(90deg, rgba(0,255,170,0.04), rgba(0,255,170,0.01))'
        : (type==='warn' ? 'linear-gradient(90deg, rgba(255,200,80,0.04), rgba(255,120,0,0.01))' : 'transparent');
    }
    function parseNumber(v){ if(v===null||v===undefined||v==="") return null; const s=String(v).replace(/[^0-9.\-eE]/g,''); const n=Number(s); return Number.isFinite(n)?n:null; }
    function formatTS(ts){ try { return new Date(ts).toLocaleString(); } catch(e) { return String(ts); } }

    // --- DOM refs with safe fallbacks ---
    const fileIn = $('fileInput') || (() => { const i=document.createElement('input'); i.id='fileInput'; i.type='file'; i.accept='.csv,.xlsx,.xls'; (q('.top-controls')||document.body).appendChild(i); return i; })();
    const downloadBtn = $('downloadCSV') || (() => { const b=document.createElement('button'); b.id='downloadCSV'; b.className='btn'; b.textContent='Download CSV'; (q('.top-controls')||document.body).appendChild(b); return b; })();
    const analyzeBtn = $('analyzeBtn') || (() => { const b=document.createElement('button'); b.id='analyzeBtn'; b.className='btn'; b.textContent='Analyze'; (q('.top-controls')||document.body).appendChild(b); return b; })();
    const playBtn = $('playBtn'), pauseBtn = $('pauseBtn'), stepBtn = $('stepBtn'), pushBtn = $('pushBtn'), speed = $('speed');
    const statPH = $('statPH'), statTDS = $('statTDS'), statTURB = $('statTURB'), statIRON = $('statIRON');
    const mainCanvas = $('mainChart') || (() => { const c=document.createElement('canvas'); c.id='mainChart'; (q('.chart-card')||document.body).appendChild(c); return c; })();
    const donutPHCanvas = $('donutPH') || (() => { const c=document.createElement('canvas'); c.id='donutPH'; (q('.donuts')||document.body).appendChild(c); return c; })();
    const donutTDSCanvas = $('donutTDS') || (() => { const c=document.createElement('canvas'); c.id='donutTDS'; (q('.donuts')||document.body).appendChild(c); return c; })();
    const donutTURBCanvas = $('donutTURB') || (() => { const c=document.createElement('canvas'); c.id='donutTURB'; (q('.donuts')||document.body).appendChild(c); return c; })();
    const tableBody = (document.querySelector('#dataTable tbody')) || (() => { const wrap=q('.table-wrap')||document.body; const t=document.createElement('table'); t.id='dataTable'; t.innerHTML='<thead><tr><th>ts</th><th>pH</th><th>TDS</th><th>Turb</th><th>Iron</th></thead><tbody></tbody>'; wrap.appendChild(t); return t.querySelector('tbody'); })();
    const detectedText = $('detectedText') || (() => { const d=document.createElement('div'); d.id='detectedText'; (q('.suggestion')||document.body).appendChild(d); return d; })();
    const treatmentText = $('treatmentText') || (() => { const d=document.createElement('div'); d.id='treatmentText'; (q('.suggestion')||document.body).appendChild(d); return d; })();
    const siteSelect = $('siteSelect') || (() => { const s=document.createElement('select'); s.id='siteSelect'; s.innerHTML='<option value=\"Well-A\">Well-A</option><option value=\"Well-B\">Well-B</option>'; (q('.top-controls')||document.body).appendChild(s); return s; })();

    // thresholds fallback
    const thPhLow = $('th_ph_low') || (()=>{ const i=document.createElement('input'); i.id='th_ph_low'; i.type='number'; i.step='0.1'; i.value='6.5'; (q('.thresholds')||document.body).appendChild(i); return i; })();
    const thPhHigh = $('th_ph_high') || (()=>{ const i=document.createElement('input'); i.id='th_ph_high'; i.type='number'; i.step='0.1'; i.value='8.5'; (q('.thresholds')||document.body).appendChild(i); return i; })();
    const thTds = $('th_tds') || (()=>{ const i=document.createElement('input'); i.id='th_tds'; i.type='number'; i.step='1'; i.value='500'; (q('.thresholds')||document.body).appendChild(i); return i; })();
    const thTurb = $('th_turb') || (()=>{ const i=document.createElement('input'); i.id='th_turb'; i.type='number'; i.step='0.1'; i.value='5'; (q('.thresholds')||document.body).appendChild(i); return i; })();
    const thIron = $('th_iron') || (()=>{ const i=document.createElement('input'); i.id='th_iron'; i.type='number'; i.step='0.01'; i.value='0.3'; (q('.thresholds')||document.body).appendChild(i); return i; })();

    // manual input fallbacks
    const mPh = $('m_ph') || (()=>{ const i=document.createElement('input'); i.id='m_ph'; i.placeholder='pH'; i.type='number'; i.step='0.01'; (q('.controls')||document.body).appendChild(i); return i; })();
    const mTds = $('m_tds') || (()=>{ const i=document.createElement('input'); i.id='m_tds'; i.placeholder='TDS'; i.type='number'; (q('.controls')||document.body).appendChild(i); return i; })();
    const mTurb = $('m_turb') || (()=>{ const i=document.createElement('input'); i.id='m_turb'; i.placeholder='Turbidity'; i.type='number'; (q('.controls')||document.body).appendChild(i); return i; })();
    const mIron = $('m_iron') || (()=>{ const i=document.createElement('input'); i.id='m_iron'; i.placeholder='Iron'; i.type='number'; (q('.controls')||document.body).appendChild(i); return i; })();

    // state
    let rawData = [];
    let chartSeries = { ts: [], ph: [], tds: [], turb: [], iron: [] };
    const MAX_POINTS = 1000;
    let playing=false, playTimer=null, playIndex=0;

    // charts
    let mainChart=null, donutPH=null, donutTDS=null, donutTURB=null;
    let modelCharts = {};

    // throttled chart update
    let _chartUpdatePending = false;
    function scheduleChartUpdate(){
      if(_chartUpdatePending) return;
      _chartUpdatePending = true;
      requestAnimationFrame(() => {
        _chartUpdatePending = false;
        if(!mainChart) return;
        try {
          mainChart.data.labels = chartSeries.ts.map(ts => formatTS(ts));
          mainChart.data.datasets[0].data = chartSeries.ph;
          mainChart.data.datasets[1].data = chartSeries.tds;
          mainChart.data.datasets[2].data = chartSeries.turb;
          mainChart.data.datasets[3].data = chartSeries.iron;
          mainChart.update('none');
        } catch(e) { console.warn('[WAM] chart update failed', e); }
        const last = chartSeries.ts.length - 1;
        statPH && (statPH.textContent = last>=0 && chartSeries.ph[last]!=null ? Number(chartSeries.ph[last]).toFixed(2) : '—');
        statTDS && (statTDS.textContent = last>=0 && chartSeries.tds[last]!=null ? Math.round(chartSeries.tds[last]) : '—');
        statTURB && (statTURB.textContent = last>=0 && chartSeries.turb[last]!=null ? Number(chartSeries.turb[last]).toFixed(2) : '—');
        statIRON && (statIRON.textContent = last>=0 && chartSeries.iron[last]!=null ? Number(chartSeries.iron[last]).toFixed(2) : '—');
      });
    }

    // normalize and ingest
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
      try {
        const norm = rows.map(normalizeRow).filter(r => r.ph!==null || r.tds!==null || r.turb!==null || r.iron!==null);
        rawData = norm.sort((a,b) => new Date(a.ts) - new Date(b.ts));
        resetPlayback();
      } catch(e){ console.warn('ingestNormalized failed', e); }
    }

    // file import (CSV simple)
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
    function handleFile(file){
      if(!file) return;
      const name = file.name.toLowerCase();
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
          showStatus(`Imported ${json.length} rows`, 'ok');
        } catch(e){ console.error('file parse error', e); showStatus('Import failed', 'warn'); }
      };
      if(name.endsWith('.csv')) r.readAsText(file); else r.readAsBinaryString(file);
    }
    fileIn.addEventListener('change', e => handleFile(e.target.files && e.target.files[0]));

    // CSV download
    downloadBtn.addEventListener('click', () => {
      if(!chartSeries.ts.length){ showStatus('No data to download','warn'); return; }
      const rows = chartSeries.ts.map((ts,i)=>({ ts, ph: chartSeries.ph[i], tds: chartSeries.tds[i], turb: chartSeries.turb[i], iron: chartSeries.iron[i] }));
      const header = Object.keys(rows[0]).join(',');
      const csv = [header].concat(rows.map(r=>`${r.ts},${r.ph ?? ''},${r.tds ?? ''},${r.turb ?? ''},${r.iron ?? ''}`)).join('\n');
      const blob = new Blob([csv], { type:'text/csv;charset=utf-8;' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download='wam_readings.csv'; document.body.appendChild(a); a.click(); a.remove();
      showStatus('CSV exported','ok');
    });

    // playback / push
    function updateChartSeriesFromRaw(count = rawData.length){
      chartSeries = { ts: [], ph: [], tds: [], turb: [], iron: [] };
      for(let i=0;i<Math.min(count, rawData.length); i++){
        const r = rawData[i];
        chartSeries.ts.push(r.ts); chartSeries.ph.push(r.ph==null?null:Number(r.ph)); chartSeries.tds.push(r.tds==null?null:Number(r.tds));
        chartSeries.turb.push(r.turb==null?null:Number(r.turb)); chartSeries.iron.push(r.iron==null?null:Number(r.iron));
      }
    }
    function resetPlayback(){
      playIndex = 0;
      updateChartSeriesFromRaw(rawData.length);
      scheduleChartUpdate();
      updateDonuts();
      renderTable();
      evaluateLatest();
    }
    function startPlay(){
      if(!rawData.length){ showStatus('Upload CSV first','warn'); return; }
      if(playing) return;
      playing=true;
      const interval = Number(speed?.value) || 900;
      playTimer = setInterval(()=> {
        if(playIndex >= rawData.length){ stopPlay(); showStatus('End of data','warn'); return; }
        feedRow(rawData[playIndex++]);
      }, interval);
      showStatus('Playing','ok');
    }
    function stopPlay(){ playing=false; if(playTimer) clearInterval(playTimer); playTimer=null; showStatus('Paused','info'); }
    function stepPlay(){ if(playIndex>=rawData.length){ showStatus('End of data','warn'); return; } feedRow(rawData[playIndex++]); }
    playBtn && playBtn.addEventListener('click', startPlay);
    pauseBtn && pauseBtn.addEventListener('click', stopPlay);
    stepBtn && stepBtn.addEventListener('click', stepPlay);

    pushBtn && pushBtn.addEventListener('click', async () => {
      const row = { ts: new Date().toISOString(), ph: parseNumber(mPh?.value), tds: parseNumber(mTds?.value), turb: parseNumber(mTurb?.value), iron: parseNumber(mIron?.value), site: siteSelect.value || 'manual' };
      rawData.push(row); feedRow(row);
      try { await fetch(API('/api/sensor'), { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(row) }); showStatus('Pushed to server','ok'); } catch(e){ console.warn('push failed', e); showStatus('Push failed','warn'); }
      mPh.value=mTds.value=mTurb.value=mIron.value='';
    });

    // feedRow
    function feedRow(r){
      try {
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
      } catch(e){ console.warn('feedRow failed', e); }
    }

    // charts helpers
    function destroyChartInstance(c){ try{ if(c) c.destroy(); } catch(e){} }
    function createDonut(canvas){
      try {
        const ctx=canvas.getContext('2d');
        return new Chart(ctx, { type:'doughnut', data:{ labels:['Low','Mid','High'], datasets:[{ data:[0,0,0] }] }, options:{ plugins:{ legend:{ display:false } }, maintainAspectRatio:false } });
      } catch(e){ console.warn('createDonut failed', e); return null; }
    }

    function initCharts(){
      if(typeof Chart === 'undefined'){ console.warn('Chart.js missing — charts disabled'); showStatus('Chart.js not loaded','warn'); return; }
      if(!mainChart){
        try {
          const ctx = mainCanvas.getContext('2d');
          mainChart = new Chart(ctx, {
            type: 'line',
            data: {
              labels: chartSeries.ts.map(ts => formatTS(ts)),
              datasets: [
                { label:'pH', data: chartSeries.ph, tension:0.25, spanGaps:true, yAxisID:'y1' },
                { label:'TDS', data: chartSeries.tds, tension:0.25, spanGaps:true, yAxisID:'y2' },
                { label:'Turb', data: chartSeries.turb, tension:0.25, spanGaps:true, yAxisID:'y2' },
                { label:'Iron', data: chartSeries.iron, tension:0.25, spanGaps:true, yAxisID:'y2' }
              ]
            },
            options: { animation:false, maintainAspectRatio:false, scales:{ x:{ ticks:{ maxRotation:0 } }, y1:{ position:'left', title:{display:true,text:'pH'} }, y2:{ position:'right', grid:{ drawOnChartArea:false }, title:{display:true,text:'mg/L / NTU'} } }, plugins:{ legend:{ position:'top' } } }
          });
        } catch(e){ console.warn('initCharts mainChart failed', e); }
      }
      if(!donutPH) donutPH = createDonut(donutPHCanvas);
      if(!donutTDS) donutTDS = createDonut(donutTDSCanvas);
      if(!donutTURB) donutTURB = createDonut(donutTURBCanvas);
    }

    function updateDonuts(){
      if(!donutPH || !donutTDS || !donutTURB) return;
      const thr = { phLow: parseFloat(thPhLow.value)||6.5, phHigh: parseFloat(thPhHigh.value)||8.5, tds: parseFloat(thTds.value)||500, turb: parseFloat(thTurb.value)||5 };
      const bPH=[0,0,0], bTDS=[0,0,0], bTURB=[0,0,0];
      for(let i=0;i<chartSeries.ph.length;i++){ const v=chartSeries.ph[i]; if(v==null) continue; if(v<thr.phLow) bPH[0]++; else if(v>thr.phHigh) bPH[2]++; else bPH[1]++; }
      for(let i=0;i<chartSeries.tds.length;i++){ const v=chartSeries.tds[i]; if(v==null) continue; if(v < thr.tds/2) bTDS[0]++; else if(v > thr.tds) bTDS[2]++; else bTDS[1]++; }
      for(let i=0;i<chartSeries.turb.length;i++){ const v=chartSeries.turb[i]; if(v==null) continue; if(v <= thr.turb) bTURB[1]++; else bTURB[2]++; }
      try { donutPH.data.datasets[0].data = bPH; donutPH.update('none'); } catch(e){}
      try { donutTDS.data.datasets[0].data = bTDS; donutTDS.update('none'); } catch(e){}
      try { donutTURB.data.datasets[0].data = bTURB; donutTURB.update('none'); } catch(e){}
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

    // detection + prediction (unchanged)
    function evaluateLatest(){
      const n = chartSeries.ts.length;
      if(n===0){ detectedText && (detectedText.textContent='No data yet'); treatmentText && (treatmentText.textContent='—'); showStatus('No alerts','info'); return; }
      const last = n-1;
      const ph = chartSeries.ph[last], tds = chartSeries.tds[last], turb = chartSeries.turb[last], iron = chartSeries.iron[last];
      const thr = { phLow: parseFloat(thPhLow.value)||6.5, phHigh: parseFloat(thPhHigh.value)||8.5, tds: parseFloat(thTds.value)||500, turb: parseFloat(thTurb.value)||5, iron: parseFloat(thIron.value)||0.3 };
      const alertsArr=[];
      if(ph!=null && (ph < thr.phLow || ph > thr.phHigh)) alertsArr.push({k:'ph',v:ph});
      if(tds!=null && tds > thr.tds) alertsArr.push({k:'tds',v:tds});
      if(turb!=null && turb > thr.turb) alertsArr.push({k:'turb',v:turb});
      if(iron!=null && iron > thr.iron) alertsArr.push({k:'iron',v:iron});

      const top = alertsArr.length ? alertsArr[0] : null;
      if(top){
        detectedText && (detectedText.textContent = top.k==='ph'?`pH ${Number(top.v).toFixed(2)}`:`${top.k.toUpperCase()} ${Number(top.v).toFixed(2)}`);
        const treatments = { ph:'Adjust pH: lab-guided dosing.', tds:'Consider RO / ion-exchange.', turb:'Coagulation + filtration.', iron:'Oxidation + filtration.' };
        treatmentText && (treatmentText.textContent = treatments[top.k] || 'Inspect & lab test.');
        showStatus(`${alertsArr.length} immediate alert(s)`, 'warn');
      } else {
        detectedText && (detectedText.textContent='No immediate issues'); treatmentText && (treatmentText.textContent='—'); showStatus('All good','ok');
      }
    }

    // SSE single instance with backoff
    let es = null;
    let reconnectDelay = 1000;
    let sseClosedByUser = false;
    function startSSE(){
      if(es) return;
      try {
        const url = API('/stream');
        es = new EventSource(url);
        sseClosedByUser = false;
        es.onopen = () => { log('SSE open'); reconnectDelay = 1000; showStatus('SSE connected','ok'); };
        es.onerror = (e) => {
          console.warn('[WAM] SSE error', e);
          showStatus('SSE error — reconnecting', 'warn');
          try { es.close(); } catch(e){ }
          es = null;
          if(!sseClosedByUser) setTimeout(()=> { reconnectDelay = Math.min(reconnectDelay * 1.8, 30000); startSSE(); }, reconnectDelay);
        };
        es.onmessage = ev => {
          try {
            const obj = JSON.parse(ev.data);
            if(obj.type === 'reading' && obj.data) feedRow(obj.data);
            else if(obj.type === 'alert' && obj.data) showStatus('Alert: '+obj.data.message,'warn');
            else if(obj.type === 'thresholds' && obj.data) showStatus('Thresholds updated','info');
          } catch(e){ console.warn('SSE parse', e); }
        };
        window.addEventListener('beforeunload', () => { try { sseClosedByUser = true; es && es.close(); } catch(e){} });
      } catch(e){
        console.warn('startSSE failed', e);
        es = null;
        setTimeout(startSSE, reconnectDelay);
      }
    }
    function stopSSE(){
      sseClosedByUser = true;
      try { if(es) es.close(); } catch(e){}
      es = null;
    }

    // fetch initial rows from backend
    async function fetchInitial(){
      try {
        const r = await fetch(API('/api/readings?limit=500'));
        if(!r.ok){ console.warn('init fetch failed', r.status); showStatus('Could not load readings','warn'); return; }
        const rows = await r.json();
        rawData = rows.map(normalizeRow);
        resetPlayback();
        showStatus('Loaded readings from server', 'ok');
      } catch(e) { console.warn('fetchInitial error', e); showStatus('Server unreachable','warn'); }
    }

    // analyze (local via backend -> /api/analyze)
    let analyzeInFlight = false;
    analyzeBtn.addEventListener('click', async () => {
      if(analyzeInFlight) return;
      analyzeInFlight = true;
      analyzeBtn.disabled = true;
      try {
        const N = 200;
        const rows = chartSeries.ts.length ? chartSeries.ts.map((ts,i)=>({ ts, ph: chartSeries.ph[i], tds: chartSeries.tds[i], turb: chartSeries.turb[i], iron: chartSeries.iron[i], site: siteSelect.value })) : [];
        const payload = rows.length ? { rows: rows.slice(-N) } : { inputs: 'Summarize recent readings and suggest treatments.' };
        showStatus('Analyzing...', 'info'); log('[WAM] ANALYZE payload', payload);
        const r = await fetch(API('/api/analyze'), { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(payload) });
        const text = await r.text();
        let json = null;
        try { json = JSON.parse(text); } catch(e) { json = null; }
        log('[WAM] ANALYZE status', r.status, json || text);
        if(!r.ok){
          const errMsg = json && (json.error || json.detail) ? (json.error || json.detail) : (text || `HTTP ${r.status}`);
          showStatus('Analyze failed: ' + errMsg, 'warn');
          treatmentText && (treatmentText.textContent = errMsg);
          return;
        }
        if(json){
          treatmentText.textContent = json.generated_text || JSON.stringify(json, null, 2);
          if(Array.isArray(json.charts) && json.charts.length){
            const mainSpec = json.charts.find(c => c.id === 'main') || json.charts[0];
            if(mainSpec){
              try {
                chartSeries.ts = Array.isArray(mainSpec.labels) ? mainSpec.labels.slice() : chartSeries.ts;
                const ds = mainSpec.datasets || [];
                chartSeries.ph = ds[0] && Array.isArray(ds[0].data) ? ds[0].data.slice() : chartSeries.ph;
                chartSeries.tds = ds[1] && Array.isArray(ds[1].data) ? ds[1].data.slice() : chartSeries.tds;
                chartSeries.turb = ds[2] && Array.isArray(ds[2].data) ? ds[2].data.slice() : chartSeries.turb;
                chartSeries.iron = ds[3] && Array.isArray(ds[3].data) ? ds[3].data.slice() : chartSeries.iron;
                scheduleChartUpdate();
              } catch(e){ console.warn('apply mainSpec failed', e); }
            }
            // small model charts render
            renderModelCharts(json.charts);
          }
          showStatus('Analysis returned', 'ok');
        } else {
          treatmentText.textContent = text;
          showStatus('Analysis returned', 'ok');
        }
      } catch(e){
        console.error('analyze request failed', e);
        showStatus('Analyze request error (console)', 'warn');
        treatmentText && (treatmentText.textContent = String(e));
      } finally {
        analyzeInFlight = false;
        analyzeBtn.disabled = false;
      }
    });

    // renderModelCharts (safe)
    function renderModelCharts(chartsSpec){
      if(!Array.isArray(chartsSpec) || chartsSpec.length===0) return;
      let container = q('#model-charts');
      if(!container){ container = document.createElement('div'); container.id='model-charts'; container.style.marginTop='12px'; (q('.app')||document.body).appendChild(container); }
      try { Object.values(modelCharts).forEach(c=>{ try{ c.destroy(); }catch(e){} }); } catch(e){}
      modelCharts = {}; container.innerHTML = '';
      chartsSpec.forEach((spec, idx) => {
        try {
          const wrap = document.createElement('div'); wrap.style.margin='12px 0'; wrap.style.padding='10px'; wrap.style.background='rgba(255,255,255,0.02)'; wrap.style.borderRadius='8px';
          const title = document.createElement('h4'); title.textContent = spec.title || spec.id || `Chart ${idx+1}`; wrap.appendChild(title);
          const cvs = document.createElement('canvas'); cvs.id = `model-chart-${idx}`; wrap.appendChild(cvs);
          container.appendChild(wrap);
          const ctx = cvs.getContext('2d');
          const datasets = (spec.datasets || []).map(ds => ({ label: ds.label || 'series', data: ds.data || [], spanGaps:true, tension:0.25 }));
          const ch = new Chart(ctx, { type: spec.type || 'line', data:{ labels: spec.labels || [], datasets }, options:{ maintainAspectRatio:false, animation:false } });
          modelCharts[`m${idx}`] = ch;
        } catch(e){
          console.error('renderModelCharts error', e);
        }
      });
    }

    // startup sequence
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
      // start SSE and load initial readings
      startSSE();
      fetchInitial();
      log('startup done');
    }

    // expose minimal debug & control
    window.__WAM = { rawData, chartSeries, feedRow, resetPlayback, startPlay, stopPlay, startSSE, stopSSE };

    // call startup once
    try { startup(); } catch(e){ console.error('startup failed', e); showStatus('Startup error (console)', 'warn'); }

  }); // DOMContentLoaded
})();
