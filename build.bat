@echo off
REM ── Voyagraph portable build (Windows) ─────────────────────────
echo.
echo   Building Voyagraph.exe ...
echo.
python -m venv .venv 2>nul
call .venv\Scripts\activate.bat
python -m pip install --upgrade pip >nul
python -m pip install -r requirements-build.txt
pyinstaller --clean --noconfirm voyagraph.spec
echo.
echo   Done.  Your portable app:  dist\Voyagraph.exe
echo   Copy it anywhere - trips are saved in a "trips" folder beside it.
echo.
pause
