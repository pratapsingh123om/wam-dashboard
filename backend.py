#!/usr/bin/env python3
"""
WAM backend (Flask) — full file (replacement)

Notes:
 - Minor robustness for SSE and health route added.
 - Runs with threaded=True to help SSE during dev.
"""
import os
import json
import sqlite3
import csv
import queue
import io
import traceback
from datetime import datetime
from flask import Flask, request, jsonify, g, send_from_directory, Response, make_response
from flask_cors import CORS
import requests

BASE_DIR = os.path.abspath(os.path.dirname(__file__))
DB_PATH = os.path.join(BASE_DIR, "data.db")
COHERE_API_KEY = os.environ.get("COHERE_API_KEY", "").strip()

app = Flask(__name__, static_folder="public", static_url_path="")
CORS(app, resources={r"/api/*": {"origins": "*"}, r"/stream": {"origins": "*"}})

clients = []  # SSE client queues

# ---------- DB helpers ----------
def get_db():
    db = getattr(g, "_database", None)
    if db is None:
        db = g._database = sqlite3.connect(DB_PATH, check_same_thread=False)
        db.row_factory = sqlite3.Row
    return db

def init_db():
    db = get_db()
    cur = db.cursor()
    cur.execute('''
        CREATE TABLE IF NOT EXISTS readings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts TEXT,
            ph REAL,
            tds REAL,
            turb REAL,
            iron REAL,
            site TEXT,
            lat REAL,
            lon REAL
        )
    ''')
    cur.execute('''
        CREATE TABLE IF NOT EXISTS thresholds (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            value TEXT
        )
    ''')
    cur.execute('''
        CREATE TABLE IF NOT EXISTS alerts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts TEXT,
            message TEXT,
            reading_id INTEGER
        )
    ''')
    db.commit()
    cur.execute("SELECT COUNT(*) as c FROM thresholds")
    row = cur.fetchone()
    if row and row["c"] == 0:
        default = {
            "ph_min": 6.5,
            "ph_max": 8.5,
            "tds_max": 500,
            "turb_max": 5,
            "iron_max": 0.3
        }
        cur.execute("INSERT INTO thresholds (id, value) VALUES (1, ?)", (json.dumps(default),))
        db.commit()

@app.teardown_appcontext
def close_connection(exception):
    db = getattr(g, "_database", None)
    if db is not None:
        db.close()

# ---------- utils ----------
def broadcast_event(obj):
    text = json.dumps(obj)
    for q in list(clients):
        try:
            q.put(text, timeout=0.1)
        except Exception:
            try:
                clients.remove(q)
            except Exception:
                pass

def create_alert(msg, reading_id=None):
    db = get_db()
    cur = db.cursor()
    ts = datetime.utcnow().isoformat() + "Z"
    cur.execute("INSERT INTO alerts (ts, message, reading_id) VALUES (?, ?, ?)", (ts, msg, reading_id))
    db.commit()
    aid = cur.lastrowid
    alert_obj = {"id": aid, "ts": ts, "message": msg, "reading_id": reading_id}
    broadcast_event({"type": "alert", "data": alert_obj})
    return aid

def get_thresholds():
    db = get_db()
    cur = db.cursor()
    cur.execute("SELECT value FROM thresholds WHERE id = 1")
    row = cur.fetchone()
    return json.loads(row["value"]) if row else {}

def set_thresholds(obj):
    db = get_db()
    cur = db.cursor()
    cur.execute("UPDATE thresholds SET value = ? WHERE id = 1", (json.dumps(obj),))
    db.commit()
    broadcast_event({"type":"thresholds","data":obj})

