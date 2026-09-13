"""
Voyagraph — routing & cost simulation engine.

Pure-Python (no third-party deps) so the PyInstaller bundle stays small
and the app runs fully offline.

Model
-----
Node  = a place you can be (city, airport, hub).
Edge  = a way to get from one place to another (flight, train, bus, ferry, car).
Trip  = start node + set of places you must visit + optional end node.

Costs
-----
total_cost = sum(edge.cost) + sum(node.stay_nights * node.nightly_cost)
           + sum(node.daily_spend * ceil(stay_nights))
total_time = sum(edge.duration_h) + sum(edge.wait_h) + sum(stay_nights * 24)

The optimiser minimises a blended objective:
    score = cost + (time_value_per_hour * travel_hours)
so you can trade money against hours with one slider.
"""

from __future__ import annotations

import heapq
import itertools
import math
import random
from dataclasses import dataclass, field, asdict
from typing import Dict, List, Optional, Tuple

MODES = ["flight", "train", "bus", "ferry", "car", "rideshare", "walk", "other"]


# --------------------------------------------------------------------------- #
# Data model
# --------------------------------------------------------------------------- #
@dataclass
class Node:
    id: str
    name: str
    country: str = ""
    stay_nights: float = 0.0
    nightly_cost: float = 0.0      # hotel / accommodation per night
    daily_spend: float = 0.0       # food, local transport, tickets per day
    notes: str = ""
    x: float = 0.0                 # canvas position
    y: float = 0.0

    def stay_cost(self) -> float:
        nights = max(0.0, self.stay_nights)
        days = math.ceil(nights) if nights > 0 else 0
        return nights * self.nightly_cost + days * self.daily_spend

    def stay_hours(self) -> float:
        return max(0.0, self.stay_nights) * 24.0


@dataclass
class Edge:
    id: str
    source: str
    target: str
    mode: str = "flight"
    cost: float = 0.0
    duration_h: float = 0.0        # in-vehicle time
    wait_h: float = 0.0            # airport / transfer / check-in overhead
    cost_var_pct: float = 15.0     # ±% used by the Monte Carlo simulation
    bidirectional: bool = True
    notes: str = ""

    def total_hours(self) -> float:
        return max(0.0, self.duration_h) + max(0.0, self.wait_h)


@dataclass
class Graph:
    nodes: Dict[str, Node] = field(default_factory=dict)
    edges: Dict[str, Edge] = field(default_factory=dict)
    currency: str = "USD"
    name: str = "Untitled trip"

    # ---- serialisation ---------------------------------------------------- #
    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "currency": self.currency,
            "nodes": [asdict(n) for n in self.nodes.values()],
            "edges": [asdict(e) for e in self.edges.values()],
        }

    @classmethod
    def from_dict(cls, raw: dict) -> "Graph":
        g = cls(name=raw.get("name", "Untitled trip"),
                currency=raw.get("currency", "USD"))
        for n in raw.get("nodes", []):
            g.nodes[n["id"]] = Node(**{k: v for k, v in n.items()
                                       if k in Node.__dataclass_fields__})
        for e in raw.get("edges", []):
            g.edges[e["id"]] = Edge(**{k: v for k, v in e.items()
                                       if k in Edge.__dataclass_fields__})
        return g

    # ---- adjacency -------------------------------------------------------- #
    def adjacency(self) -> Dict[str, List[Tuple[str, Edge]]]:
        adj: Dict[str, List[Tuple[str, Edge]]] = {nid: [] for nid in self.nodes}
        for e in self.edges.values():
            if e.source in self.nodes and e.target in self.nodes:
                adj[e.source].append((e.target, e))
                if e.bidirectional:
                    adj[e.target].append((e.source, e))
        return adj

    def validate(self) -> List[str]:
        problems = []
        for e in self.edges.values():
            if e.source not in self.nodes:
                problems.append(f"Edge {e.id}: unknown origin '{e.source}'")
            if e.target not in self.nodes:
                problems.append(f"Edge {e.id}: unknown destination '{e.target}'")
            if e.cost < 0 or e.duration_h < 0:
                problems.append(f"Edge {e.id}: negative cost or duration")
        isolated = [n.name for n in self.nodes.values()
                    if not any(e.source == n.id or e.target == n.id
                               for e in self.edges.values())]
        for name in isolated:
            problems.append(f"'{name}' has no connections")
        return problems


