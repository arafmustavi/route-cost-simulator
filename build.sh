#!/usr/bin/env bash
# ── Voyagraph portable build (macOS / Linux) ────────────────────
set -e
echo "Building Voyagraph ..."
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip >/dev/null
pip install -r requirements-build.txt
pyinstaller --clean --noconfirm voyagraph.spec
echo "Done → dist/Voyagraph"