def check_and_create_alerts_for_row(reading_id, row):
    th = get_thresholds()
    reasons = []
    try:
        if row.get("ph") is not None:
            ph = float(row.get("ph"))
            if "ph_min" in th and ph < th["ph_min"]:
                reasons.append(f"pH low ({ph} < {th['ph_min']})")
            if "ph_max" in th and ph > th["ph_max"]:
                reasons.append(f"pH high ({ph} > {th['ph_max']})")
    except Exception:
        pass
    try:
        if row.get("tds") is not None and "tds_max" in th:
            tds = float(row.get("tds"))
            if tds > th["tds_max"]:
                reasons.append(f"TDS high ({tds} > {th['tds_max']})")
    except Exception:
        pass
    try:
        if row.get("turb") is not None and "turb_max" in th:
            turb = float(row.get("turb"))
            if turb > th["turb_max"]:
                reasons.append(f"Turbidity high ({turb} > {th['turb_max']})")
    except Exception:
        pass
    try:
        if row.get("iron") is not None and "iron_max" in th:
            iron = float(row.get("iron"))
            if iron > th["iron_max"]:
                reasons.append(f"Iron high ({iron} > {th['iron_max']})")
    except Exception:
        pass
    if reasons:
        create_alert("; ".join(reasons), reading_id=reading_id)

def insert_row(row):
    db = get_db()
    cur = db.cursor()
    cur.execute('''
        INSERT INTO readings (ts, ph, tds, turb, iron, site, lat, lon)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ''', (row.get("ts"), row.get("ph"), row.get("tds"), row.get("turb"),
          row.get("iron"), row.get("site"), row.get("lat"), row.get("lon")))
    db.commit()
    rid = cur.lastrowid
    payload = {
        "id": rid,
        "ts": row.get("ts"),
        "ph": row.get("ph"),
        "tds": row.get("tds"),
        "turb": row.get("turb"),
        "iron": row.get("iron"),
        "site": row.get("site"),
        "lat": row.get("lat"),
        "lon": row.get("lon")
    }
    broadcast_event({"type": "reading", "data": payload})
    check_and_create_alerts_for_row(rid, payload)
    return rid

# ---------- routes ----------
@app.route("/api/sensor", methods=["POST"])
def api_sensor():
    try:
        data = request.get_json(force=True)
    except Exception:
        return jsonify({"error":"invalid json"}), 400
    if not data:
        return jsonify({"error":"no json payload"}), 400
    if "ts" not in data or not data["ts"]:
        data["ts"] = datetime.utcnow().isoformat() + "Z"
    for k in ("ph","tds","turb","iron","lat","lon"):
        if k in data and data[k] is not None and data[k] != "":
            try:
                data[k] = float(data[k])
            except Exception:
                pass
    rid = insert_row(data)
    return jsonify({"ok": True, "id": rid})

@app.route("/api/upload", methods=["POST"])
def api_upload():
    """
    Accepts multipart form upload with field 'file' (CSV).
    Each CSV row columns can include ts,ph,tds,turb,iron,site,lat,lon
    """
    if "file" not in request.files:
        return jsonify({"error":"no file"}), 400
    f = request.files["file"]
    try:
        text = f.stream.read().decode("utf-8", errors="ignore")
    except Exception:
        return jsonify({"error":"could not read file"}), 400
    reader = csv.DictReader(text.splitlines())
    count = 0
    for row in reader:
        data = {}
        for col in ("ts","ph","tds","turb","iron","site","lat","lon"):
            if col in row and row[col] != "":
                data[col] = row[col]
        if "ts" in data and data["ts"] and not data["ts"].endswith("Z"):
            try:
                dt = datetime.fromisoformat(data["ts"])
                data["ts"] = dt.isoformat() + "Z"
            except Exception:
                pass
        for k in ("ph","tds","turb","iron","lat","lon"):
            if k in data:
                try:
                    data[k] = float(data[k])
                except Exception:
                    pass
        insert_row(data)
        count += 1
    return jsonify({"ok": True, "imported": count})

@app.route("/api/readings", methods=["GET"])
def api_readings():
    limit = int(request.args.get("limit", 200))
    db = get_db()
    cur = db.cursor()
    cur.execute("SELECT * FROM readings ORDER BY id DESC LIMIT ?", (limit,))
    rows = [dict(r) for r in cur.fetchall()]
    return jsonify(rows)

