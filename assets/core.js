/* FREIGHTCON — shared helpers (loaded by every page after config.js and supabase-js) */
(function(){
  'use strict';
  const FC = window.FC = {};

  // ---------- theme (before paint) ----------
  try{ const t = localStorage.getItem('freightcon-theme'); if(t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t); }catch(e){}
  FC.isDark = () => {
    const t = document.documentElement.getAttribute('data-theme');
    return t ? t === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  };
  FC.toggleTheme = () => {
    const next = FC.isDark() ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try{ localStorage.setItem('freightcon-theme', next); }catch(e){}
  };

  // ---------- supabase ----------
  if(window.supabase && window.SUPABASE_URL && window.SUPABASE_ANON_KEY){
    FC.sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
  }
  FC.brand = window.FREIGHTCON_BRAND || 'FREIGHTCON';
  FC.supportEmail = window.FREIGHTCON_SUPPORT_EMAIL || '';

  // ---------- text & numbers ----------
  FC.esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  FC.parseNum = v => {
    if(typeof v === 'number') return v;
    const s = String(v == null ? '' : v).trim().replace(/\s/g, '');
    if(!s) return NaN;
    // accept 1,234,567.89 and 1.234.567,89
    // Rules: "1,234,567.89" and "1.234.567,89" are thousands-grouped; a single dot is always a decimal point
    // ("0.132" = 0.132, never 132); a single comma with 1-2 decimals is a decimal comma ("12,5" = 12.5).
    let t = s;
    const dots = (t.match(/\./g) || []).length, commas = (t.match(/,/g) || []).length;
    if(dots && commas) t = t.lastIndexOf(',') > t.lastIndexOf('.') ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
    else if(dots > 1) t = t.replace(/\./g, '');
    else if(commas === 1 && /,\d{1,2}$/.test(t)) t = t.replace(',', '.');
    else t = t.replace(/,/g, '');
    const n = Number(t);
    return isFinite(n) ? n : NaN;
  };
  const SYM = { EUR:'€', USD:'$' };
  FC.money = (n, cur, dec) => {
    if(n == null || n === '' || !isFinite(Number(n))) return '—';
    const d = dec == null ? (Math.abs(Number(n)) < 1000 && Number(n) % 1 !== 0 ? 2 : 0) : dec;
    return (SYM[cur] || (cur ? cur + ' ' : '')) + Number(n).toLocaleString('en-GB', { minimumFractionDigits:d, maximumFractionDigits:d });
  };
  FC.money2 = (n, cur) => FC.money(n, cur, 2);
  FC.pct = (n, d) => n == null ? '—' : Number(n).toLocaleString('en-GB', { minimumFractionDigits:d == null ? 3 : d, maximumFractionDigits:4 }) + ' %';
  FC.groupInput = el => {
    el.addEventListener('blur', () => { const n = FC.parseNum(el.value); if(isFinite(n) && n > 0) el.value = n.toLocaleString('en-GB', { maximumFractionDigits:2 }); });
    el.addEventListener('focus', () => { const n = FC.parseNum(el.value); if(isFinite(n) && n > 0) el.value = String(n); });
  };
  FC.date = v => { if(!v) return '—'; const d = new Date(v); return isNaN(d) ? '—' : d.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' }); };
  FC.dateTime = v => { if(!v) return '—'; const d = new Date(v); return isNaN(d) ? '—' : d.toLocaleString('en-GB', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }); };
  FC.ago = v => {
    const s = (Date.now() - new Date(v).getTime()) / 1000;
    if(!isFinite(s)) return '';
    if(s < 60) return 'just now';
    if(s < 3600) return Math.round(s / 60) + ' min ago';
    if(s < 86400) return Math.round(s / 3600) + ' h ago';
    if(s < 86400 * 14) return Math.round(s / 86400) + ' days ago';
    return FC.date(v);
  };
  FC.today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
  FC.initials = s => String(s || '?').replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';

  // ---------- vocabulary ----------
  FC.CONVEYANCE = {
    sea_container: { label:'Sea, container', short:'Sea (container)' },
    sea_breakbulk: { label:'Sea, breakbulk / RoRo', short:'Sea (breakbulk)' },
    air:  { label:'Air', short:'Air' },
    road: { label:'Road', short:'Road' },
    rail: { label:'Rail', short:'Rail' }
  };
  FC.COVER = {
    icc_a: { label:'All risks', clause:'Institute Cargo Clauses (A)', text:'Physical loss or damage from any external cause, subject to the standard exclusions.' },
    icc_b: { label:'Named perils, extended', clause:'Institute Cargo Clauses (B)', text:'Named perils incl. heavy weather water entry, earthquake and loss overboard.' },
    icc_c: { label:'Named perils, basic', clause:'Institute Cargo Clauses (C)', text:'Major casualties only: fire, sinking, stranding, collision, overturning, general average.' }
  };
  FC.STATUS = { quoted:'Indication', on_request:'On request', sanctioned:'Compliance review' };
  FC.STAGE = { new:'New', in_progress:'In progress', quoted:'Quoted', accepted:'Accepted', declined:'Declined', bound:'Bound', lost:'Lost', closed:'Closed' };

  // ---------- icons ----------
  const svg = p => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
  FC.icon = {
    sea_container: svg('<path d="M3 17h18l-2.5 4H5.5z"/><rect x="5" y="10" width="6" height="5"/><rect x="12" y="10" width="6" height="5"/><rect x="8.5" y="5" width="6" height="5"/>'),
    sea_breakbulk: svg('<path d="M3 16h18l-2.5 5H5.5z"/><path d="M12 3v13M12 6l6 6H6z"/>'),
    air:  svg('<path d="M2.5 13.5l19-7-5 15-3.5-6.5z"/><path d="M13 15l-3 5-1-6"/>'),
    road: svg('<rect x="2" y="7" width="12" height="9" rx="1"/><path d="M14 10h4l3 3v3h-7z"/><circle cx="6.5" cy="17.5" r="1.8"/><circle cx="17.5" cy="17.5" r="1.8"/>'),
    rail: svg('<rect x="5" y="3" width="14" height="13" rx="2"/><path d="M5 10h14M9 20l-2 2M15 20l2 2M8 16l-1 4h10l-1-4"/><circle cx="9" cy="13" r=".8"/><circle cx="15" cy="13" r=".8"/>'),
    box:  svg('<path d="M3 7.5l9-4.5 9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5l9 4.5 9-4.5M12 12v9"/>'),
    route: svg('<circle cx="5" cy="18" r="2.5"/><circle cx="19" cy="6" r="2.5"/><path d="M7.5 18h6a3.5 3.5 0 0 0 0-7h-3a3.5 3.5 0 0 1 0-7h6"/>'),
    coin: svg('<circle cx="12" cy="12" r="8.5"/><path d="M14.8 9.2c-.6-.8-1.6-1.2-2.8-1.2-1.7 0-2.8.9-2.8 2s1 1.7 2.8 2.1 2.8 1 2.8 2.1-1.2 2-2.8 2c-1.3 0-2.3-.4-2.9-1.2M12 6.5v11"/>'),
    shield: svg('<path d="M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>'),
    doc: svg('<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>'),
    download: svg('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'),
    send: svg('<path d="M21 3L10 14M21 3l-7 18-4-7-7-4z"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    list: svg('<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>'),
    clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    moon: svg('<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>'),
    sun:  svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
    chat: svg('<path d="M21 12a8 8 0 0 1-11.8 7L3 21l2-6A8 8 0 1 1 21 12z"/>'),
    gift: svg('<rect x="3" y="8" width="18" height="4"/><path d="M5 12v9h14v-9M12 8v13M12 8S10.5 3 8 4s-.5 4 4 4zm0 0s1.5-5 4-4 .5 4-4 4z"/>'),
    gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>')
  };
  FC.logoSvg = `<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="1" y="1" width="30" height="30" rx="7" fill="#0C3640"/><path d="M7 21h18l-2.6 4H9.6z" fill="#E9A23B"/><rect x="8" y="14" width="7.2" height="5.4" rx=".6" fill="#fff"/><rect x="16.6" y="14" width="7.2" height="5.4" rx=".6" fill="#7FD4D9"/><rect x="12.3" y="7.4" width="7.2" height="5.4" rx=".6" fill="#fff" opacity=".85"/></svg>`;
  FC.wordmarkHtml = sub => `${FC.logoSvg}<div><b>${FC.esc(FC.brand)}</b>${sub === false ? '' : `<span>${FC.esc(sub || 'Cargo insurance indications, quotations & cover')}</span>`}</div>`;

  // ---------- small DOM helpers ----------
  FC.$ = (sel, root) => (root || document).querySelector(sel);
  FC.$$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  FC.el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  FC.busy = (btn, on) => { if(!btn) return; btn.disabled = !!on; btn.classList.toggle('busy', !!on); };

  // ---------- toast ----------
  FC.toast = (msg, kind) => {
    let host = document.getElementById('toasts');
    if(!host){ host = document.createElement('div'); host.id = 'toasts'; host.setAttribute('role', 'status'); host.setAttribute('aria-live', 'polite'); document.body.appendChild(host); }
    const t = document.createElement('div'); t.className = 'toast' + (kind === 'error' ? ' error' : ''); t.textContent = msg;
    host.appendChild(t);
    setTimeout(() => t.remove(), kind === 'error' ? 6500 : 3800);
  };

  // ---------- dialog ----------
  // FC.dialog({ title, body (html or node), wide, actions:[{label, kind, value, onClick(close, dlg) }] }) → Promise(value)
  FC.dialog = (o) => new Promise(resolve => {
    const back = document.createElement('div'); back.className = 'dlg-back';
    const box = document.createElement('div'); box.className = 'dlg' + (o.wide ? ' wide' : ''); box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true');
    box.innerHTML = `<div class="dlg-head"><h2></h2><button type="button" class="x" aria-label="Close">&times;</button></div><div class="dlg-body"></div><div class="dlg-foot"></div>`;
    box.querySelector('h2').textContent = o.title || '';
    const body = box.querySelector('.dlg-body');
    if(typeof o.body === 'string') body.innerHTML = o.body; else if(o.body) body.appendChild(o.body);
    const foot = box.querySelector('.dlg-foot');
    const prevFocus = document.activeElement;
    const close = v => { document.removeEventListener('keydown', onKey); back.remove(); try{ prevFocus && prevFocus.focus(); }catch(e){} resolve(v); };
    const onKey = e => { if(e.key === 'Escape' && o.dismissible !== false) close(null); };
    (o.actions || [{ label:'Close', kind:'ghost', value:null }]).forEach(a => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn-' + (a.kind || 'ghost');
      b.innerHTML = '<span class="spin"></span>' + FC.esc(a.label);
      b.addEventListener('click', async () => {
        if(a.onClick){
          FC.busy(b, true);
          try{ const r = await a.onClick(close, box, b); if(r !== undefined) close(r); }
          finally{ if(b.isConnected) FC.busy(b, false); }
        }else close(a.value);
      });
      foot.appendChild(b);
    });
    if(o.dismissible !== false){
      box.querySelector('.x').addEventListener('click', () => close(null));
      back.addEventListener('mousedown', e => { if(e.target === back) close(null); });
    }else box.querySelector('.x').remove();
    document.addEventListener('keydown', onKey);
    back.appendChild(box); document.body.appendChild(back);
    if(o.onOpen) o.onOpen(box, close);
    setTimeout(() => { if(box.contains(document.activeElement)) return; const f = box.querySelector('[autofocus], .dlg-body input, .dlg-body textarea, .dlg-body select') || foot.lastElementChild; try{ f && f.focus(); }catch(e){} }, 20);
  });
  FC.confirm = (title, text, okLabel, kind) => FC.dialog({
    title, body: `<p style="margin:0">${FC.esc(text)}</p>`,
    actions: [{ label:'Cancel', kind:'ghost', value:false }, { label: okLabel || 'Confirm', kind: kind || 'primary', value:true }]
  }).then(v => v === true);

  // ---------- error text for the user ----------
  FC.errText = (err, fallback) => {
    const m = String((err && (err.message || err.error_description)) || err || '');
    if(/maintenance/i.test(m)) return 'The platform is in maintenance right now. Please try again shortly.';
    if(/not authori[sz]ed|permission|JWT/i.test(m)) return 'Your session has no access to this. Please log in again.';
    if(/expired/i.test(m)) return 'This quotation has expired. Please request a new one.';
    if(/no longer open/i.test(m)) return 'This quotation has already been answered or replaced.';
    if(/Failed to fetch|NetworkError|network/i.test(m)) return 'No connection to the server. Check your internet connection and try again.';
    return fallback || 'Something went wrong. Please try again.';
  };

  // ---------- downloads ----------
  FC.saveBlob = (bytes, name, type) => {
    const url = URL.createObjectURL(new Blob([bytes], { type: type || 'application/pdf' }));
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };
  FC.loadScript = src => new Promise((res, rej) => {
    if(document.querySelector(`script[src="${src}"]`)) return res();
    const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src)); document.head.appendChild(s);
  });
})();
