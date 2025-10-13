/* public/app.js — WAM frontend (fixed: preserve analysis output)
   Key fixes:
    - When analyze returns, put generated_text into #treatmentText and "lock" it.
    - evaluateLatest() will not overwrite treatmentText while locked.
    - Small "Clear analysis" button added so user can unlock.
    - Extra logging of analyze response (page log + console).
*/

(() => {
  // visible on-page logger helper
  function now(){ return new Date().toISOString().replace('T',' ').replace(/\..+$/,''); }
  function logToPage(msg, level='info'){
    try {
      const container = document.getElementById('wam-log');
      if(container){
        const el = document.createElement('div');
        el.className = 'line ' + level;
        const ts = document.createElement('span'); ts.className='time'; ts.textContent = '[' + now().split(' ')[1] + '] ';
        const text = document.createElement('span'); text.textContent = msg;
        el.appendChild(ts);
        el.appendChild(text);
        container.insertBefore(el, container.firstChild);
        while(container.childNodes.length > 60) container.removeChild(container.lastChild);
      }
    } catch(e){}
    if(level === 'err') console.error('[WAM]', msg); else if(level === 'warn') console.warn('[WAM]', msg); else console.log('[WAM]', msg);
  }

  document.addEventListener('DOMContentLoaded', () => {
    const API_BASE = (window.WAM_API_BASE || '').replace(/\/$/, '');
    const API = (path) => (API_BASE ? (API_BASE + path) : path);

    const $ = id => document.getElementById(id);
    const q = sel => document.querySelector(sel);

    function showStatus(msg, type='info'){
      const b = $('alerts'); if(!b) return;
      b.textContent = msg;
      b.style.background = type==='ok'? 'linear-gradient(90deg, rgba(0,255,170,0.04), rgba(0,255,170,0.01))'
        : (type==='warn'? 'linear-gradient(90deg, rgba(255,200,80,0.04), rgba(255,120,0,0.01))' : 'transparent');
      logToPage(msg, type);
    }

    // DOM refs (safely)
    const fileIn = $('fileInput');
    const downloadBtn = $('downloadCSV');
    const analyzeBtn = $('analyzeBtn');
    const playBtn = $('playBtn'), pauseBtn = $('pauseBtn'), stepBtn = $('stepBtn'), pushBtn = $('pushBtn'), speed = $('speed');
    const statPH = $('statPH'), statTDS = $('statTDS'), statTURB = $('statTURB'), statIRON = $('statIRON');
    const mainCanvas = $('mainChart');
    const donutPHCanvas = $('donutPH'), donutTDSCanvas = $('donutTDS'), donutTURBCanvas = $('donutTURB');
    const tableBody = document.querySelector('#dataTable tbody');
    const detectedText = $('detectedText'), treatmentText = $('treatmentText'), siteSelect = $('siteSelect');

    // thresholds & manual
    const thPhLow = $('th_ph_low'), thPhHigh = $('th_ph_high'), thTds = $('th_tds'), thTurb = $('th_turb'), thIron = $('th_iron');
    const mPh = $('m_ph'), mTds = $('m_tds'), mTurb = $('m_turb'), mIron = $('m_iron');

    // ensure there is an on-page log panel (index.html should contain #wam-log)
    if(!document.getElementById('wam-log')){
      const logDiv = document.createElement('div');
      logDiv.id = 'wam-log';
      logDiv.style.position = 'fixed';
      logDiv.style.right = '12px';
      logDiv.style.bottom = '12px';
      logDiv.style.width = '360px';
      logDiv.style.maxHeight = '220px';
      logDiv.style.overflow = 'auto';
      logDiv.style.background = 'rgba(0,0,0,0.6)';
      logDiv.style.color = '#dbeef0';
      logDiv.style.padding = '8px';
      logDiv.style.borderRadius = '8px';
      logDiv.style.fontFamily = 'monospace';
      logDiv.style.fontSize = '12px';
      logDiv.style.zIndex = 9999;
      document.body.appendChild(logDiv);
    }

    // Add a Clear Analysis button next to treatmentText for unlocking
    function ensureClearButton(){
      if(!treatmentText) return;
      if(document.getElementById('clear-analysis-btn')) return;
      const btn = document.createElement('button');
      btn.id = 'clear-analysis-btn';
      btn.textContent = 'Clear analysis';
      btn.style.marginTop = '8px';
      btn.className = 'btn';
      btn.addEventListener('click', () => {
        if(treatmentText){
          treatmentText.dataset.locked = '0';
          treatmentText.textContent = '—';
          showStatus('Analysis cleared', 'info');
        }
      });
      treatmentText.parentNode.appendChild(btn);
    }

    // helpers
    function parseNumber(v){ if(v===null||v===undefined||v==="") return null; const s=String(v).replace(/[^0-9.\-eE]/g,''); const n=Number(s); return Number.isFinite(n)?n:null; }
    function formatTS(ts){ try { return new Date(ts).toLocaleString(); } catch(e) { return String(ts); } }

    // simple CSV parsing
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

    // data state
    let rawData = [];
    let chartSeries = { ts: [], ph: [], tds: [], turb: [], iron: [] };
    const MAX_POINTS = 1000;
    let playing=false, playTimer=null, playIndex=0;

    // charts
    let mainChart=null, donutPH=null, donutTDS=null, donutTURB=null;
    let modelCharts = {};

    // chart update throttling
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
        } catch(e){ logToPage('chart update failed: '+String(e), 'err'); }
        const last = chartSeries.ts.length - 1;
        statPH && (statPH.textContent = last>=0 && chartSeries.ph[last]!=null ? Number(chartSeries.ph[last]).toFixed(2) : '—');
        statTDS && (statTDS.textContent = last>=0 && chartSeries.tds[last]!=null ? Math.round(chartSeries.tds[last]) : '—');
        statTURB && (statTURB.textContent = last>=0 && chartSeries.turb[last]!=null ? Number(chartSeries.turb[last]).toFixed(2) : '—');
        statIRON && (statIRON.textContent = last>=0 && chartSeries.iron[last]!=null ? Number(chartSeries.iron[last]).toFixed(2) : '—');
      });
    }

    // normalize row
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
        logToPage(`Imported ${rawData.length} rows`, 'info');
      } catch(e){ logToPage('ingestNormalized failed: '+String(e), 'err'); }
    }

    // file import handler
    if(fileIn) fileIn.addEventListener('change', e => {
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
        } catch(e){ logToPage('file parse error: '+String(e), 'err'); showStatus('Import failed', 'warn'); }
      };
      if(name.endsWith('.csv')) r.readAsText(f); else r.readAsBinaryString(f);
    });

    // CSV download
    if(downloadBtn) downloadBtn.addEventListener('click', () => {
      if(!chartSeries.ts.length){ showStatus('No data to download','warn'); return; }
      const rows = chartSeries.ts.map((ts,i)=>({ ts, ph: chartSeries.ph[i], tds: chartSeries.tds[i], turb: chartSeries.turb[i], iron: chartSeries.iron[i] }));
      const header = Object.keys(rows[0]).join(',');
      const csv = [header].concat(rows.map(r=>`${r.ts},${r.ph ?? ''},${r.tds ?? ''},${r.turb ?? ''},${r.iron ?? ''}`)).join('\n');
      const blob = new Blob([csv], { type:'text/csv;charset=utf-8;' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download='wam_readings.csv'; document.body.appendChild(a); a.click(); a.remove();
      showStatus('CSV exported','ok');
    });

    // playback / push helpers
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
      const row = { ts: new Date().toISOString(), ph: parseNumber(mPh?.value), tds: parseNumber(mTds?.value), turb: parseNumber(mTurb?.value), iron: parseNumber(mIron?.value), site: siteSelect?.value || 'manual' };
      rawData.push(row); feedRow(row);
      try { await fetch(API('/api/sensor'), { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(row) }); showStatus('Pushed to server','ok'); } catch(e){ logToPage('push failed: '+String(e), 'warn'); showStatus('Push failed','warn'); }
      if(mPh) mPh.value=''; if(mTds) mTds.value=''; if(mTurb) mTurb.value=''; if(mIron) mIron.value='';
    });

    // feed row
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
      } catch(e){ logToPage('feedRow failed: '+String(e), 'err'); }
    }

    // charts creation
    function createDonut(canvas){
      try {
        const ctx = canvas.getContext('2d');
        return new Chart(ctx, { type:'doughnut', data:{ labels:['Low','Mid','High'], datasets:[{ data:[0,0,0] }] }, options:{ plugins:{ legend:{ display:false } }, maintainAspectRatio:false } });
      } catch(e){ logToPage('createDonut failed: '+String(e), 'warn'); return null; }
    }

    function initCharts(){
      if(typeof Chart === 'undefined'){ logToPage('Chart.js missing — charts disabled', 'warn'); showStatus('Chart.js not loaded','warn'); return; }
      if(!mainChart && mainCanvas){
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
        } catch(e){ logToPage('initCharts mainChart failed: '+String(e), 'err'); }
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

    // evaluateLatest respects analysis lock
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
        // DO NOT overwrite treatmentText if locked by analysis
        if(treatmentText && treatmentText.dataset.locked === '1'){
          logToPage('Treatment text locked by analysis; not overwriting with heuristic.', 'info');
        } else {
          const treatments = { ph:'Adjust pH: lime for low; acid dosing for high (lab guidance).', tds:'Consider RO or ion-exchange for high TDS.', turb:'Investigate source; coagulation + filtration.', iron:'Oxidation + filtration or aeration.' };
          treatmentText && (treatmentText.textContent = treatments[top.k] || 'Inspect & lab test.');
        }
        showStatus(`${alertsArr.length} immediate alert(s)`, 'warn');
      } else {
        detectedText && (detectedText.textContent='No immediate issues');
        if(!(treatmentText && treatmentText.dataset.locked === '1')) {
          treatmentText && (treatmentText.textContent='—');
        }
        showStatus('All good','ok');
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
        logToPage('SSE -> ' + url, 'info');
        es = new EventSource(url);
        sseClosedByUser = false;
        es.onopen = () => { logToPage('SSE open', 'info'); reconnectDelay = 1000; showStatus('SSE connected','ok'); };
        es.onerror = (e) => {
          logToPage('SSE error, reconnecting', 'warn'); showStatus('SSE error — reconnecting', 'warn');
          try { es.close(); } catch(e){}
          es = null;
          if(!sseClosedByUser) setTimeout(()=> { reconnectDelay = Math.min(reconnectDelay * 1.8, 30000); startSSE(); }, reconnectDelay);
        };
        es.onmessage = ev => {
          try {
            const obj = JSON.parse(ev.data);
            if(obj.type === 'reading' && obj.data) feedRow(obj.data);
            else if(obj.type === 'alert' && obj.data) showStatus('Alert: '+obj.data.message,'warn');
            else if(obj.type === 'thresholds' && obj.data) showStatus('Thresholds updated','info');
          } catch(e){ logToPage('SSE parse error: '+String(e), 'warn'); }
        };
        window.addEventListener('beforeunload', () => { try { sseClosedByUser = true; es && es.close(); } catch(e){} });
      } catch(e){ logToPage('startSSE failed: '+String(e), 'err'); es=null; setTimeout(startSSE, reconnectDelay); }
    }
    function stopSSE(){ sseClosedByUser=true; try{ es && es.close(); } catch(e){} es=null; }

    // fetch initial rows
    async function fetchInitial(){
      try {
        const r = await fetch(API('/api/readings?limit=500'));
        if(!r.ok){ logToPage('/api/readings failed: '+r.status, 'warn'); showStatus('Could not load readings','warn'); return; }
        const rows = await r.json();
        rawData = rows.map(normalizeRow);
        resetPlayback();
        showStatus('Loaded readings from server', 'ok');
      } catch(e){ logToPage('fetchInitial error: '+String(e), 'err'); showStatus('Server unreachable','warn'); }
    }

    // analyze (preserve text)
    let analyzeInFlight = false;
    if(analyzeBtn) analyzeBtn.addEventListener('click', async () => {
      if(analyzeInFlight) return;
      analyzeInFlight = true;
      analyzeBtn.disabled = true;
      try {
        const N = 200;
        const rows = chartSeries.ts.length ? chartSeries.ts.map((ts,i)=>({ ts, ph: chartSeries.ph[i], tds: chartSeries.tds[i], turb: chartSeries.turb[i], iron: chartSeries.iron[i], site: siteSelect?.value })) : [];
        const payload = rows.length ? { rows: rows.slice(-N) } : { inputs: 'Summarize recent readings and suggest treatments.' };
        showStatus('Analyzing...', 'info');
        logToPage('[ANALYZE] sending payload (rows=' + (rows.length) + ')', 'info');
        const r = await fetch(API('/api/analyze'), { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(payload) });
        const text = await r.text();
        logToPage('[ANALYZE] raw response: ' + (text.length>1000?text.slice(0,1000)+'...':text), 'info');
        let json = null;
        try { json = JSON.parse(text); } catch(e) { json = null; }
        if(!r.ok){
          const errMsg = json && (json.error || json.detail) ? (json.error || json.detail) : (text || `HTTP ${r.status}`);
          showStatus('Analyze failed: ' + errMsg, 'warn');
          treatmentText && (treatmentText.textContent = errMsg);
          logToPage('[ANALYZE] failed: ' + errMsg, 'warn');
          return;
        }
        if(json){
          // use generated_text if present, else stringify entire json
          const resultText = json.generated_text || json.generatedText || json.text || JSON.stringify(json, null, 2);
          if(treatmentText){
            treatmentText.textContent = resultText;
            treatmentText.dataset.locked = '1'; // LOCK so heuristics won't overwrite it
            ensureClearButton();
          }
          // also apply charts if provided
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
              } catch(e){ logToPage('apply mainSpec failed: '+String(e), 'warn'); }
            }
            // render model charts if any
            try { renderModelCharts(json.charts); } catch(e){ logToPage('renderModelCharts failed: '+String(e), 'warn'); }
          }
          showStatus('Analysis returned', 'ok');
        } else {
          // plain text response
          treatmentText && (treatmentText.textContent = text);
          treatmentText && (treatmentText.dataset.locked = '1');
          ensureClearButton();
          showStatus('Analysis returned', 'ok');
        }
      } catch(e){
        logToPage('analyze request failed: '+String(e), 'err');
        showStatus('Analyze request error (console)', 'warn');
        treatmentText && (treatmentText.textContent = String(e));
      } finally {
        analyzeInFlight = false;
        analyzeBtn.disabled = false;
      }
    });

    // render model charts (safe)
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
        } catch(e){ logToPage('renderModelCharts error: '+String(e), 'warn'); }
      });
    }

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
    window.__WAM = { rawData, chartSeries, feedRow, resetPlayback, startPlay, stopPlay, startSSE, stopSSE };

    // safe function definitions used earlier
    function updateChartSeriesFromRaw(count = rawData.length){
      chartSeries = { ts: [], ph: [], tds: [], turb: [], iron: [] };
      for(let i=0;i<Math.min(count, rawData.length); i++){
        const r = rawData[i];
        chartSeries.ts.push(r.ts); chartSeries.ph.push(r.ph==null?null:Number(r.ph)); chartSeries.tds.push(r.tds==null?null:Number(r.tds));
        chartSeries.turb.push(r.turb==null?null:Number(r.turb)); chartSeries.iron.push(r.iron==null?null:Number(r.iron));
      }
    }

    // start
    try { startup(); } catch(e){ logToPage('startup failed: '+String(e),'err'); showStatus('Startup error','warn'); }
  }); // DOMContentLoaded
})(); // IIFE
