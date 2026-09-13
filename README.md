<div align="center">

# ✈️ Voyagraph

**Model your trip as a graph. Let the maths pick the route.**

Places are nodes. Flights, trains, buses and ferries are weighted edges.
Voyagraph finds the cheapest (or fastest, or best-value) way through them —
then runs a Monte Carlo simulation so you know what to actually budget.

`Flask` · `Vanilla JS` · `Zero runtime dependencies beyond Flask` · `Builds to a portable .exe`

</div>

---

## Why this exists

Comparing a multi-city trip in a spreadsheet breaks down fast. Six cities have
120 possible orders, each with several routing options, each with a fare that
moves ±25%. Voyagraph turns that into a graph problem and solves it properly.

## What it does

| Capability | How it works |
|---|---|
| **Cheapest route A → B** | Dijkstra over a blended cost/time objective |
| **Five real alternatives** | Yen's K-shortest-paths, so you compare, not guess |
| **Best visiting order** | Exact permutation search ≤ 8 stops; nearest-neighbour + 2-opt beyond |
| **Money vs. time slider** | Set what an hour of your life is worth; routes re-rank live |
| **Budget simulation** | Monte Carlo over per-leg price volatility → P50 / P90 / worst case |
| **Sensitivity analysis** | Ranks which single leg to renegotiate for the biggest saving |
| **Mode preferences** | Soft penalties to avoid flights, buses, etc. |
| **Full costing** | Fares + transfer time + hotel nights + daily spend, all in |

## The model

```
total_cost  = Σ fares  +  Σ (nights × nightly_rate)  +  Σ (days × daily_spend)
total_time  = Σ (in-vehicle hours + transfer hours)  +  Σ stay hours
score       = total_cost + (value_of_your_time_per_hour × travel_hours)
```

Set the time value to `0` and you get the absolute cheapest trip. Raise it and
Voyagraph starts buying you back hours — the overnight bus loses to the
Shinkansen somewhere around $18/hour on the sample data.

---

## Run it

```bash
pip install -r requirements.txt
python app.py
```

Opens automatically at **http://127.0.0.1:5117**. Click **Load sample** to see a
Jakarta → Southeast Asia → Japan trip already wired up.

On Windows you can just double-click `run.bat`.

## Build the portable .exe

```bash
# Windows
build.bat

# macOS / Linux
./build.sh
```

Output lands in `dist/Voyagraph.exe` — a single file, no Python needed on the
target machine. Trips save to a `trips/` folder created next to the exe, so you
can run the whole thing from a USB stick.

> PyInstaller builds are platform-native: run `build.bat` **on Windows** to get a
> Windows exe. It won't cross-compile from Linux or macOS.

---

## Using it

1. **Add places** — name, nights staying, hotel rate, daily spend.
2. **Connect them** — either fill the form, or **shift-drag** from one node to
   another directly on the map.
3. Set each connection's fare, travel hours, transfer hours, and a **price swing ±%**
   (how volatile that fare is — LCC routes swing far more than a train ticket).
4. Pick **A → B** or **Multi-city**, slide the time value, hit **Run simulation**.
5. Click any option to see it highlighted on the map with a leg-by-leg table,
   budget distribution, and what to haggle on.

### Canvas controls

| Action | Gesture |
|---|---|
| Move a place | Drag it |
| Edit a place | Click it |
| Create a connection | Shift-drag node → node |
| Pan / zoom | Drag background / scroll |
| Reset layout | Auto-arrange, or Fit |

Everything autosaves to your browser. **Save** writes a JSON file server-side;
**Export** downloads it so you can version it in git or share it.

---

## Project layout

```
voyagraph/
├── app.py                  Flask routes + PyInstaller-safe paths
├── engine.py               Dijkstra, Yen's K-shortest, tour solver, Monte Carlo
├── templates/index.html
├── static/
│   ├── css/app.css         Light + dark, no external fonts
│   └── js/
│       ├── graph.js        Canvas graph editor (no libraries)
│       └── app.js          State, CRUD, API calls
├── samples/apmea_sample.json
├── voyagraph.spec          PyInstaller config
└── build.bat / build.sh
```

## API

| Endpoint | Purpose |
|---|---|
| `POST /api/route` | K best routes between two places |
| `POST /api/tour` | Best visiting orders for a multi-city trip |
| `POST /api/simulate` | Monte Carlo budget + leg sensitivity |
| `POST /api/validate` | Flag isolated nodes and bad edges |
| `GET/POST /api/trips` | List / save trips |
| `GET /api/sample` | Load the bundled sample |

All simulation endpoints are stateless — you post the whole graph, you get
results back. Nothing leaves your machine.

## Notes & limits

- Mode avoidance is a **soft** penalty. If the only way out is a flight, it'll
  still route you through one rather than fail.
- Exact tour solving covers up to 8 intermediate stops (40,320 orders, ~1s).
  Beyond that it switches to a heuristic and returns one strong answer.
- Fares are whatever you enter — there's no live pricing API. That's deliberate:
  it stays offline, free, and works with quotes you've actually been given.

## Licence

MIT.