@app.route("/api/thresholds", methods=["GET", "POST"])
def api_thresholds():
    if request.method == "GET":
        return jsonify(get_thresholds())
    payload = request.get_json(force=True) or {}
    if not isinstance(payload, dict):
        return jsonify({"error":"expected JSON object"}), 400
    for k,v in payload.items():
        try:
            payload[k] = float(v)
        except Exception:
            pass
    set_thresholds(payload)
    return jsonify({"ok": True, "thresholds": payload})

@app.route("/api/alerts", methods=["GET"])
def api_alerts():
    limit = int(request.args.get("limit", 200))
    db = get_db()
    cur = db.cursor()
    cur.execute("SELECT * FROM alerts ORDER BY id DESC LIMIT ?", (limit,))
    rows = [dict(r) for r in cur.fetchall()]
    return jsonify(rows)

@app.route("/api/report", methods=["GET"])
def api_report():
    fmt = request.args.get("format", "csv")
    ids = request.args.get("ids")
    agg = request.args.get("agg")
    db = get_db()
    cur = db.cursor()

    if ids:
        id_list = [int(x) for x in ids.split(",") if x.strip().isdigit()]
        if not id_list:
            return jsonify({"error":"invalid ids"}), 400
        placeholder = ",".join("?" for _ in id_list)
        cur.execute(f"SELECT * FROM readings WHERE id IN ({placeholder}) ORDER BY id DESC", id_list)
        rows = [dict(r) for r in cur.fetchall()]
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(["id","ts","ph","tds","turb","iron","site","lat","lon"])
        for r in rows:
            writer.writerow([r["id"], r["ts"], r["ph"], r["tds"], r["turb"], r["iron"], r["site"], r["lat"], r["lon"]])
        resp = make_response(output.getvalue())
        resp.headers["Content-Type"] = "text/csv"
        resp.headers["Content-Disposition"] = "attachment; filename=wam_selected_readings.csv"
        return resp

    if agg:
        cur.execute("SELECT ph,tds,turb,iron FROM readings")
        vals = cur.fetchall()
        metrics = {"ph":[], "tds":[], "turb":[], "iron":[]}
        for r in vals:
            for m in metrics:
                v = r[m]
                try:
                    if v is not None:
                        metrics[m].append(float(v))
                except Exception:
                    pass
        rows = []
        for m,arr in metrics.items():
            if not arr:
                rows.append({"metric": m, "count": 0, "avg": "", "min": "", "max": ""})
            else:
                s = sum(arr)
                rows.append({"metric": m, "count": len(arr), "avg": s/len(arr), "min": min(arr), "max": max(arr)})
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(["metric","count","avg","min","max"])
        for r in rows:
            writer.writerow([r["metric"], r["count"], r["avg"], r["min"], r["max"]])
        resp = make_response(output.getvalue())
        resp.headers["Content-Type"] = "text/csv"
        resp.headers["Content-Disposition"] = "attachment; filename=wam_report.csv"
        return resp

    limit = int(request.args.get("limit", 200))
    cur.execute("SELECT * FROM readings ORDER BY id DESC LIMIT ?", (limit,))
    rows = [dict(r) for r in cur.fetchall()]
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["id","ts","ph","tds","turb","iron","site","lat","lon"])
    for r in rows:
        writer.writerow([r["id"], r["ts"], r["ph"], r["tds"], r["turb"], r["iron"], r["site"], r["lon"] if "lon" in r else r.get("lon")])
    resp = make_response(output.getvalue())
    resp.headers["Content-Type"] = "text/csv"
    resp.headers["Content-Disposition"] = "attachment; filename=wam_readings.csv"
    return resp

# SSE stream with keepalive
@app.route("/stream")
def stream():
    def gen(q):
        try:
            while True:
                try:
                    # wait for an event up to 15s
                    data = q.get(timeout=15)
                    yield f"data: {data}\n\n"
                except queue.Empty:
                    # SSE keepalive comment prevents some proxies from closing the connection
                    yield ": keepalive\n\n"
        except GeneratorExit:
            pass
    q = queue.Queue()
    clients.append(q)
    headers = {"Cache-Control": "no-cache"}
    return Response(gen(q), mimetype="text/event-stream", headers=headers)