# --------------------------------------------------------------------------- #
# Leg scoring
# --------------------------------------------------------------------------- #
def edge_score(edge: Edge, time_value: float, mode_penalty: Dict[str, float]) -> float:
    """Blended objective for one hop. Lower is better."""
    penalty = mode_penalty.get(edge.mode, 0.0)
    return edge.cost + time_value * edge.total_hours() + penalty


# --------------------------------------------------------------------------- #
# Shortest path (Dijkstra) + K alternatives (Yen's algorithm)
# --------------------------------------------------------------------------- #
def shortest_path(graph: Graph, start: str, end: str, time_value: float = 0.0,
                  mode_penalty: Optional[Dict[str, float]] = None,
                  banned_edges: Optional[set] = None,
                  banned_nodes: Optional[set] = None
                  ) -> Optional[Tuple[List[str], List[Edge], float]]:
    mode_penalty = mode_penalty or {}
    banned_edges = banned_edges or set()
    banned_nodes = banned_nodes or set()
    adj = graph.adjacency()

    dist = {start: 0.0}
    prev: Dict[str, Tuple[str, Edge]] = {}
    pq = [(0.0, start)]
    seen = set()

    while pq:
        d, u = heapq.heappop(pq)
        if u in seen:
            continue
        seen.add(u)
        if u == end:
            break
        for v, e in adj.get(u, []):
            if e.id in banned_edges or v in banned_nodes:
                continue
            nd = d + edge_score(e, time_value, mode_penalty)
            if nd < dist.get(v, float("inf")):
                dist[v] = nd
                prev[v] = (u, e)
                heapq.heappush(pq, (nd, v))

    if end not in dist:
        return None

    path, legs, cur = [end], [], end
    while cur != start:
        p, e = prev[cur]
        legs.append(e)
        path.append(p)
        cur = p
    return path[::-1], legs[::-1], dist[end]


def k_shortest_paths(graph: Graph, start: str, end: str, k: int = 5,
                     time_value: float = 0.0,
                     mode_penalty: Optional[Dict[str, float]] = None
                     ) -> List[Tuple[List[str], List[Edge], float]]:
    """Yen's K-shortest loopless paths — gives you real alternatives to compare."""
    mode_penalty = mode_penalty or {}
    first = shortest_path(graph, start, end, time_value, mode_penalty)
    if not first:
        return []
    accepted = [first]
    candidates: List[Tuple[float, List[str], List[Edge]]] = []

    while len(accepted) < k:
        prev_path, prev_legs = accepted[-1][0], accepted[-1][1]
        for i in range(len(prev_path) - 1):
            spur_node = prev_path[i]
            root_path = prev_path[: i + 1]
            banned_edges, banned_nodes = set(), set(root_path[:-1])
            for p, legs, _ in accepted:
                if p[: i + 1] == root_path and len(p) > i + 1:
                    banned_edges.add(legs[i].id)
            spur = shortest_path(graph, spur_node, end, time_value,
                                 mode_penalty, banned_edges, banned_nodes)
            if not spur:
                continue
            root_legs = prev_legs[:i]
            full_nodes = root_path[:-1] + spur[0]
            full_legs = root_legs + spur[1]
            if any(p == full_nodes for p, _, _ in accepted):
                continue
            score = sum(edge_score(e, time_value, mode_penalty) for e in full_legs)
            entry = (score, full_nodes, full_legs)
            if entry not in candidates:
                candidates.append(entry)
        if not candidates:
            break
        candidates.sort(key=lambda c: c[0])
        score, nodes, legs = candidates.pop(0)
        accepted.append((nodes, legs, score))

    return accepted[:k]


