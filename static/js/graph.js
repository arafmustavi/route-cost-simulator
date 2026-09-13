/* Voyagraph — dependency-free canvas graph editor.
   Pan, zoom, drag nodes, shift-drag to connect, highlight a route. */

(function (global) {
  const MODE_COLOR = {
    flight: '#0071e3', train: '#1d9e5a', bus: '#c77700',
    ferry: '#00a2b8', car: '#8e5cd9', rideshare: '#d3568b',
    walk: '#6e6e73', other: '#6e6e73'
  };

  class GraphCanvas {
    constructor(canvas, store, handlers = {}) {
      this.c = canvas;
      this.ctx = canvas.getContext('2d');
      this.store = store;                 // { nodes:[], edges:[] }
      this.h = handlers;                  // { onNodeClick, onEdgeCreate, onChange }
      this.scale = 1; this.ox = 0; this.oy = 0;
      this.drag = null; this.link = null; this.hover = null;
      this.highlight = new Set();         // edge ids on the chosen route
      this.hlNodes = new Set();
      this._bind();
      this.resize();
    }

    /* ---------- coordinate helpers ---------- */
    toWorld(px, py) {
      const r = this.c.getBoundingClientRect();
      return { x: (px - r.left - this.ox) / this.scale, y: (py - r.top - this.oy) / this.scale };
    }
    nodeAt(wx, wy) {
      for (let i = this.store.nodes.length - 1; i >= 0; i--) {
        const n = this.store.nodes[i];
        if (Math.hypot(n.x - wx, n.y - wy) < 26) return n;
      }
      return null;
    }

    /* ---------- events ---------- */
    _bind() {
      const c = this.c;
      c.addEventListener('mousedown', e => {
        const w = this.toWorld(e.clientX, e.clientY);
        const n = this.nodeAt(w.x, w.y);
        if (n && e.shiftKey) {
          this.link = { from: n, x: w.x, y: w.y };
        } else if (n) {
          this.drag = { node: n, dx: n.x - w.x, dy: n.y - w.y, moved: false };
        } else {
          this.pan = { x: e.clientX - this.ox, y: e.clientY - this.oy };
        }
      });

      c.addEventListener('mousemove', e => {
        const w = this.toWorld(e.clientX, e.clientY);
        if (this.drag) {
          this.drag.node.x = w.x + this.drag.dx;
          this.drag.node.y = w.y + this.drag.dy;
          this.drag.moved = true;
          this.draw();
        } else if (this.link) {
          this.link.x = w.x; this.link.y = w.y; this.draw();
        } else if (this.pan) {
          this.ox = e.clientX - this.pan.x; this.oy = e.clientY - this.pan.y; this.draw();
        } else {
          const n = this.nodeAt(w.x, w.y);
          if (n !== this.hover) { this.hover = n; c.style.cursor = n ? 'pointer' : 'grab'; this.draw(); }
        }
      });

      window.addEventListener('mouseup', e => {
        if (this.link) {
          const w = this.toWorld(e.clientX, e.clientY);
          const target = this.nodeAt(w.x, w.y);
          if (target && target.id !== this.link.from.id && this.h.onEdgeCreate)
            this.h.onEdgeCreate(this.link.from.id, target.id);
          this.link = null; this.draw();
        }
        if (this.drag) {
          if (!this.drag.moved && this.h.onNodeClick) this.h.onNodeClick(this.drag.node.id);
          else if (this.h.onChange) this.h.onChange();
          this.drag = null;
        }
        this.pan = null;
      });

      c.addEventListener('wheel', e => {
        e.preventDefault();
        const r = c.getBoundingClientRect();
        const mx = e.clientX - r.left, my = e.clientY - r.top;
        const k = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        const ns = Math.min(2.6, Math.max(0.25, this.scale * k));
        this.ox = mx - (mx - this.ox) * (ns / this.scale);
        this.oy = my - (my - this.oy) * (ns / this.scale);
        this.scale = ns; this.draw();
      }, { passive: false });

      window.addEventListener('resize', () => this.resize());
    }

    resize() {
      const r = this.c.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      this.c.width = r.width * dpr; this.c.height = r.height * dpr;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.w = r.width; this.hgt = r.height;
      this.draw();
    }

    /* ---------- layout ---------- */
    autoArrange() {
      const n = this.store.nodes.length;
      if (!n) return;
      const cx = this.w / 2, cy = this.hgt / 2;
      const R = Math.min(cx, cy) - 70;
      this.store.nodes.forEach((nd, i) => {
        const a = (i / n) * Math.PI * 2 - Math.PI / 2;
        nd.x = cx + R * Math.cos(a); nd.y = cy + R * Math.sin(a);
      });
      this.scale = 1; this.ox = 0; this.oy = 0;
      this.draw(); if (this.h.onChange) this.h.onChange();
    }

    fit() {
      const ns = this.store.nodes;
      if (!ns.length) return;
      const xs = ns.map(n => n.x), ys = ns.map(n => n.y);
      const minX = Math.min(...xs) - 70, maxX = Math.max(...xs) + 70;
      const minY = Math.min(...ys) - 60, maxY = Math.max(...ys) + 60;
      const s = Math.min(this.w / (maxX - minX), this.hgt / (maxY - minY), 1.8);
      this.scale = Math.max(0.25, s);
      this.ox = (this.w - (maxX - minX) * this.scale) / 2 - minX * this.scale;
      this.oy = (this.hgt - (maxY - minY) * this.scale) / 2 - minY * this.scale;
      this.draw();
    }

    setRoute(edgeIds, nodeIds) {
      this.highlight = new Set(edgeIds || []);
      this.hlNodes = new Set(nodeIds || []);
      this.draw();
    }

    /* ---------- rendering ---------- */
    draw() {
      const g = this.ctx, S = getComputedStyle(document.body);
      const ink = S.getPropertyValue('--ink').trim();
      const ink2 = S.getPropertyValue('--ink-2').trim();
      const line = S.getPropertyValue('--grid').trim();
      const panel = S.getPropertyValue('--panel-solid').trim();
      const accent = S.getPropertyValue('--accent').trim();

      g.clearRect(0, 0, this.w, this.hgt);

      // grid
      const step = 28 * this.scale;
      g.strokeStyle = line; g.lineWidth = 1;
      for (let x = this.ox % step; x < this.w; x += step) {
        g.beginPath(); g.moveTo(x, 0); g.lineTo(x, this.hgt); g.stroke();
      }
      for (let y = this.oy % step; y < this.hgt; y += step) {
        g.beginPath(); g.moveTo(0, y); g.lineTo(this.w, y); g.stroke();
      }

      g.save();
      g.translate(this.ox, this.oy); g.scale(this.scale, this.scale);

      const byId = Object.fromEntries(this.store.nodes.map(n => [n.id, n]));

      // edges
      this.store.edges.forEach(e => {
        const a = byId[e.source], b = byId[e.target];
        if (!a || !b) return;
        const on = this.highlight.has(e.id);
        g.strokeStyle = on ? accent : (MODE_COLOR[e.mode] || '#888');
        g.globalAlpha = on ? 1 : 0.34;
        g.lineWidth = on ? 3.6 : 1.8;
        if (e.mode === 'flight') g.setLineDash(on ? [] : [7, 5]); else g.setLineDash([]);

        // gentle curve so two-way pairs don't overlap
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
        const cx = mx - dy / len * 18, cy = my + dx / len * 18;
        g.beginPath(); g.moveTo(a.x, a.y); g.quadraticCurveTo(cx, cy, b.x, b.y); g.stroke();
        g.setLineDash([]);

        if (on || this.scale > 0.75) {
          g.globalAlpha = on ? 1 : 0.7;
          g.fillStyle = on ? accent : ink2;
          g.font = `${on ? '600 ' : ''}11px -apple-system,system-ui,sans-serif`;
          g.textAlign = 'center';
          const lbl = `${e.cost ? Math.round(e.cost) : 0} · ${(+e.duration_h + +(e.wait_h || 0)).toFixed(1)}h`;
          g.fillText(lbl, cx, cy - 4);
        }
        g.globalAlpha = 1;
      });

      // pending link
      if (this.link) {
        g.strokeStyle = accent; g.lineWidth = 2; g.setLineDash([5, 5]);
        g.beginPath(); g.moveTo(this.link.from.x, this.link.from.y);
        g.lineTo(this.link.x, this.link.y); g.stroke(); g.setLineDash([]);
      }

      // nodes
      this.store.nodes.forEach(n => {
        const on = this.hlNodes.has(n.id);
        const hov = this.hover && this.hover.id === n.id;
        const r = on ? 24 : 20;

        g.shadowColor = 'rgba(0,0,0,.18)'; g.shadowBlur = hov ? 16 : 8; g.shadowOffsetY = 3;
        g.beginPath(); g.arc(n.x, n.y, r, 0, Math.PI * 2);
        g.fillStyle = on ? accent : panel; g.fill();
        g.shadowBlur = 0; g.shadowOffsetY = 0;

        g.strokeStyle = on ? accent : (hov ? accent : 'rgba(128,128,128,.45)');
        g.lineWidth = on || hov ? 2.4 : 1.4; g.stroke();

        // nights indicator
        if (+n.stay_nights > 0) {
          g.fillStyle = on ? '#fff' : ink;
          g.font = '600 12px -apple-system,system-ui,sans-serif';
          g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillText(`${(+n.stay_nights)}n`, n.x, n.y);
        }

        g.fillStyle = ink; g.textAlign = 'center'; g.textBaseline = 'top';
        g.font = '600 12.5px -apple-system,system-ui,sans-serif';
        g.fillText(n.name, n.x, n.y + r + 6);
        if (n.country) {
          g.fillStyle = ink2; g.font = '10.5px -apple-system,system-ui,sans-serif';
          g.fillText(n.country, n.x, n.y + r + 21);
        }
      });

      g.restore();

      if (!this.store.nodes.length) {
        g.fillStyle = ink2; g.textAlign = 'center'; g.font = '14px -apple-system,system-ui,sans-serif';
        g.fillText('Add your first place on the left, or load the sample trip.', this.w / 2, this.hgt / 2);
      }
    }
  }

  global.GraphCanvas = GraphCanvas;
  global.MODE_COLOR = MODE_COLOR;
})(window);