# ---------- ANALYZE: local analysis + optional Cohere integration ----------
def local_analysis(rows_list):
    def safe_float(x):
        try: return float(x)
        except Exception: return None

    metrics = {"ph": [], "tds": [], "turb": [], "iron": []}
    per_site = {}
    breaches = []
    for r in rows_list:
        site = r.get("site") or "unknown"
        per_site.setdefault(site, []).append(r)
        for m in metrics.keys():
            v = r.get(m)
            fv = safe_float(v)
            if fv is not None:
                metrics[m].append(fv)
    stats = {}
    for m,arr in metrics.items():
        if arr:
            stats[m] = {"count": len(arr), "avg": sum(arr)/len(arr), "min": min(arr), "max": max(arr)}
        else:
            stats[m] = {"count": 0, "avg": None, "min": None, "max": None}
    try:
        th = get_thresholds()
    except Exception:
        th = {}

    for site, rows_s in per_site.items():
        for r in rows_s:
            reasons = []
            ph = safe_float(r.get("ph")); tds = safe_float(r.get("tds"))
            turb = safe_float(r.get("turb")); iron = safe_float(r.get("iron"))
            if ph is not None:
                if th.get("ph_min") is not None and ph < th["ph_min"]: reasons.append(f"pH low ({ph} < {th['ph_min']})")
                if th.get("ph_max") is not None and ph > th["ph_max"]: reasons.append(f"pH high ({ph} > {th['ph_max']})")
            if tds is not None and th.get("tds_max") is not None and tds > th["tds_max"]:
                reasons.append(f"TDS high ({tds} > {th['tds_max']})")
            if turb is not None and th.get("turb_max") is not None and turb > th["turb_max"]:
                reasons.append(f"Turbidity high ({turb} > {th['turb_max']})")
            if iron is not None and th.get("iron_max") is not None and iron > th["iron_max"]:
                reasons.append(f"Iron high ({iron} > {th['iron_max']})")
            if reasons:
                breaches.append({"site": site, "ts": r.get("ts"), "reasons": reasons, "reading": r})

    # textual summary
    lines = []
    lines.append("Local WAM analysis summary:")
    for m in ("ph","tds","turb","iron"):
        s = stats[m]
        if s["count"]:
            lines.append(f"- {m.upper()}: {s['count']} readings, avg={s['avg']:.3g}, min={s['min']}, max={s['max']}")
        else:
            lines.append(f"- {m.upper()}: no data")
    if breaches:
        lines.append("")
        lines.append(f"Alerts detected: {len(breaches)} readings breach thresholds:")
        for b in breaches[:6]:
            lines.append(f"  • Site {b['site']} @ {b.get('ts','')}: " + "; ".join(b["reasons"]))
    else:
        lines.append("")
        lines.append("No threshold breaches detected in provided rows.")
    lines.append("")
    lines.append("Suggested actions (heuristic):")
    if stats["tds"]["avg"] and stats["tds"]["avg"] > (th.get("tds_max", 500) if th.get("tds_max") else 500):
        lines.append(" - TDS high: consider RO or ion-exchange.")
    if stats["ph"]["avg"] and (stats["ph"]["avg"] < (th.get("ph_min",6.5) if th.get("ph_min") else 6.5) or stats["ph"]["avg"] > (th.get("ph_max",8.5) if th.get("ph_max") else 8.5)):
        lines.append(" - pH out of range: lab-guided neutralizing agents.")
    if stats["iron"]["avg"] and stats["iron"]["avg"] > (th.get("iron_max",0.3) if th.get("iron_max") else 0.3):
        lines.append(" - Iron high: oxidation + filtration recommended.")
    if stats["turb"]["avg"] and stats["turb"]["avg"] > (th.get("turb_max",5) if th.get("turb_max") else 5):
        lines.append(" - Turbidity high: settling/filtration recommended.")
    lines.append("")
    lines.append("Next steps: 1) Re-sample suspect sites. 2) Send failing samples to lab. 3) Inspect source/distribution if multiple sites affected.")

    # Build a chart spec for frontend convenience
    labels = [r.get("ts") for r in rows_list]
    def series_for(key):
        arr = []
        for r in rows_list:
            v = r.get(key)
            try:
                arr.append(float(v) if v is not None and v != '' else None)
            except Exception:
                arr.append(None)
        return arr

    charts = [{
        "id": "main",
        "title": "Measured Trends",
        "labels": labels,
        "datasets": [
            {"label":"pH","data": series_for("ph")},
            {"label":"TDS","data": series_for("tds")},
            {"label":"Turb","data": series_for("turb")},
            {"label":"Iron","data": series_for("iron")}
        ]
    }]

    return {"type":"local", "generated_text":"\n".join(lines), "stats": stats, "breaches": breaches, "charts": charts}