# --------------------------------------------------------------------------- #
# Multi-city itinerary ordering (the "which order do I visit these?" problem)
# --------------------------------------------------------------------------- #
def _pair_matrix(graph: Graph, keys: List[str], time_value: float,
                 mode_penalty: Dict[str, float]) -> Dict[Tuple[str, str], tuple]:
    matrix = {}
    for a in keys:
        for b in keys:
            if a == b:
                continue
            res = shortest_path(graph, a, b, time_value, mode_penalty)
            if res:
                matrix[(a, b)] = res
    return matrix


def plan_tour(graph: Graph, start: str, must_visit: List[str],
              end: Optional[str] = None, time_value: float = 0.0,
              mode_penalty: Optional[Dict[str, float]] = None,
              top_n: int = 5) -> List[dict]:
    """
    Order the must-visit cities to minimise the blended objective.
    Exact (brute force) up to 8 stops; nearest-neighbour + 2-opt beyond that.
    Returns the top_n itineraries, ready for side-by-side comparison.
    """
    mode_penalty = mode_penalty or {}
    stops = [s for s in must_visit if s != start and s != end]
    keys = list({start, *stops, *( [end] if end else [] )})
    matrix = _pair_matrix(graph, keys, time_value, mode_penalty)

    def leg(a, b):
        return matrix.get((a, b))

    orders: List[List[str]] = []
    if len(stops) <= 8:
        orders = [list(p) for p in itertools.permutations(stops)]
    else:
        # greedy nearest neighbour
        remaining, cur, order = set(stops), start, []
        while remaining:
            nxt = min(remaining, key=lambda s: (leg(cur, s) or ([], [], 1e18))[2])
            order.append(nxt)
            remaining.discard(nxt)
            cur = nxt
        # 2-opt improvement
        improved = True
        while improved:
            improved = False
            for i in range(len(order) - 1):
                for j in range(i + 1, len(order)):
                    cand = order[:i] + order[i:j + 1][::-1] + order[j + 1:]
                    if _order_score(cand, start, end, leg) < _order_score(order, start, end, leg):
                        order, improved = cand, True
        orders = [order]

    results, seen_keys = [], set()
    for order in orders:
        seq = [start] + order + ([end] if end else [])
        # a loop trip and its mirror image are the same trip
        key = min(tuple(seq), tuple(reversed(seq)))
        if key in seen_keys:
            continue
        seen_keys.add(key)
        legs, ok = [], True
        for a, b in zip(seq, seq[1:]):
            r = leg(a, b)
            if not r:
                ok = False
                break
            legs.extend(r[1])
        if not ok:
            continue
        results.append(summarise(graph, seq, legs, time_value))

    results.sort(key=lambda r: r["score"])
    return results[:top_n]


def _order_score(order, start, end, leg) -> float:
    seq = [start] + order + ([end] if end else [])
    total = 0.0
    for a, b in zip(seq, seq[1:]):
        r = leg(a, b)
        total += r[2] if r else 1e18
    return total


# --------------------------------------------------------------------------- #
# Summarising an itinerary
# --------------------------------------------------------------------------- #
def summarise(graph: Graph, sequence: List[str], legs: List[Edge],
              time_value: float = 0.0) -> dict:
    travel_cost = sum(e.cost for e in legs)
    travel_hours = sum(e.total_hours() for e in legs)

    visited = list(dict.fromkeys(sequence))
    stay_cost = sum(graph.nodes[n].stay_cost() for n in visited if n in graph.nodes)
    stay_hours = sum(graph.nodes[n].stay_hours() for n in visited if n in graph.nodes)

    total_cost = travel_cost + stay_cost
    return {
        "sequence": sequence,
        "labels": [graph.nodes[n].name if n in graph.nodes else n for n in sequence],
        "legs": [{
            "id": e.id, "from": graph.nodes[e.source].name if e.source in graph.nodes else e.source,
            "to": graph.nodes[e.target].name if e.target in graph.nodes else e.target,
            "mode": e.mode, "cost": round(e.cost, 2),
            "hours": round(e.total_hours(), 2), "notes": e.notes,
        } for e in legs],
        "travel_cost": round(travel_cost, 2),
        "stay_cost": round(stay_cost, 2),
        "total_cost": round(total_cost, 2),
        "travel_hours": round(travel_hours, 2),
        "total_hours": round(travel_hours + stay_hours, 2),
        "total_days": round((travel_hours + stay_hours) / 24.0, 2),
        "hops": len(legs),
        "modes": sorted({e.mode for e in legs}),
        "score": round(total_cost + time_value * travel_hours, 2),
    }


