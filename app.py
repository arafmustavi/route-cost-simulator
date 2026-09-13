"""
Voyagraph — a graph-theory trip planner.

Run:
    python app.py
Then open http://127.0.0.1:5117
"""

from __future__ import annotations

import json
import os
import sys
import threading
import uuid
import webbrowser
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory, render_template

import engine
from engine import Graph, Node, Edge

# --------------------------------------------------------------------------- #
# Paths — PyInstaller-safe
# --------------------------------------------------------------------------- #
def resource_dir() -> Path:
    """Where bundled templates/static live (read-only inside the exe)."""
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS)  # type: ignore[attr-defined]
    return Path(__file__).parent


def data_dir() -> Path:
    """Where user trips are saved (next to the exe, so it stays portable)."""
    base = Path(sys.executable).parent if getattr(sys, "frozen", False) \
        else Path(__file__).parent
    d = base / "trips"
    d.mkdir(parents=True, exist_ok=True)
    return d


APP_ROOT = resource_dir()
app = Flask(__name__,
            template_folder=str(APP_ROOT / "templates"),
            static_folder=str(APP_ROOT / "static"))
app.config["JSON_SORT_KEYS"] = False

PORT = int(os.environ.get("VOYAGRAPH_PORT", "5117"))


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def load_graph(payload: dict) -> Graph:
    return Graph.from_dict(payload or {})


def safe_name(name: str) -> str:
    keep = "-_. abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    cleaned = "".join(c for c in (name or "trip") if c in keep).strip()
    return (cleaned or "trip")[:60]


# --------------------------------------------------------------------------- #
# Pages
# --------------------------------------------------------------------------- #
@app.route("/")
def index():
    return render_template("index.html", port=PORT)


@app.route("/favicon.ico")
def favicon():
    return send_from_directory(app.static_folder, "favicon.svg",
                               mimetype="image/svg+xml")


# --------------------------------------------------------------------------- #
# API — simulation
# --------------------------------------------------------------------------- #
@app.post("/api/route")
def api_route():
    """Best route + K alternatives between two places."""
    body = request.get_json(force=True)
    g = load_graph(body.get("graph"))
    start, end = body.get("start"), body.get("end")
    time_value = float(body.get("time_value", 0))
    k = int(body.get("k", 5))
    penalties = body.get("mode_penalty", {}) or {}

    if start not in g.nodes or end not in g.nodes:
        return jsonify({"error": "Pick a valid origin and destination."}), 400

    paths = engine.k_shortest_paths(g, start, end, k, time_value, penalties)
    if not paths:
        return jsonify({"error": "No route exists between those two places. "
                                 "Add a connecting edge."}), 404

    options = []
    for seq, legs, _ in paths:
        s = engine.summarise(g, seq, legs, time_value)
        s["leg_ids"] = [e.id for e in legs]
        options.append(s)

    # Yen's returns them by path score; rank by the full trip score the user sees.
    options.sort(key=lambda o: o["score"])
    return jsonify({"options": options, "currency": g.currency})


@app.post("/api/tour")
def api_tour():
    """Best visiting order for a multi-city trip."""
    body = request.get_json(force=True)
    g = load_graph(body.get("graph"))
    start = body.get("start")
    end = body.get("end") or None
    must = body.get("must_visit", []) or []
    time_value = float(body.get("time_value", 0))
    top_n = int(body.get("top_n", 5))
    penalties = body.get("mode_penalty", {}) or {}

    if start not in g.nodes:
        return jsonify({"error": "Pick a valid starting point."}), 400
    if not must:
        return jsonify({"error": "Select at least one place to visit."}), 400

    results = engine.plan_tour(g, start, must, end, time_value, penalties, top_n)
    if not results:
        return jsonify({"error": "Those stops aren't all reachable from each "
                                 "other. Check your connections."}), 404

    # attach leg ids for downstream simulation
    for r in results:
        r["leg_ids"] = [l["id"] for l in r["legs"]]

    return jsonify({"options": results, "currency": g.currency})


@app.post("/api/simulate")
def api_simulate():
    """Monte Carlo budget + per-leg sensitivity for a chosen itinerary."""
    body = request.get_json(force=True)
    g = load_graph(body.get("graph"))
    leg_ids = body.get("leg_ids", []) or []
    sequence = body.get("sequence", []) or []
    runs = int(body.get("runs", 5000))
    stay_var = float(body.get("stay_var_pct", 10))
    seed = body.get("seed")

    mc = engine.monte_carlo(g, leg_ids, sequence, runs, stay_var,
                            int(seed) if seed not in (None, "") else None)
    sens = engine.sensitivity(g, leg_ids, float(body.get("shift_pct", 20)))
    return jsonify({"monte_carlo": mc, "sensitivity": sens,
                    "currency": g.currency})


@app.post("/api/validate")
def api_validate():
    g = load_graph(request.get_json(force=True).get("graph"))
    return jsonify({"problems": g.validate(),
                    "nodes": len(g.nodes), "edges": len(g.edges)})


# --------------------------------------------------------------------------- #
# API — persistence (plain JSON files next to the exe)
# --------------------------------------------------------------------------- #
@app.get("/api/trips")
def list_trips():
    items = []
    for p in sorted(data_dir().glob("*.json")):
        try:
            raw = json.loads(p.read_text(encoding="utf-8"))
            items.append({"file": p.name,
                          "name": raw.get("name", p.stem),
                          "nodes": len(raw.get("nodes", [])),
                          "edges": len(raw.get("edges", []))})
        except Exception:
            continue
    return jsonify({"trips": items})


@app.post("/api/trips")
def save_trip():
    body = request.get_json(force=True)
    g = body.get("graph", {})
    fname = safe_name(g.get("name", "trip")) + ".json"
    (data_dir() / fname).write_text(json.dumps(g, indent=2), encoding="utf-8")
    return jsonify({"saved": fname, "path": str(data_dir() / fname)})


@app.get("/api/trips/<path:fname>")
def open_trip(fname):
    p = data_dir() / Path(fname).name
    if not p.exists():
        return jsonify({"error": "Trip not found."}), 404
    return jsonify(json.loads(p.read_text(encoding="utf-8")))


@app.delete("/api/trips/<path:fname>")
def delete_trip(fname):
    p = data_dir() / Path(fname).name
    if p.exists():
        p.unlink()
    return jsonify({"deleted": p.name})


@app.get("/api/sample")
def sample():
    p = APP_ROOT / "samples" / "apmea_sample.json"
    return jsonify(json.loads(p.read_text(encoding="utf-8")))


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #
def open_browser():
    webbrowser.open_new(f"http://127.0.0.1:{PORT}")


if __name__ == "__main__":
    if os.environ.get("WERKZEUG_RUN_MAIN") != "true":
        threading.Timer(1.2, open_browser).start()
    print(f"\n  Voyagraph running →  http://127.0.0.1:{PORT}")
    print(f"  Trips are saved in →  {data_dir()}\n")
    app.run(host="127.0.0.1", port=PORT, debug=False, threaded=True)
