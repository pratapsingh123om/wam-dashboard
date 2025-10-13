import React, { useEffect, useRef, useState } from "react";
import ChartArea from "./ChartArea.jsx";
import AnalysisModal from "./AnalysisModal.jsx";
import * as XLSX from "xlsx";

const DEFAULT_THRESHOLDS = { ph_min: 6.5, ph_max: 8.5, tds_max: 500, turb_max: 5, iron_max: 0.3 };

export default function Dashboard(){
  const [readings,setReadings]=useState([]);
  const [selected,setSelected]=useState(new Set());
  const [showAnalysis,setShowAnalysis]=useState(false);
  const [analysisRows,setAnalysisRows]=useState([]);
  const [alerts,setAlerts]=useState(()=>JSON.parse(localStorage.getItem("wam_alerts")||"[]"));
  const [thresholds,setThresholds]=useState(()=>JSON.parse(localStorage.getItem("wam_thresholds")||JSON.stringify(DEFAULT_THRESHOLDS)));
  const [locationText,setLocationText]=useState("");
  const [keyword,setKeyword]=useState("");
  const [showCharts,setShowCharts]=useState(true);
  const [chartMetric,setChartMetric]=useState("ph");
  const fileInputRef=useRef(null);

  async function loadReadings(limit=200){
    try{
      const res=await fetch(`/api/readings?limit=${limit}`);
      if(!res.ok) throw new Error("failed");
      const json=await res.json();
      setReadings(json);
    }catch(e){ console.warn(e); }
  }

  async function loadThresholdsFromServer(){
    try{ const r=await fetch("/api/thresholds"); if(r.ok){const t=await r.json(); setThresholds(t); localStorage.setItem("wam_thresholds", JSON.stringify(t));}}catch(e){}
  }

  useEffect(()=>{ loadThresholdsFromServer(); loadReadings();
    const es=new EventSource("/stream");
    es.onmessage=(e)=>{ try{ const msg=JSON.parse(e.data); if(msg && msg.type==="reading" && msg.data){ setReadings(prev=>[msg.data,...prev]); runAlertCheck(msg.data);} else if(msg && msg.type==="alert" && msg.data){ pushAlert(msg.data.message,msg.data);} }catch(err){console.warn(err);} };
    es.onerror=(err)=>console.warn("SSE error",err);
    return ()=>es.close();
  },[]);

  function pushAlert(message,row=null){ const a={ts:new Date().toISOString(),message,row}; setAlerts(prev=>{const out=[a,...prev].slice(0,200); localStorage.setItem("wam_alerts",JSON.stringify(out)); return out;}); if("Notification" in window){ if(Notification.permission==="granted") new Notification("WAM Alert",{body:message}); else if(Notification.permission!=="denied") Notification.requestPermission().then(p=> { if(p==="granted") new Notification("WAM Alert",{body:message}); }); } }

  function runAlertCheck(row){
    const th=thresholds; const reasons=[];
    try{
      if(row.ph!=null){ const ph=Number(row.ph); if(!isNaN(ph)){ if(th.ph_min!=null && ph<th.ph_min) reasons.push(`pH low (${ph} < ${th.ph_min})`); if(th.ph_max!=null && ph>th.ph_max) reasons.push(`pH high (${ph} > ${th.ph_max})`); } }
      if(row.tds!=null && th.tds_max!=null && Number(row.tds)>Number(th.tds_max)) reasons.push(`TDS high (${row.tds} > ${th.tds_max})`);
      if(row.turb!=null && th.turb_max!=null && Number(row.turb)>Number(th.turb_max)) reasons.push(`Turbidity high (${row.turb} > ${th.turb_max})`);
      if(row.iron!=null && th.iron_max!=null && Number(row.iron)>Number(th.iron_max)) reasons.push(`Iron high (${row.iron} > ${th.iron_max})`);
    }catch(e){}
    if(reasons.length) pushAlert(reasons.join("; "), row);
  }

  function toggleSelect(id){ setSelected(prev=>{ const s=new Set(prev); if(s.has(id)) s.delete(id); else s.add(id); return s; }); }

  function exportToXlsx(onlySelected=true){
    const rows=(onlySelected?readings.filter(r=>selected.has(r.id)):readings).map(r=>({ id:r.id, ts:r.ts, ph:r.ph, tds:r.tds, turb:r.turb, iron:r.iron, site:r.site, lat:r.lat, lon:r.lon }));
    if(!rows.length){ alert("No rows to export."); return; }
    const ws=XLSX.utils.json_to_sheet(rows);
    const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "readings");
    const filename=`wam_readings_${new Date().toISOString().slice(0,19).replace(/[:T]/g,"_")}.xlsx`;
    XLSX.writeFile(wb, filename);
  }

  async function downloadReportCSV(){
    try{ const res=await fetch("/api/report?agg=1"); if(!res.ok) throw new Error("Report failed"); const txt=await res.text(); const blob=new Blob([txt],{type:"text/csv"}); const url=URL.createObjectURL(blob); const a=document.createElement("a"); a.href=url; a.download="wam_report.csv"; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url); }catch(e){ alert("Report download failed: "+e.message); }
  }

  function downloadSampleCSV(){ const a=document.createElement("a"); a.href="/sample_data.csv"; a.download="wam_sample_data.csv"; document.body.appendChild(a); a.click(); a.remove(); }

  function handleFileSelect(e){
    const file=e.target.files?.[0]; if(!file) return;
    const reader=new FileReader();
    reader.onload=(ev)=>{ try{ const data=new Uint8Array(ev.target.result); const workbook=XLSX.read(data,{type:"array"}); const sheet=workbook.Sheets[workbook.SheetNames[0]]; const rows=XLSX.utils.sheet_to_json(sheet,{defval:""}); if(!rows.length) return alert("No rows found"); if(!confirm(`Found ${rows.length} rows. Upload to server?`)) return;
        const fd=new FormData(); fd.append("file", file, file.name); fd.append("location", locationText||""); fd.append("keyword", keyword||"");
        fetch("/api/upload",{method:"POST", body: fd}).then(r=>r.json()).then(json=>{ if(json.ok){ alert(`Imported ${json.imported} rows.`); loadReadings(); } else alert("Upload error: "+JSON.stringify(json)); }).catch(err=>alert("Upload failed: "+err.message));
    }catch(err){ alert("Parse error: "+err.message);} };
    reader.readAsArrayBuffer(file); e.target.value="";
  }

  async function addManualReading(e){ e.preventDefault(); const f=new FormData(e.target); const data={ ts: f.get("ts")? new Date(f.get("ts")).toISOString() : new Date().toISOString(), ph: f.get("ph")? Number(f.get("ph")) : null, tds: f.get("tds")? Number(f.get("tds")) : null, turb: f.get("turb")? Number(f.get("turb")) : null, iron: f.get("iron")? Number(f.get("iron")) : null, site: f.get("site")||"manual" };
    try{ const res=await fetch("/api/sensor",{ method:"POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(data) }); const json=await res.json(); if(json.ok){ e.target.reset(); setTimeout(()=>loadReadings(),500); } else alert("Failed: "+JSON.stringify(json)); }catch(err){ alert("Add failed: "+err.message); } }

  function openAnalysis(mode="analysis"){ const rowsFilter=readings.filter(r=> selected.size===0 ? true : selected.has(r.id)); if(!rowsFilter.length) return alert("Select rows to analyze."); setAnalysisRows(rowsFilter); window.__wam_analysis_mode = mode; setShowAnalysis(true); }

  async function saveThresholds(e){ e.preventDefault(); const fd=new FormData(e.target); const newT={ ph_min: Number(fd.get("ph_min")), ph_max: Number(fd.get("ph_max")), tds_max: Number(fd.get("tds_max")), turb_max: Number(fd.get("turb_max")), iron_max: Number(fd.get("iron_max")) }; try{ const res=await fetch("/api/thresholds",{method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(newT)}); const json=await res.json(); if(json.ok){ setThresholds(newT); localStorage.setItem("wam_thresholds", JSON.stringify(newT)); alert("Saved"); } else alert("Save failed: "+JSON.stringify(json)); }catch(err){ alert("Save failed: "+err.message); } }

  function clearAlerts(){ setAlerts([]); localStorage.removeItem("wam_alerts"); }

  function shareAlertText(alertObj){ const message=`WAM Alert: ${alertObj.message}\nTime: ${alertObj.ts}\n${alertObj.row?`Site: ${alertObj.row.site}\npH: ${alertObj.row.ph}, TDS: ${alertObj.row.tds}`:""}`; if(navigator.share){ navigator.share({ title: "WAM Alert", text: message }).catch(()=>navigator.clipboard.writeText(message).then(()=>alert("Copied"))); } else { window.open(`https://wa.me/?text=${encodeURIComponent(message)}`,"_blank"); } }

  return (
    <div className="container">
      <header className="app-header">
        <div className="app-brand">
          <img src="/logo.png" alt="WAM" className="app-logo" />
          <div>
            <div className="app-title">WAM — Water Monitor</div>
            <div className="small-muted">Import • Analyze • Report • Alerts</div>
          </div>
        </div>

        <div className="header-controls">
          <div style={{display:"flex", gap:".5rem", alignItems:"center"}}>
            <input type="text" placeholder="Location (Well-A or lat,lon)" value={locationText} onChange={e=>setLocationText(e.target.value)} />
            <input type="search" placeholder="Keyword (site/id)" value={keyword} onChange={e=>setKeyword(e.target.value)} />
            <span className="mode-pill">Live</span>
          </div>

          <div style={{display:"flex", gap:".5rem", marginLeft:".5rem"}}>
            <button className="btn" onClick={downloadSampleCSV}>Download sample</button>
            <button className="btn" onClick={()=>fileInputRef.current && fileInputRef.current.click()}>Import file</button>
            <button className="btn" onClick={()=>openAnalysis("analysis")}>Analyze</button>
            <button className="btn" onClick={()=>openAnalysis("treatment")}>Treatment suggestions</button>
            <button className="btn-ghost" onClick={()=>setShowCharts(prev=>!prev)}>{showCharts ? "Hide charts" : "Show charts"}</button>
          </div>
        </div>
      </header>

      <input ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls" onChange={handleFileSelect} style={{display:"none"}}/>

      <form onSubmit={addManualReading} className="small" style={{marginBottom:".8rem"}}>
        <div className="form-row">
          <input name="ts" type="datetime-local" placeholder="Timestamp" />
          <input name="ph" type="number" step="0.1" placeholder="pH" required />
          <input name="tds" type="number" step="0.1" placeholder="TDS" required />
        </div>
        <div className="form-row" style={{marginTop:".4rem"}}>
          <input name="turb" type="number" step="0.1" placeholder="Turbidity" required />
          <input name="iron" type="number" step="0.01" placeholder="Iron" required />
          <input name="site" type="text" placeholder="Site" />
          <button className="btn" type="submit">Add</button>
        </div>
      </form>

      <div style={{display:"grid", gridTemplateColumns:"1fr 360px", gap:"1rem"}}>
        <div>
          {showCharts && (
            <>
              <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:".5rem"}}>
                <div style={{display:"flex", gap:".5rem", alignItems:"center"}}>
                  <div className="small-muted">Plot metric:</div>
                  <select value={chartMetric} onChange={e=>setChartMetric(e.target.value)}>
                    <option value="ph">pH</option>
                    <option value="tds">TDS</option>
                    <option value="turb">Turbidity</option>
                    <option value="iron">Iron</option>
                  </select>
                </div>
                <div className="small-muted">Showing last {Math.min(readings.length,200)} readings</div>
              </div>
              <ChartArea readings={readings.slice(0,500)} metric={chartMetric} />
            </>
          )}

          <h2>Recent Readings</h2>
          <table className="table">
            <thead><tr><th></th><th>Time</th><th>pH</th><th>TDS</th><th>Turb</th><th>Iron</th><th>Site</th></tr></thead>
            <tbody>
              {readings.map(r=>(
                <tr key={r.id ?? Math.random()}>
                  <td style={{width:28}}><input type="checkbox" checked={selected.has(r.id)} onChange={()=>toggleSelect(r.id)} /></td>
                  <td style={{whiteSpace:"nowrap"}}>{r.ts}</td>
                  <td>{r.ph}</td><td>{r.tds}</td><td>{r.turb}</td><td>{r.iron}</td><td>{r.site}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <aside>
          <h3>Thresholds</h3>
          <form onSubmit={saveThresholds} className="small">
            <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:".5rem"}}>
              <label>pH min<input defaultValue={thresholds.ph_min} name="ph_min" /></label>
              <label>pH max<input defaultValue={thresholds.ph_max} name="ph_max" /></label>
              <label>TDS max<input defaultValue={thresholds.tds_max} name="tds_max" /></label>
              <label>Turb max<input defaultValue={thresholds.turb_max} name="turb_max" /></label>
              <label>Iron max<input defaultValue={thresholds.iron_max} name="iron_max" /></label>
            </div>
            <div style={{marginTop:".5rem"}}><button className="btn" type="submit">Save</button></div>
          </form>

          <h3 style={{marginTop:".9rem"}}>Alerts ({alerts.length})</h3>
          <div style={{maxHeight:"260px", overflow:"auto", fontSize:".88rem", marginTop:".3rem"}}>
            <div style={{marginBottom:".4rem"}}><button className="btn small" onClick={clearAlerts}>Clear</button></div>
            {alerts.length===0 && <div className="muted">No alerts</div>}
            {alerts.map((a,i)=>(
              <div key={i} style={{padding:".4rem .2rem", borderBottom:"1px solid #f0f2f5"}}>
                <div style={{fontWeight:600}}>{a.message}</div>
                <div className="small-muted" style={{fontSize:".78rem"}}>{a.ts}</div>
                {a.row && <div style={{fontSize:".78rem", marginTop:".2rem"}}>Site: {a.row.site}</div>}
                <div style={{marginTop:".35rem", display:"flex", gap:".4rem"}}>
                  <button className="share-btn" onClick={()=>shareAlertText(a)}>Share</button>
                  <button className="btn-ghost" onClick={()=>{navigator.clipboard.writeText(`${a.message}\n${a.ts}`); alert("Copied");}}>Copy</button>
                </div>
              </div>
            ))}
          </div>

          <div style={{marginTop:".7rem"}}>
            <div style={{display:"flex", gap:".5rem", marginTop:".4rem"}}>
              <button className="btn" onClick={()=>exportToXlsx(false)}>Export all</button>
              <button className="btn" onClick={()=>exportToXlsx(true)}>Export selected</button>
            </div>
            <div style={{marginTop:".5rem"}}>
              <button className="btn-ghost" onClick={downloadReportCSV}>Download report (CSV)</button>
            </div>
          </div>
        </aside>
      </div>

      <AnalysisModal open={showAnalysis} onClose={()=>setShowAnalysis(false)} rows={analysisRows} />
    </div>
  );
}
