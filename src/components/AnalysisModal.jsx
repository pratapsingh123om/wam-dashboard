import React, { useEffect, useState } from "react";

export default function AnalysisModal({ open, onClose, rows = [], mode: propMode = null }) {
  const [model, setModel] = useState("google/flan-t5-small");
  const [extraInstructions, setExtraInstructions] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) { setResult(null); setError(null); setLoading(false); }
  }, [open]);

  if (!open) return null;
  const mode = propMode || window.__wam_analysis_mode || "analysis";

  function makePrompt(rows) {
    const lines = rows.map(r => {
      const ts = r.ts || "";
      const parts = [`${ts}`, `pH:${r.ph ?? ""}`, `TDS:${r.tds ?? ""}`, `Turb:${r.turb ?? ""}`, `Iron:${r.iron ?? ""}`];
      if (r.site) parts.push(`Site:${r.site}`);
      return "- " + parts.join(" | ");
    });
    if (mode === "treatment") {
      return `You are a water-treatment expert. For the following readings, provide recommended treatments or mitigation steps in a concise bulleted list, prioritized by severity. Also indicate immediate field checks.\n\nReadings:\n${lines.join("\n")}\n\nExtra: ${extraInstructions}`;
    } else {
      return `You are a water-quality analyst. Summarize these readings, call out potential concerns, and suggest monitoring or mitigation actions.\n\nReadings:\n${lines.join("\n")}\n\nExtra: ${extraInstructions}`;
    }
  }

  async function doAnalyze() {
    setLoading(true); setResult(null); setError(null);
    const inputs = makePrompt(rows);
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, inputs })
      });
      const json = await res.json();
      if (json.error) setError(json.error);
      else {
        if (Array.isArray(json) && json.length && json[0].generated_text) setResult(json[0].generated_text);
        else if (json.generated_text) setResult(json.generated_text);
        else setResult(JSON.stringify(json, null, 2));
      }
    } catch (err) { setError(err.message || String(err)); }
    finally { setLoading(false); }
  }

  function copyPrompt() {
    navigator.clipboard.writeText(makePrompt(rows)).then(() => alert("Prompt copied"));
  }
  function downloadResult() {
    const blob = new Blob([result || ""], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `wam_analysis_${new Date().toISOString().slice(0,19).replace(/[:T]/g,"_")}.txt`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  }
  function shareResult() {
    if (!result) return;
    if (navigator.share) navigator.share({ title: "WAM Analysis", text: result }).catch(()=>navigator.clipboard.writeText(result).then(()=>alert("Copied")));
    else window.open(`https://wa.me/?text=${encodeURIComponent(result)}`, "_blank");
  }

  return (
    <div style={{position:"fixed", inset:0, background:"rgba(0,0,0,0.36)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:2000}}>
      <div style={{width:900, maxHeight:"80vh", overflow:"auto", background:"#fff", padding:16, borderRadius:8}}>
        <div style={{display:"flex", justifyContent:"space-between", alignItems:"center"}}>
          <h3>{mode === "treatment" ? "Treatment suggestions" : "Analysis"} ({rows.length} rows)</h3>
          <div><button className="btn" onClick={onClose}>Close</button></div>
        </div>

        <div style={{marginTop:8}}>
          <label>Model</label>
          <input value={model} onChange={e=>setModel(e.target.value)} style={{width:"100%", padding:8, borderRadius:6, border:"1px solid #ddd"}} />
        </div>

        <div style={{marginTop:8}}>
          <label>Extra instructions</label>
          <textarea rows={3} value={extraInstructions} onChange={e=>setExtraInstructions(e.target.value)} style={{width:"100%", padding:8, borderRadius:6, border:"1px solid #ddd"}} />
        </div>

        <div style={{marginTop:8}}>
          <strong>Prompt</strong>
          <pre style={{background:"#f7fafc", padding:8, maxHeight:180, overflow:"auto"}}>{makePrompt(rows)}</pre>
        </div>

        <div style={{marginTop:8, display:"flex", gap:8}}>
          <button className="btn" onClick={doAnalyze} disabled={loading}>{loading ? "Running…" : (mode === "treatment" ? "Suggest treatments" : "Analyze")}</button>
          <button className="btn" onClick={copyPrompt}>Copy prompt</button>
        </div>

        <div style={{marginTop:12}}>
          <strong>Result</strong>
          <div style={{marginTop:8, minHeight:120, background:"#fff", border:"1px solid #eee", padding:8, borderRadius:6}}>
            {error && <div style={{color:"crimson"}}>Error: {error}</div>}
            {!error && !result && <div className="small-muted">No result yet.</div>}
            {!error && result && <pre style={{whiteSpace:"pre-wrap"}}>{result}</pre>}
          </div>
          <div style={{marginTop:10, display:"flex", gap:8}}>
            <button className="btn" onClick={downloadResult} disabled={!result}>Download</button>
            <button className="btn" onClick={shareResult} disabled={!result}>Share</button>
          </div>
        </div>
      </div>
    </div>
  );
}