# --------------------------------------------------------------------------- #
# Monte Carlo budget simulation
# --------------------------------------------------------------------------- #
def monte_carlo(graph: Graph, legs_ids: List[str], sequence: List[str],
                runs: int = 5000, stay_var_pct: float = 10.0,
                seed: Optional[int] = None) -> dict:
    """
    Fares move. Hotels move. This answers 'what should I actually budget?'
    Each leg cost is sampled from a triangular distribution around its
    quoted price using the per-edge cost_var_pct.
    """
    rng = random.Random(seed)
    legs = [graph.edges[i] for i in legs_ids if i in graph.edges]
    visited = list(dict.fromkeys(sequence))
    base_stay = sum(graph.nodes[n].stay_cost() for n in visited if n in graph.nodes)

    totals = []
    for _ in range(max(100, runs)):
        t = 0.0
        for e in legs:
            v = max(0.0, e.cost_var_pct) / 100.0
            lo, hi = e.cost * (1 - v), e.cost * (1 + v)
            t += rng.triangular(lo, hi, e.cost) if hi > lo else e.cost
        sv = max(0.0, stay_var_pct) / 100.0
        lo, hi = base_stay * (1 - sv), base_stay * (1 + sv)
        t += rng.triangular(lo, hi, base_stay) if hi > lo else base_stay
        totals.append(t)

    totals.sort()

    def pct(p):
        if not totals:
            return 0.0
        k = min(len(totals) - 1, int(round(p / 100.0 * (len(totals) - 1))))
        return round(totals[k], 2)

    mean = sum(totals) / len(totals)
    return {
        "runs": len(totals),
        "mean": round(mean, 2),
        "p10": pct(10), "p50": pct(50), "p80": pct(80),
        "p90": pct(90), "p95": pct(95),
        "min": round(totals[0], 2), "max": round(totals[-1], 2),
        "recommended_budget": pct(90),
        "histogram": _histogram(totals, 24),
    }


def _histogram(values: List[float], bins: int) -> dict:
    if not values:
        return {"edges": [], "counts": []}
    lo, hi = values[0], values[-1]
    if hi <= lo:
        return {"edges": [lo, hi], "counts": [len(values)]}
    width = (hi - lo) / bins
    counts = [0] * bins
    for v in values:
        idx = min(bins - 1, int((v - lo) / width))
        counts[idx] += 1
    return {
        "edges": [round(lo + i * width, 2) for i in range(bins + 1)],
        "counts": counts,
    }


# --------------------------------------------------------------------------- #
# What-if: drop each leg's price by X% and see which change matters most
# --------------------------------------------------------------------------- #
def sensitivity(graph: Graph, legs_ids: List[str], shift_pct: float = 20.0) -> List[dict]:
    out = []
    legs = [graph.edges[i] for i in legs_ids if i in graph.edges]
    base = sum(e.cost for e in legs)
    for e in legs:
        delta = e.cost * (shift_pct / 100.0)
        out.append({
            "leg": f"{graph.nodes[e.source].name} → {graph.nodes[e.target].name}"
                   if e.source in graph.nodes and e.target in graph.nodes else e.id,
            "mode": e.mode,
            "cost": round(e.cost, 2),
            "share_pct": round(100 * e.cost / base, 1) if base else 0.0,
            "saving_if_cheaper": round(delta, 2),
        })
    out.sort(key=lambda r: r["cost"], reverse=True)
    return out
