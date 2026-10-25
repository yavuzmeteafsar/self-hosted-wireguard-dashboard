import hmac
import json
import os
import subprocess
import time
from functools import wraps

import psutil
from flask import Flask, jsonify, request, send_from_directory

app = Flask(__name__, static_folder="/web", static_url_path="")

DASHBOARD_TOKEN = os.environ.get("DASHBOARD_TOKEN", "")
DEVICES_FILE = os.environ.get("DEVICES_FILE", "/data/devices.json")
WG_INTERFACE = os.environ.get("WG_INTERFACE", "wg0")

EGRESS_STATE_FILE = os.environ.get("EGRESS_STATE_FILE", "/state/egress_baseline.json")
EGRESS_LIMIT_BYTES = 10 * 1024**4  # Oracle Always Free: 10 TB outbound per month


def load_device_names():
    try:
        with open(DEVICES_FILE, "r") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def require_token(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not DASHBOARD_TOKEN:
            return jsonify({"error": "DASHBOARD_TOKEN not configured on server"}), 500
        auth = request.headers.get("Authorization", "")
        provided = auth.removeprefix("Bearer ").strip()
        if not hmac.compare_digest(provided.encode(), DASHBOARD_TOKEN.encode()):
            return jsonify({"error": "unauthorized"}), 401
        return fn(*args, **kwargs)

    return wrapper


def get_wg_peers():
    result = subprocess.run(
        ["wg", "show", WG_INTERFACE, "dump"],
        capture_output=True,
        text=True,
        timeout=5,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "wg show failed")

    lines = result.stdout.strip().split("\n")
    if not lines or lines == [""]:
        return []

    names = load_device_names()
    now = time.time()
    peers = []

    for line in lines[1:]:
        parts = line.split("\t")
        if len(parts) < 8:
            continue
        pubkey, _psk, endpoint, allowed_ips, latest_hs, rx, tx, _keepalive = parts

        latest_hs = int(latest_hs)
        connected = latest_hs != 0 and (now - latest_hs) < 180

        peers.append(
            {
                "public_key": pubkey,
                "name": names.get(allowed_ips, pubkey[:8] + "…"),
                "endpoint": endpoint if endpoint != "(none)" else None,
                "allowed_ips": allowed_ips,
                "latest_handshake": latest_hs or None,
                "connected": connected,
                "rx_bytes": int(rx),
                "tx_bytes": int(tx),
            }
        )

    peers.sort(key=lambda p: p["name"])
    return peers


def get_system_stats():
    disk = psutil.disk_usage("/")
    mem = psutil.virtual_memory()
    boot = psutil.boot_time()
    return {
        "cpu_percent": psutil.cpu_percent(interval=0.3),
        "memory_percent": mem.percent,
        "memory_used_gb": round(mem.used / (1024**3), 1),
        "memory_total_gb": round(mem.total / (1024**3), 1),
        "disk_percent": disk.percent,
        "disk_used_gb": round(disk.used / (1024**3), 1),
        "disk_total_gb": round(disk.total / (1024**3), 1),
        "uptime_seconds": int(time.time() - boot),
    }


def get_monthly_egress(total_tx_bytes):
    current_month = time.strftime("%Y-%m")

    state = {}
    try:
        with open(EGRESS_STATE_FILE, "r") as f:
            state = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        pass

    if state.get("month") != current_month:
        state = {"month": current_month, "baseline_tx_bytes": total_tx_bytes}
        os.makedirs(os.path.dirname(EGRESS_STATE_FILE), exist_ok=True)
        with open(EGRESS_STATE_FILE, "w") as f:
            json.dump(state, f)

    used_bytes = max(0, total_tx_bytes - state["baseline_tx_bytes"])
    return {
        "used_bytes": used_bytes,
        "limit_bytes": EGRESS_LIMIT_BYTES,
        "percent": round(min(100, used_bytes / EGRESS_LIMIT_BYTES * 100), 2),
        "month": current_month,
    }


@app.route("/api/status")
@require_token
def status():
    try:
        peers = get_wg_peers()
        wg_error = None
    except Exception as exc:
        peers = []
        wg_error = str(exc)

    try:
        total_tx = sum(p["tx_bytes"] for p in peers)
        egress = get_monthly_egress(total_tx)
        egress_error = None
    except Exception as exc:
        egress = None
        egress_error = str(exc)

    return jsonify(
        {
            "peers": peers,
            "wg_error": wg_error,
            "system": get_system_stats(),
            "egress": egress,
            "egress_error": egress_error,
            "generated_at": int(time.time()),
        }
    )


@app.route("/")
@app.route("/<path:path>")
def frontend(path="index.html"):
    return send_from_directory(app.static_folder, path)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