@app.route("/api/analyze", methods=["POST"])
def api_analyze():
    try:
        payload = request.get_json(force=True) or {}
    except Exception:
        return jsonify({"error":"Invalid JSON"}), 400
    model = payload.get("model", "")
    inputs = payload.get("inputs", "")
    rows = payload.get("rows")
    # If rows provided -> local analysis
    if rows:
        try:
            return jsonify(local_analysis(rows))
        except Exception as e:
            app.logger.exception("Local analysis error")
            return jsonify({"error":"Local analysis failed", "detail": str(e)}), 500

    # No rows -> attempt to call Cohere (if key present), else return helpful error
    if not COHERE_API_KEY:
        return jsonify({"error":"No COHERE_API_KEY set on server. Send 'rows' for local analysis or set COHERE_API_KEY env var."}), 400

    prompt_text = inputs or "Analyze these water quality readings and suggest summary and treatment options."
    url = "https://api.cohere.ai/generate"
    headers = {"Authorization": f"Bearer {COHERE_API_KEY}", "Content-Type":"application/json"}
    data = {
        "model": "command-xlarge-nightly",
        "prompt": prompt_text,
        "max_tokens": 300,
        "temperature": 0.2,
        "k": 0,
        "return_likelihoods": "NONE"
    }
    try:
        r = requests.post(url, headers=headers, json=data, timeout=30)
        app.logger.info(f"[COHERE] status={r.status_code} resp_preview={r.text[:500]!r}")
        if r.status_code == 401:
            return jsonify({"error":"Cohere 401 Unauthorized: invalid API key."}), 401
        if r.status_code == 403:
            return jsonify({"error":"Cohere 403 Forbidden: model access denied."}), 403
        r.raise_for_status()
        jr = r.json()
        if isinstance(jr, dict) and "generations" in jr:
            text = "\n\n".join(g.get("text","") for g in jr["generations"])
            return jsonify({"type":"cohere", "generated_text": text, "raw": jr})
        return jsonify({"type":"cohere", "generated": jr})
    except requests.exceptions.HTTPError as e:
        app.logger.error("[COHERE] HTTP error: %s", e)
        return jsonify({"error":"Cohere HTTP error", "detail": str(e)}), 500
    except Exception as e:
        app.logger.exception("[COHERE] request failed")
        return jsonify({"error":"Cohere request failed", "detail": str(e)}), 500

# static serving
@app.route("/", defaults={"path": ""})
@app.route("/<path:path>")
def serve(path):
    if path and os.path.exists(os.path.join(app.static_folder, path)):
        return send_from_directory(app.static_folder, path)
    index = os.path.join(app.static_folder, "index.html")
    if os.path.exists(index):
        return send_from_directory(app.static_folder, "index.html")
    root_index = os.path.join(BASE_DIR, "index.html")
    if os.path.exists(root_index):
        return send_from_directory(BASE_DIR, "index.html")
    return "Index not found. Place index.html in public/ or project root.", 404

@app.route("/health")
def health():
    return jsonify({"ok": True, "version": "wam-backend", "time": datetime.utcnow().isoformat() + "Z"})

# initialize DB
with app.app_context():
    init_db()

if __name__ == "__main__":
    print("Starting backend on http://0.0.0.0:5001")
    app.run(host="0.0.0.0", port=5001, debug=False, use_reloader=False, threaded=True)
