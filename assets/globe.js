/* FREIGHTCON — the voyage globe (canvas, orthographic projection, land as a dot matrix).
   FC.Globe.mount(canvas) → { setRoute(from, to, mode), clear() }
   from / to: { lat, lon, label, sub }  ·  mode: 'sea' | 'air' | 'land' */
(function(){
  'use strict';
  const FC = window.FC;
  let depsP = null;
  const deps = () => depsP || (depsP = (async () => {
    if(!window.d3 || !window.d3.geoOrthographic){
      await FC.loadScript('assets/geo/d3-array.min.js');
      await FC.loadScript('assets/geo/d3-geo.min.js');
    }
    const r = await fetch('assets/geo/land-dots.json'); if(!r.ok) throw new Error('land dots');
    return await r.json();
  })());

  FC.Globe = { mount(canvas){
    const api = { route:null, ready:false };
    let d3, DOTS = [], ctx = canvas.getContext('2d'), W = 0, R = 0, dpr = 1, proj, path, grat;
    let rot = [-15, -30, 0], arcK = 1, anim = null, arcAnim = null, drag = null, t0 = performance.now(), running = false;
    const still = () => FC.motionPref && FC.motionPref() === 'off';
    const visible = p => d3.geoDistance(p, [-rot[0], -rot[1]]) < Math.PI / 2 - .02;

    function size(){
      const r = canvas.getBoundingClientRect(); if(!r.width) return false;
      dpr = Math.min(2, window.devicePixelRatio || 1); W = r.width;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(r.height * dpr);
      R = Math.min(W, r.height) * .42; proj.scale(R).translate([W / 2, r.height / 2]);
      return true;
    }
    function draw(now){
      const H = canvas.height / dpr, cx = W / 2, cy = H / 2;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
      proj.rotate(rot);
      const atm = ctx.createRadialGradient(cx, cy, R * .92, cx, cy, R * 1.24);
      atm.addColorStop(0, 'rgba(0,159,227,.30)'); atm.addColorStop(1, 'rgba(0,159,227,0)');
      ctx.fillStyle = atm; ctx.beginPath(); ctx.arc(cx, cy, R * 1.24, 0, 7); ctx.fill();
      const sg = ctx.createRadialGradient(cx - R * .35, cy - R * .4, R * .1, cx, cy, R);
      sg.addColorStop(0, '#103E78'); sg.addColorStop(.6, '#0A2A57'); sg.addColorStop(1, '#061B3B');
      ctx.fillStyle = sg; ctx.beginPath(); path({ type:'Sphere' }); ctx.fill();
      ctx.strokeStyle = 'rgba(127,208,243,.35)'; ctx.lineWidth = 1; ctx.stroke();
      ctx.beginPath(); path(grat); ctx.strokeStyle = 'rgba(142,165,196,.08)'; ctx.lineWidth = .7; ctx.stroke();
      const ctr = [-rot[0], -rot[1]];
      for(let i = 0; i < DOTS.length; i += 2){
        const p = [DOTS[i] / 10, DOTS[i + 1] / 10], d = d3.geoDistance(p, ctr);
        if(d > Math.PI / 2) continue;
        const xy = proj(p); ctx.fillStyle = `rgba(150,196,236,${(.25 + .6 * Math.cos(d)).toFixed(3)})`;
        ctx.fillRect(xy[0] - .85, xy[1] - .85, 1.7, 1.7);
      }
      const rt = api.route; if(!rt) return;
      const A = [rt.from.lon, rt.from.lat], B = [rt.to.lon, rt.to.lat], ip = d3.geoInterpolate(A, B), dist = d3.geoDistance(A, B);
      const lift = rt.mode === 'air' ? Math.min(.32, dist * .14) : rt.mode === 'land' ? .015 : Math.min(.12, dist * .05);
      const N = 140, pts = [];
      for(let k = 0; k <= N; k++){ const t = k / N, ll = ip(t), xy = proj(ll), h = 1 + lift * Math.sin(Math.PI * t);
        pts.push(visible(ll) && xy ? [cx + (xy[0] - cx) * h, cy + (xy[1] - cy) * h, t] : null); }
      const seg = (upto, style, width, dash, blur) => {
        ctx.save(); ctx.strokeStyle = style; ctx.lineWidth = width; ctx.setLineDash(dash || []); ctx.lineCap = 'round';
        if(blur){ ctx.shadowColor = 'rgba(0,159,227,.9)'; ctx.shadowBlur = blur; }
        ctx.beginPath(); let pen = false;
        for(const q of pts){ if(!q || q[2] > upto){ pen = false; continue; } if(!pen){ ctx.moveTo(q[0], q[1]); pen = true; } else ctx.lineTo(q[0], q[1]); }
        ctx.stroke(); ctx.restore();
      };
      if(dist > .002){ seg(1, 'rgba(142,165,196,.35)', 1.2, [3, 5]); seg(arcK, '#2FB5F0', 2.4, null, 14); }
      const mark = (ll, lbl, sub, glow) => {
        if(!visible(ll)) return; const xy = proj(ll), pulse = 1 + .25 * Math.sin((now - t0) / 380);
        ctx.save(); ctx.fillStyle = 'rgba(0,159,227,.22)'; ctx.beginPath(); ctx.arc(xy[0], xy[1], 9 * (glow && !still() ? pulse : 1), 0, 7); ctx.fill();
        ctx.fillStyle = '#E9F1FA'; ctx.beginPath(); ctx.arc(xy[0], xy[1], 3.6, 0, 7); ctx.fill(); ctx.strokeStyle = '#009FE3'; ctx.lineWidth = 2; ctx.stroke();
        const right = xy[0] > cx, dx = right ? 12 : -12; ctx.textAlign = right ? 'left' : 'right';
        ctx.font = '700 14px Calibri, Carlito, sans-serif'; ctx.fillStyle = '#E9F1FA'; ctx.fillText(lbl, xy[0] + dx, xy[1] - 4);
        if(sub){ ctx.font = '400 12px Calibri, Carlito, sans-serif'; ctx.fillStyle = '#8EA5C4'; ctx.fillText(sub, xy[0] + dx, xy[1] + 11); }
        ctx.restore();
      };
      if(rt.from.label) mark(A, rt.from.label, rt.from.sub, arcK < 1);
      if(rt.to.label && dist > .002) mark(B, rt.to.label, rt.to.sub, arcK >= 1);
      const head = pts[Math.round(Math.min(arcK, 1) * N)];
      if(head && arcK > 0 && arcK < 1){ ctx.save(); ctx.fillStyle = '#fff'; ctx.shadowColor = '#009FE3'; ctx.shadowBlur = 16; ctx.beginPath(); ctx.arc(head[0], head[1], 4.2, 0, 7); ctx.fill(); ctx.restore(); }
    }
    function tweenTo(target, ms, then){
      const r0 = rot.slice(), dl = ((target[0] - r0[0] + 540) % 360) - 180, s = performance.now();
      anim = now => { const k = Math.min(1, (now - s) / ms), e = k < .5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
        rot = [r0[0] + dl * e, r0[1] + (target[1] - r0[1]) * e, 0]; if(k >= 1){ anim = null; if(then) then(); } };
    }
    function growArc(ms){ const s = performance.now(); arcK = 0; arcAnim = now => { const k = Math.min(1, (now - s) / ms); arcK = 1 - Math.pow(1 - k, 3); if(k >= 1) arcAnim = null; }; }
    function loop(now){
      if(!canvas.isConnected){ running = false; return; }
      if(canvas.offsetParent !== null){
        if(!W) size();
        if(anim) anim(now); if(arcAnim) arcAnim(now);
        if(!api.route && !drag && !still()) rot[0] += .05;
        if(W) draw(now);
      }
      requestAnimationFrame(loop);
    }
    // a route with the same endpoints only moves the camera; new endpoints redraw the voyage
    api.setRoute = (from, to, mode) => {
      const prev = api.route, same = prev && prev.from.lat === from.lat && prev.from.lon === from.lon && prev.to.lat === to.lat && prev.to.lon === to.lon;
      api.route = { from, to, mode };
      if(!d3) return;
      const mid = d3.geoInterpolate([from.lon, from.lat], [to.lon, to.lat])(.5), target = [-mid[0], Math.max(-55, Math.min(55, -mid[1] * .9))];
      if(still()){ rot = [target[0], target[1], 0]; arcK = 1; return; }
      if(same){ tweenTo(target, 500); return; }
      arcK = 0; tweenTo(target, 1000, () => growArc(1400));
    };
    api.focus = (pt) => { if(!d3 || still()) return; tweenTo([-pt.lon, Math.max(-55, Math.min(55, -pt.lat * .9))], 900); };
    api.clear = () => { api.route = null; };
    canvas.addEventListener('pointerdown', e => { drag = { x:e.clientX, y:e.clientY, r:rot.slice() }; try{ canvas.setPointerCapture(e.pointerId); }catch(_){} anim = null; });
    canvas.addEventListener('pointermove', e => { if(!drag || !R) return; const k = 75 / R; rot = [drag.r[0] + (e.clientX - drag.x) * k, Math.max(-70, Math.min(70, drag.r[1] - (e.clientY - drag.y) * k)), 0]; });
    ['pointerup','pointercancel'].forEach(ev => canvas.addEventListener(ev, () => { drag = null; }));
    window.addEventListener('resize', () => { if(proj) size(); });
    deps().then(dots => {
      d3 = window.d3; DOTS = dots; proj = d3.geoOrthographic().clipAngle(90).precision(.4); path = d3.geoPath(proj, ctx); grat = d3.geoGraticule10();
      api.ready = true; size();
      if(api.route){ const r = api.route; api.route = null; api.setRoute(r.from, r.to, r.mode); }
      if(!running){ running = true; requestAnimationFrame(loop); }
    }).catch(e => { console.warn('globe unavailable', e); canvas.hidden = true; });
    return api;
  } };
})();
