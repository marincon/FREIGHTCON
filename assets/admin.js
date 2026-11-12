/* FREIGHTCON — internal area (admins only; the database enforces this, the UI only mirrors it) */
(function(){
  'use strict';
  const { $, $$, sb, esc, money2, busy, toast } = FC;
  const A = window.FCAdmin = {};
  let root = null, tab = 'requests', loaded = false;
  const S = { clauses:[], polClauses:[], warAreas:[], warEx:[], rows:[], profiles:{}, commodities:[], regions:[], countries:[], settings:{}, insurers:[], quotes:{}, coverNotes:{}, rateTables:[], rateCells:[], qint:{}, claims:[], claimEvents:{}, claimFiles:{}, claimInt:{}, groups:[], policies:[], offices:[], audit:[] };
  const cName = iso => (S.countries.find(c => c.iso2 === iso) || {}).name || iso || '';
  const me = () => FC.profile || {};
  const myInitials = () => FC.initials(me().full_name || me().email);
  const setting = (k, d) => (S.settings[k] !== undefined ? S.settings[k] : d);

  const TABS = [['requests','Requests'],['claims','Claims'],['overview','Overview'],['ledger','Ledger'],['customers','Customers'],['rates','Rates'],['clauses','Clauses'],['insurers','Insurers'],['feedback','Feedback'],['settings','Settings']];

  A.open = async (host) => {
    root = host;
    if(!loaded){
      root.innerHTML = `<div class="view-head"><div><h1>Internal</h1><p>Requests, quotations, cover and customers.</p></div>
          <div class="toolbar" style="margin:0"><button class="btn btn-ghost btn-sm" id="admRefresh" type="button"><span class="spin"></span>Refresh</button><button class="btn btn-primary btn-sm" id="admExternal" type="button">External view</button></div></div>
        <div class="tabs" role="tablist">${TABS.map(([k, l]) => `<button role="tab" data-atab="${k}" aria-selected="${k === tab}">${l}<span class="badge" data-abadge="${k}" hidden></span></button>`).join('')}</div>
        <div id="admBody"></div>`;
      $$('[data-atab]', root).forEach(b => b.addEventListener('click', () => { tab = b.dataset.atab; $$('[data-atab]', root).forEach(x => x.setAttribute('aria-selected', String(x === b))); render(); }));
      $('#admExternal', root).addEventListener('click', () => FC.go(FC.lastExternal || 'new'));
      $('#admRefresh', root).addEventListener('click', async e => { busy(e.currentTarget, true); await loadAll(); busy(e.currentTarget, false); render(); toast('Updated.'); });
      loaded = true;
      await loadAll();
    }
    render();
  };

  async function loadAll(){
    const [ind, prof, com, reg, cty, set, ins, q, cn, rt, rc, qi, cl, ce, cf, cin, grp, pol, ofc, iin, aud, wa, wx, cla, pcl] = await Promise.all([
      sb.from('indications').select('*').order('created_at', { ascending:false }).limit(1500),
      sb.from('profiles').select('*').order('created_at', { ascending:false }),
      sb.from('commodities').select('*').order('sort'),
      sb.from('regions').select('*').order('sort'),
      sb.from('countries').select('*').order('name'),
      sb.from('settings').select('*').order('key'),
      sb.from('insurers').select('*').order('name'),
      sb.from('quotations').select('id,indication_id,version,status,valid_until,created_at,responded_at,response_note,data').order('version'),
      sb.from('cover_notes').select('*').order('issued_at'),
      sb.from('rate_tables').select('*').order('sort'),
      sb.from('rate_cells').select('*'),
      sb.from('quotation_internal').select('*'),
      sb.from('claims').select('*').order('created_at', { ascending:false }),
      sb.from('claim_events').select('*').order('created_at'),
      sb.from('claim_files').select('*').order('created_at'),
      sb.from('claim_internal').select('*'),
      sb.from('client_groups').select('*').order('sort'),
      sb.from('policies').select('*').order('sort'),
      sb.from('offices').select('*').order('sort'),
      sb.from('indication_internal').select('*'),
      sb.from('audit_log').select('*').order('at', { ascending:false }).limit(300),
      sb.from('war_areas').select('*').order('sort'),
      sb.from('war_exclusions').select('*').order('id'),
      sb.from('clause_library').select('*').order('sort'),
      sb.from('policy_clauses').select('*')
    ]);
    S.clauses = cla.data || []; S.polClauses = pcl.data || [];
    S.warAreas = (wa.data || []); S.warEx = (wx.data || []);
    S.groups = grp.data || []; S.policies = pol.data || []; S.offices = ofc.data || []; S.audit = aud.data || [];
    // what the client must not see is kept apart; staff see the full picture
    const intern = {}; (iin.data || []).forEach(x => intern[x.indication_id] = x);
    (ind.data || []).forEach(r => {
      const x = intern[r.id]; if(!x) return;
      r.notes = x.notes || []; r.alerts = x.alerts || []; r.war = x.war || null;
      if(!r.calc_detail) r.calc_detail = x.calc_detail;
      if(r.intake){ r.status = x.status; r.rate_pct = x.rate_pct; r.premium_gross = x.premium_gross; r.premium = x.premium; r.min_applied = x.min_applied; r.reasons = x.reasons || []; }
    });
    const err = [ind, prof, com, reg, cty, set, ins, q, cn, rt, rc].find(r => r.error);
    S.qint = {}; (qi.data || []).forEach(x => S.qint[x.quotation_id] = x);
    S.claims = cl.data || []; S.claimEvents = {}; S.claimFiles = {}; S.claimInt = {};
    (ce.data || []).forEach(x => (S.claimEvents[x.claim_id] = S.claimEvents[x.claim_id] || []).push(x));
    (cf.data || []).forEach(x => (S.claimFiles[x.claim_id] = S.claimFiles[x.claim_id] || []).push(x));
    (cin.data || []).forEach(x => S.claimInt[x.claim_id] = x);
    if(err) toast('Some internal data could not be loaded: ' + err.error.message, 'error');
    S.rateTables = rt.data || []; S.rateCells = rc.data || [];
    S.rows = ind.data || []; S.commodities = com.data || []; S.regions = reg.data || []; S.countries = cty.data || []; S.insurers = ins.data || [];
    S.profiles = {}; (prof.data || []).forEach(p => S.profiles[p.id] = p);
    S.settingRows = set.data || []; S.settings = {}; S.settingRows.forEach(s => S.settings[s.key] = s.value);
    S.quotes = {}; (q.data || []).forEach(x => (S.quotes[x.indication_id] = S.quotes[x.indication_id] || []).push(x));
    S.coverNotes = {}; (cn.data || []).forEach(x => (S.coverNotes[x.indication_id] = S.coverNotes[x.indication_id] || []).push(x));
    paintBadges();
  }
  const openRequests = () => S.rows.filter(r => r.quote_requested_at && ['new','in_progress'].includes(r.stage) && !(S.quotes[r.id] || []).some(q => q.status !== 'superseded'));
  const acceptedNoCover = () => S.rows.filter(r => r.stage === 'accepted' && !(S.coverNotes[r.id] || []).length);
  const pendingUsers = () => Object.values(S.profiles).filter(p => !p.approved && !p.rejected);
  function paintBadges(){
    const n = openRequests().length + acceptedNoCover().length, u = pendingUsers().length, k = S.claims.filter(claimNeedsAction).length;
    const set = (key, v) => { const b = root && root.querySelector(`[data-abadge="${key}"]`); if(b){ b.hidden = !v; b.textContent = v; } };
    set('requests', n); set('customers', u); set('claims', k);
    const ib = document.getElementById('adminBadge'); if(ib){ ib.hidden = !(n + u + k); ib.textContent = n + u + k; }
  }
  A.paintBadges = paintBadges;

  function render(){
    const body = $('#admBody', root); body.innerHTML = '';
    ({ requests: renderRequests, claims: renderClaimsAdmin, overview: renderOverview, ledger: renderLedger, customers: renderCustomers, rates: renderRates, clauses: renderClauses, insurers: renderInsurers, feedback: renderFeedback, settings: renderSettings })[tab](body);
  }
  const chip = (cls, t) => `<span class="chip ${esc(cls)}">${esc(t)}</span>`;
  const btn = (label, kind, fn) => { const b = FC.el(`<button type="button" class="btn btn-${kind} btn-sm"><span class="spin"></span>${esc(label)}</button>`); b.addEventListener('click', e => fn(b, e)); return b; };
  const addrOf = p => [p.address_line, [p.postcode, p.city].filter(Boolean).join(' '), p.country].filter(Boolean).join(', ');
  A.addrOf = addrOf;
  const who = r => { const p = S.profiles[r.user_id] || {}; return { name: p.full_name || p.email || '—', company: r.company || p.company || '', email: p.email || '', p }; };
  // open covers: office → policy → group
  const ofcOf = id => S.offices.find(o => o.id === id) || null;
  const polOf = id => S.policies.find(o => o.id === id) || null;
  const grpOf = id => S.groups.find(o => o.id === id) || null;
  const domainGroup = email => { const d = String(email || '').split('@')[1]; return d ? S.groups.slice().sort((a, b) => a.sort - b.sort || a.id - b.id).find(g => (g.email_domains || []).includes(d.toLowerCase())) || null : null; };
  const userGroup = p => { const o = ofcOf(p.office_id), po = o && polOf(o.policy_id); return (po && grpOf(po.group_id)) || grpOf(p.group_id) || domainGroup(p.email); };
  const orgOfCase = r => { const o = ofcOf(r.office_id), po = polOf(r.policy_id) || (o && polOf(o.policy_id)); return { office:o, policy:po, group: po ? grpOf(po.group_id) : null }; };
  const amt = (v, c) => v == null || v === '' ? '—' : money2(v, c);
  const effMin = (po, o, p) => p && p.min_premium_override != null ? Number(p.min_premium_override) : o && o.min_premium != null ? Number(o.min_premium) : po ? Number(po.min_premium) : null;
  const effDed = (po, o, p) => p && p.deductible_override != null ? Number(p.deductible_override) : o && o.deductible != null ? Number(o.deductible) : po && po.deductible != null ? Number(po.deductible) : null;
  A.org = { ofcOf, polOf, grpOf, userGroup };
  const AL_ORDER = { red:0, orange:1, amber:2, yellow:3 };
  const alertDots = r => { const c = {}; (r.alerts || []).forEach(a => c[a.level] = (c[a.level] || 0) + 1); return Object.keys(c).sort((a, b) => AL_ORDER[a] - AL_ORDER[b]).map(l => `<span class="al-dot al-${l}" title="${esc((r.alerts || []).filter(a => a.level === l).map(a => a.text).join('\n'))}">${c[l]}</span>`).join(''); };
  const alertList = r => (r.alerts || []).slice().sort((a, b) => AL_ORDER[a.level] - AL_ORDER[b.level]).map(a => `<div class="al-row al-${esc(a.level)}"><i></i>${esc(a.text)}</div>`).join('');

  // =================================================================== REQUESTS
  let rqFilter = { q:'', scope:'open', stage:'' };
  const selected = new Set();
  const liveQuotes = r => (S.quotes[r.id] || []).filter(q => q.status !== 'superseded');
  const quoteExpired = r => { const l = liveQuotes(r).pop(); return r.stage === 'quoted' && l && l.status === 'open' && new Date(l.valid_until) < Date.now(); };
  // Case outcome: open (requested, still in play), won (accepted / bound), lost (declined, lost, quote expired)
  function bucket(r){
    if(['accepted','bound'].includes(r.stage)) return 'won';
    if(r.stage === 'closed') return (S.coverNotes[r.id] || []).length ? 'won' : 'lost';
    if(['declined','lost'].includes(r.stage) || quoteExpired(r)) return 'lost';
    return r.quote_requested_at ? 'open' : 'calc';
  }
  A.bucket = bucket;
  const wonQuote = r => liveQuotes(r).filter(q => q.status === 'accepted').pop() || liveQuotes(r).pop();
  const brokerageOf = r => { const q = wonQuote(r), x = q && S.qint[q.id]; return x ? { amount: Number(x.brokerage_amount) || 0, pct: Number(x.brokerage_pct) || 0, insurer: x.insurer_name, currency: x.currency || r.currency } : null; };
  function renderRequests(body){
    const open = openRequests(), acc = acceptedNoCover(), real = S.rows.filter(r => !r.is_test);
    const n = k => real.filter(r => bucket(r) === k).length;
    const brk = {}; real.filter(r => bucket(r) === 'won').forEach(r => { const b = brokerageOf(r); if(b) brk[b.currency] = (brk[b.currency] || 0) + b.amount; });
    const brkTxt = Object.keys(brk).length ? Object.entries(brk).map(([c, v]) => money2(v, c)).join(' · ') : '—';
    const scopeBtn = (k, label, cnt, cls) => `<button type="button" class="stat stat-btn${cls ? ' ' + cls : ''}" data-scope="${k}" aria-pressed="${rqFilter.scope === k}"><b>${cnt}</b><span>${label}</span></button>`;
    body.appendChild(FC.el(`<div class="stats">
      ${scopeBtn('open', 'To do: quote or issue cover', open.length + acc.length, open.length + acc.length ? 'alert' : '')}
      ${scopeBtn('b_open', 'Open cases', n('open'))}
      ${scopeBtn('b_won', 'Won cases', n('won'), 'won')}
      ${scopeBtn('b_lost', 'Lost cases', n('lost'))}
      <div class="stat"><b class="num" style="font-size:20px">${esc(brkTxt)}</b><span>Brokerage on won cases (internal)</span></div></div>`));
    body.querySelectorAll('.stat-btn b').forEach(b => FC.countUp(b, Number(b.textContent), null, 500));
    const tb = FC.el(`<div class="toolbar">
      <input class="input" type="search" id="rqQ" placeholder="Search reference, customer, goods, country" value="${esc(rqFilter.q)}" aria-label="Search">
      <select class="input" id="rqScope" aria-label="Show">
        <option value="open">To do</option><option value="b_open">Open cases</option><option value="b_won">Won cases</option><option value="b_lost">Lost cases</option><option value="requests">All requests</option><option value="all">All indications</option></select>
      <select class="input" id="rqStage" aria-label="Stage"><option value="">Every stage</option>${Object.entries(FC.STAGE).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
      <button class="btn btn-danger btn-sm" id="rqDel" type="button" hidden><span class="spin"></span>Delete selected</button>
      <button class="btn btn-ghost btn-sm" id="rqCsv" type="button">Export CSV</button></div>`);
    body.appendChild(tb);
    $('#rqScope', tb).value = rqFilter.scope; $('#rqStage', tb).value = rqFilter.stage;
    const wrap = FC.el('<div class="tbl-wrap"></div>'); body.appendChild(wrap);
    const delBtn = $('#rqDel', tb);
    const paintSel = () => { delBtn.hidden = !selected.size; delBtn.lastChild.textContent = 'Delete selected (' + selected.size + ')'; };
    const paint = () => {
      const rows = filteredRequests();
      const ids = new Set(rows.map(r => r.id)); Array.from(selected).forEach(id => { if(!ids.has(id)) selected.delete(id); }); paintSel();
      body.querySelectorAll('[data-scope]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.scope === rqFilter.scope)));
      if(!rows.length){ wrap.innerHTML = `<div class="empty"><h3>${rqFilter.scope === 'open' ? 'Nothing to do' : 'No matches'}</h3><p>${rqFilter.scope === 'open' ? 'New requests and accepted quotations appear here.' : 'Change the search or filters.'}</p></div>`; return; }
      const showBrk = rqFilter.scope === 'b_won';
      wrap.innerHTML = `<table class="tbl"><thead><tr><th style="width:28px"><input type="checkbox" id="rqAll" aria-label="Select all" style="width:auto;min-width:0"></th><th>Reference</th><th>Received</th><th>Customer</th><th>Route</th><th>Goods</th><th class="r">Sum insured</th><th>${showBrk ? 'Premium / brokerage' : 'Indication'}</th><th>Stage</th><th>Owner</th></tr></thead><tbody></tbody></table>`;
      const tbody = wrap.querySelector('tbody');
      rows.slice(0, 400).forEach(r => {
        const w = who(r), bk = bucket(r);
        const stageChip = quoteExpired(r) ? chip('expired', 'Quote expired') : chip(r.stage === 'new' ? 'pending' : r.stage, FC.STAGE[r.stage]);
        const wq = wonQuote(r), b = brokerageOf(r);
        const third = showBrk ? `${wq ? '<span class="num">' + esc(money2(wq.data.total, wq.data.currency)) + '</span>' : '—'}${b ? '<br><span class="xs num muted">' + esc(money2(b.amount, b.currency)) + ' (' + esc(b.pct) + ' %)' + (b.insurer ? ', ' + esc(b.insurer) : '') + '</span>' : ''}`
          : `${chip(r.status, FC.STATUS[r.status])}${r.premium != null ? '<br><span class="xs num">' + esc(money2(r.premium, r.currency)) + '</span>' : ''}`;
        const tr = FC.el(`<tr class="click" tabindex="0">
          <td data-nosel><input type="checkbox" class="rqSel" aria-label="Select" ${selected.has(r.id) ? 'checked' : ''} style="width:auto;min-width:0"></td>
          <td><b>${esc(r.ref || '—')}</b>${(r.alerts || []).length ? ' <span class="al-dots">' + alertDots(r) + '</span>' : ''}${r.is_test ? ' ' + chip('neutral', 'Test') : ''}${bk === 'won' ? ' ' + chip('accepted', 'Won') : bk === 'lost' ? ' ' + chip('declined', 'Lost') : ''}</td>
          <td class="xs">${esc(FC.ago(r.quote_requested_at || r.created_at))}${r.quote_requested_at ? '' : '<br><span class="muted">no request</span>'}</td>
          <td>${esc(w.company)}${r.policy_id ? ' ' + chip('neutral', 'Open cover') : ''}${r.intake ? ' ' + chip('pending', 'Intake') : ''}<br><span class="xs muted">${esc(r.insured_name ? 'for ' + r.insured_name : w.name)}</span></td>
          <td><b>${esc(r.origin_country)} → ${esc(r.dest_country)}</b><br><span class="xs muted">${esc((FC.CONVEYANCE[r.conveyance] || {}).short)}</span></td>
          <td>${esc(r.goods_description.slice(0, 60))}</td>
          <td class="r num">${esc(money2(r.sum_insured, r.currency))}</td>
          <td>${third}</td>
          <td>${stageChip}</td><td>${esc(r.owner || '')}</td></tr>`);
        const cb = tr.querySelector('.rqSel');
        cb.addEventListener('click', e => e.stopPropagation());
        cb.addEventListener('change', () => { cb.checked ? selected.add(r.id) : selected.delete(r.id); paintSel(); });
        tr.querySelector('[data-nosel]').addEventListener('click', e => { if(e.target === e.currentTarget){ e.stopPropagation(); cb.click(); } });
        tr.addEventListener('click', () => openCase(r.id));
        tr.addEventListener('keydown', e => { if(e.key === 'Enter' && e.target === tr) openCase(r.id); });
        tbody.appendChild(tr);
      });
      const all = $('#rqAll', wrap);
      all.checked = rows.slice(0, 400).every(r => selected.has(r.id));
      all.addEventListener('change', () => { rows.slice(0, 400).forEach(r => all.checked ? selected.add(r.id) : selected.delete(r.id)); paint(); });
    };
    body.querySelectorAll('[data-scope]').forEach(b => b.addEventListener('click', () => { rqFilter.scope = b.dataset.scope; $('#rqScope', tb).value = rqFilter.scope; paint(); }));
    $('#rqQ', tb).addEventListener('input', e => { rqFilter.q = e.target.value; paint(); });
    $('#rqScope', tb).addEventListener('change', e => { rqFilter.scope = e.target.value; paint(); });
    $('#rqStage', tb).addEventListener('change', e => { rqFilter.stage = e.target.value; paint(); });
    $('#rqCsv', tb).addEventListener('click', () => exportCsv(filteredRequests()));
    delBtn.addEventListener('click', async () => {
      const ids = Array.from(selected); if(!ids.length) return;
      if(!(await FC.confirm('Delete ' + ids.length + ' case' + (ids.length > 1 ? 's' : '') + '?', 'Indications, quotations, cover notes, notes and invoice files are deleted for good. The clients no longer see them either.', 'Delete for good', 'danger'))) return;
      busy(delBtn, true);
      const ok = await deleteCases(ids);
      busy(delBtn, false);
      if(ok){ selected.clear(); await loadAll(); render(); toast(ids.length + ' deleted.'); }
    });
    paint();
  }
  async function deleteCases(ids){
    const { data: invs } = await sb.from('invoices').select('id,file_path').in('indication_id', ids);
    const files = (invs || []).map(i => i.file_path).filter(Boolean);
    if(files.length) await sb.storage.from('invoices').remove(files);
    if((invs || []).length){ const { error } = await sb.from('invoices').delete().in('id', invs.map(i => i.id)); if(error){ toast('Could not delete invoices: ' + error.message, 'error'); return false; } }
    const { error } = await sb.from('indications').delete().in('id', ids);
    if(error){ toast('Could not delete: ' + error.message, 'error'); return false; }
    return true;
  }
  function filteredRequests(){
    const s = rqFilter.q.trim().toLowerCase();
    const openIds = new Set(openRequests().concat(acceptedNoCover()).map(r => r.id));
    return S.rows.filter(r => {
      if(rqFilter.scope === 'open' && !openIds.has(r.id)) return false;
      if(rqFilter.scope.startsWith('b_') && bucket(r) !== rqFilter.scope.slice(2)) return false;
      if(rqFilter.scope === 'requests' && !r.quote_requested_at) return false;
      if(rqFilter.stage && r.stage !== rqFilter.stage) return false;
      if(!s) return true;
      const w = who(r);
      return [r.ref, r.customer_ref, r.insured_name, w.company, w.name, w.email, r.goods_description, r.origin_country, r.dest_country, cName(r.origin_country), cName(r.dest_country), r.origin_place, r.dest_place].join(' ').toLowerCase().includes(s);
    }).sort((a, b) => new Date(b.quote_requested_at || b.created_at) - new Date(a.quote_requested_at || a.created_at));
  }
  function exportCsv(rows){
    const cell = v => { const s = String(v == null ? '' : v); return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const head = ['Reference','Client ref','Created','Requested','Company','Name','E-mail','Assured (end customer)','Goods','Commodity','Conveyance','Vessel','Incoterm','Insured party','From','From place','To','To place','Departure','Invoice value','Currency','Sum insured','Cover','War/strikes','Status','Rate %','Premium','Stage','Owner'];
    const lines = [head].concat(rows.map(r => { const w = who(r); return [r.ref, r.customer_ref, r.created_at, r.quote_requested_at, w.company, w.name, w.email, r.insured_name, r.goods_description, r.commodity_id, r.conveyance, r.vessel, r.incoterm, r.insured_party, r.origin_country, r.origin_place, r.dest_country, r.dest_place, r.departure_date, r.invoice_value, r.currency, r.sum_insured, r.cover, r.war_strikes, r.status, r.rate_pct, r.premium, r.stage, r.owner]; }));
    FC.saveBlob('﻿' + lines.map(l => l.map(cell).join(';')).join('\n'), 'FREIGHTCON_requests_' + FC.today() + '.csv', 'text/csv;charset=utf-8');
  }

  // ---------------- case drawer ----------------
  async function openCase(id){
    const r = S.rows.find(x => x.id === id); if(!r) return;
    const w = who(r);
    const back = FC.el('<div class="drawer-back"></div>');
    const dr = FC.el(`<aside class="drawer" role="dialog" aria-modal="true" aria-label="Request ${esc(r.ref || r.id)}">
      <div class="dlg-head"><div><h2>${esc(r.ref || 'Indication #' + r.id)}</h2><div class="xs muted">${esc(w.company)}, ${esc(w.name)}</div></div><button class="x" type="button" aria-label="Close" style="background:none;border:0;font-size:26px;cursor:pointer;color:var(--steel)">&times;</button></div>
      <div class="drawer-body"></div></aside>`);
    const close = () => { back.remove(); dr.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = e => { if(e.key === 'Escape' && !document.querySelector('.dlg-back')) close(); };
    back.addEventListener('click', close); dr.querySelector('.x').addEventListener('click', close); document.addEventListener('keydown', onKey);
    document.body.appendChild(back); document.body.appendChild(dr);
    const body = dr.querySelector('.drawer-body');
    const refresh = async () => { await loadAll(); const nr = S.rows.find(x => x.id === id); if(nr) Object.assign(r, nr); paintCase(); if(tab === 'requests') render(); };
    const paintCase = async () => {
      const qs = S.quotes[r.id] || [], cns = S.coverNotes[r.id] || [];
      const conv = FC.CONVEYANCE[r.conveyance] || {};
      body.innerHTML = `
        <section><h3>Shipment</h3><dl class="kv">
          <dt>Indication</dt><dd>${chip(r.status, FC.STATUS[r.status])} ${r.premium != null ? esc(money2(r.premium, r.currency)) + ' at ' + esc(FC.pct(r.rate_pct)) + (Number(r.discount_pct) ? ', discount ' + esc(Number(r.discount_pct)) + ' %' : '') + (r.min_applied ? ', minimum' : '') : ''}</dd>
          ${r.calc_detail ? `<dt>Tariff</dt><dd>${esc(explain(r.calc_detail))}${r.on_deck ? ', on deck' : ''}${r.interest_only ? ', interest only' : ''}${r.ext_hssc ? ', HSSC' : ''}${r.ext_liw ? ', LiW/DiW' : ''}</dd>` : ''}
          ${(r.reasons || []).length ? `<dt>Reasons</dt><dd>${esc(r.reasons.join('; '))}</dd>` : ''}
          ${(r.alerts || []).length ? `<dt>Alerts</dt><dd>${alertList(r)}</dd>` : ''}
          ${r.war && (r.war.areas || []).length ? `<dt>War &amp; strikes</dt><dd>Excluded: <b>${esc(r.war.areas.map(a => a.name).join(', '))}</b> (rate not reduced)<br><span class="xs">${r.war.areas.map(a => esc(a.name) + ': ' + (a.buyback_permille != null ? 'buy-back ' + pm(a.buyback_permille) + ' ‰' + (Number(a.ncb_pct) ? ' less ' + esc(Number(a.ncb_pct)) + ' % NCB = ' + pm(a.net_permille) + ' ‰ net' : '') : 'no buy-back terms')).join('<br>')}</span>${r.war.rate_pct_incl != null ? `<br><span class="small">Rate excluded <b>${esc(FC.pct(r.rate_pct))}</b> = ${esc(money2(r.premium, r.currency))} · re-included <b>${esc(FC.pct(r.war.rate_pct_incl))}</b> = ${esc(money2(r.war.premium_incl, r.currency))}</span>` : ''}</dd>` : ''}
          ${(r.notes || []).length ? `<dt>For the broker</dt><dd>${r.notes.map(n => '<span class="chip pending" style="white-space:normal;margin:0 4px 4px 0;display:inline-block">' + esc(n) + '</span>').join('')}</dd>` : ''}
          ${(() => { const og = orgOfCase(r); if(!og.policy) return ''; const p = (S.profiles[r.user_id] || {});
            return `<dt>Open cover</dt><dd><b>${esc(og.policy.name)}</b> ${esc(og.policy.policy_no || '')}${og.office ? '<br>' + esc(og.office.name) + (og.office.location ? ', ' + esc(og.office.location) : '') : ''}<br><span class="xs muted">Minimum premium ${esc(amt(effMin(og.policy, og.office, p), og.policy.currency))} · deductible ${esc(amt(effDed(og.policy, og.office, p), og.policy.currency))} · limit ${esc(amt(og.policy.limit_conveyance, og.policy.currency))} any one conveyance</span>${r.intake ? '<br>' + chip('pending', 'Intake: the client sees no premium') : ''}</dd>`; })()}
          ${r.insured_name ? `<dt>Assured</dt><dd><b>${esc(r.insured_name)}</b>${r.insured_address ? '<br><span class="xs muted">' + esc(r.insured_address) + '</span>' : ''}<br><span class="xs muted">on behalf of the customer below (policyholder)</span></dd>` : ''}
          ${r.customer_ref ? `<dt>Client's reference</dt><dd>${esc(r.customer_ref)}</dd>` : ''}
          ${r.source === 'upload' ? `<dt>Source</dt><dd>${chip('neutral', 'Excel / CSV upload')}</dd>` : ''}
          <dt>Goods</dt><dd>${esc(r.goods_description)}</dd>
          <dt>Cargo type</dt><dd>${esc((S.commodities.find(c => c.id === r.commodity_id) || {}).name || r.commodity_id)}</dd>
          <dt>Packaging</dt><dd>${esc(r.packaging || '—')}</dd>
          <dt>Route</dt><dd>${esc([r.origin_place, cName(r.origin_country)].filter(Boolean).join(', '))} → ${esc([r.dest_place, cName(r.dest_country)].filter(Boolean).join(', '))}</dd>
          <dt>Conveyance</dt><dd>${esc(conv.label || r.conveyance)}${r.departure_date ? ', departs ' + esc(FC.date(r.departure_date)) : ''}</dd>
          ${/^sea_/.test(r.conveyance) ? `<dt>Vessel</dt><dd>${esc(r.vessel || 'Not stated — ask the client')} <span class="xs muted">check age, class (IACS), flag, sanctions</span></dd>` : ''}
          ${r.incoterm ? `<dt>Incoterm</dt><dd>${esc(r.incoterm)} (${esc((FC.INCOTERMS[r.incoterm] || {}).name || '')}), client is the ${esc(r.insured_party || 'seller')}${FC.noRisk(r.incoterm, r.insured_party) ? ' <span class="chip pending">client carries no transit risk</span>' : ''}</dd>` : ''}
          <dt>Values</dt><dd>Invoice ${esc(money2(r.invoice_value, r.currency))}${Number(r.freight_value) > 0 ? ' + freight ' + esc(money2(r.freight_value, r.currency)) : ''} + ${esc(Number(r.uplift_pct))} % = ${esc(money2(r.sum_insured, r.currency))}${r.rate_pct != null && Number(r.rate_pct) < 100 ? `<br><span class="xs muted">CIF gross-up: ${esc(money2(Number(r.invoice_value) + Number(r.freight_value || 0), r.currency))} / (1 − ${esc(FC.pct(r.rate_pct))}) = ${esc(money2((Number(r.invoice_value) + Number(r.freight_value || 0)) / (1 - Number(r.rate_pct) / 100), r.currency))} · × 110 % = ${esc(money2((Number(r.invoice_value) + Number(r.freight_value || 0)) / (1 - Number(r.rate_pct) / 100) * 1.1, r.currency))}</span>` : ''}</dd>
          ${(r.transit_countries || []).length ? `<dt>Via</dt><dd>${esc(r.transit_countries.map(cName).join(', '))}</dd>` : ''}
          ${/^sea_/.test(r.conveyance) ? `<dt>Routing</dt><dd>${esc({ auto:'Suez / Red Sea not stated', yes:'Via Suez / Red Sea', no:'Not via Suez (e.g. the Cape)' }[r.red_sea || 'auto'])}</dd>` : ''}
          ${r.insured_country ? `<dt>Assured domicile</dt><dd>${esc(cName(r.insured_country))}${r.insured_country === 'AE' ? ' · FTZ: ' + (r.ftz == null ? 'not known' : r.ftz ? 'yes' : 'no, mainland') : ''}</dd>` : ''}
          ${Object.keys(r.details || {}).length ? `<dt>Details</dt><dd class="small">${[['equipment','Equipment'],['pieces','Pieces'],['weight_kg','Gross weight kg'],['dimensions','Dimensions'],['hs_code','HS code'],['vessel_year','Vessel built'],['storage','Storage']].filter(([k]) => r.details[k]).map(([k, l]) => esc(l) + ': <b>' + esc(k === 'storage' ? (r.details[k] === '30' ? '30–60 days' : 'over 60 days') : r.details[k]) + '</b>').join(' · ')}${r.details.parties ? '<br>Co-assureds / loss payees: ' + esc(r.details.parties).replace(/\n/g, '; ') : ''}</dd>` : ''}
          <dt>Cover</dt><dd>${esc((FC.COVER[r.cover] || {}).clause)}, war &amp; strikes ${r.war_strikes ? 'included' : 'not included'}</dd>
          ${r.customer_comment ? `<dt>Customer message</dt><dd>${esc(r.customer_comment)}</dd>` : ''}
        </dl></section>
        <section><h3>Customer</h3><dl class="kv">
          <dt>Company</dt><dd>${esc(w.company)}${addrOf(w.p) ? '<br><span class="xs muted">' + esc(addrOf(w.p)) + '</span>' : ''}</dd><dt>Contact</dt><dd>${esc(w.name)}, <a href="mailto:${esc(w.email)}">${esc(w.email)}</a>${w.p.phone ? ', ' + esc(w.p.phone) : ''}</dd>
          <dt>Client discount</dt><dd>${esc(Number(w.p.client_discount_pct || 0))} %</dd>
          ${w.p.internal_note ? `<dt>Internal note</dt><dd>${esc(w.p.internal_note)}</dd>` : ''}</dl></section>
        <section><h3>Handling</h3>
          <div class="grid3">
            <div class="field"><label for="csStage">Stage</label><select id="csStage">${Object.entries(FC.STAGE).map(([k, v]) => `<option value="${k}" ${k === r.stage ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
            <div class="field"><label for="csOwner">Owner</label><input id="csOwner" maxlength="20" value="${esc(r.owner || '')}" placeholder="${esc(myInitials())}"></div>
            <div class="field"><label for="csFollow">Follow up</label><input id="csFollow" type="date" value="${esc(r.follow_up || '')}"></div>
          </div>
          <label class="switch"><input type="checkbox" id="csTest" ${r.is_test ? 'checked' : ''}><span><b>Test case</b><span>Left out of statistics.</span></span></label>
          <div style="margin-top:12px" id="csSaveHost"></div></section>
        <section><h3>Quotations</h3><div id="csQuotes" class="list"></div><div class="toolbar" style="margin-top:10px" id="csQuoteActs"></div></section>
        <section><h3>Cover notes</h3><div id="csCovers" class="list"></div><div class="toolbar" style="margin-top:10px" id="csCoverActs"></div></section>
        <section><h3>Invoices</h3><div id="csInv" class="list"></div><div class="toolbar" style="margin-top:10px" id="csInvActs"></div></section>
        <section><h3>Notes</h3><div id="csNotes"></div>
          <div class="field" style="margin-top:8px"><label for="csNote">Add a note</label><textarea id="csNote" maxlength="2000" rows="2"></textarea></div><div id="csNoteHost" style="margin-top:8px"></div></section>
        <section><h3>Timeline</h3><ul class="timeline" id="csTl"></ul></section>
        <section><div class="toolbar" id="csMore"></div></section>`;
      // handling
      $('#csSaveHost', body).appendChild(btn('Save handling', 'primary', async b => {
        busy(b, true);
        const patch = { stage: $('#csStage', body).value, owner: $('#csOwner', body).value.trim() || null, follow_up: $('#csFollow', body).value || null, is_test: $('#csTest', body).checked };
        const { error } = await sb.from('indications').update(patch).eq('id', r.id);
        busy(b, false);
        if(error){ toast('Could not save: ' + error.message, 'error'); return; }
        toast('Saved.'); refresh();
      }));
      // quotations
      const qh = $('#csQuotes', body);
      if(!qs.length) qh.innerHTML = '<p class="small muted" style="margin:0">No quotation yet.</p>';
      qs.slice().reverse().forEach(q => {
        const st = q.status === 'open' && new Date(q.valid_until) < Date.now() ? 'expired' : q.status;
        const it = FC.el(`<div class="item"><div><div class="t">Version ${q.version} ${chip(st, st)}</div>
          <div class="meta">${esc(money2(q.data.total, q.data.currency))}${Number(q.data.taxPct) > 0 ? ' incl. ' + esc(Number(q.data.taxPct)) + ' % tax' : ''}${q.data.insurer ? ', ' + esc(q.data.insurer) : ''}${S.qint[q.id] ? ' <span class="chip neutral">brokerage ' + esc(Number(S.qint[q.id].brokerage_pct)) + ' % = ' + esc(money2(S.qint[q.id].brokerage_amount, q.data.currency)) + '</span>' : ''}<br>sent ${esc(FC.dateTime(q.created_at))}, valid until ${esc(FC.dateTime(q.valid_until))}${q.responded_at ? ', answered ' + esc(FC.dateTime(q.responded_at)) : ''}${q.response_note ? '<br>Client: ' + esc(q.response_note) : ''}</div></div><div class="acts"></div></div>`);
        const a = it.querySelector('.acts');
        a.appendChild(btn('PDF', 'ghost', async b => { busy(b, true); try{ FC.saveBlob(await FCPDF.quotation(q, r), FCPDF.fileName('FREIGHTCON_Quotation', r.ref, 'v' + q.version)); }catch(e){ console.error(e); toast('PDF failed.', 'error'); } busy(b, false); }));
        if(q.status === 'open') a.appendChild(btn('Withdraw', 'danger', async b => {
          if(!(await FC.confirm('Withdraw this quotation?', 'The client can no longer accept it.', 'Withdraw', 'danger'))) return;
          const { error } = await sb.rpc('admin_withdraw_quotation', { p_quotation_id: q.id }); if(error){ toast(error.message, 'error'); return; } refresh();
        }));
        if(st !== 'superseded') a.appendChild(btn('New version from this', 'ghost', () => quotationEditor(r, q.data, q.id).then(ok => ok && refresh())));
        qh.appendChild(it);
      });
      $('#csQuoteActs', body).appendChild(btn(qs.length ? 'New quotation' : 'Create quotation', qs.length ? 'ghost' : 'primary', () => quotationEditor(r).then(ok => ok && refresh())));
      $('#csQuoteActs', body).appendChild(btn('Indication PDF', 'ghost', async b => { busy(b, true); try{ FC.saveBlob(await FCPDF.indication(Object.assign({}, r, { origin_name:cName(r.origin_country), dest_name:cName(r.dest_country), commodity_name:(S.commodities.find(c => c.id === r.commodity_id) || {}).name, deductible_text: setting('deductible_text', '') })), FCPDF.fileName('FREIGHTCON_Indication', r.ref || r.id)); }catch(e){ console.error(e); toast('PDF failed.', 'error'); } busy(b, false); }));
      $('#csQuoteActs', body).appendChild(btn('Text for insurer', 'ghost', () => insurerText(r)));
      // cover notes
      const ch = $('#csCovers', body);
      if(!cns.length) ch.innerHTML = '<p class="small muted" style="margin:0">No cover note yet.</p>';
      cns.forEach(cn => {
        const it = FC.el(`<div class="item"><div><div class="t">${esc(cn.number)}</div><div class="meta">Issued ${esc(FC.dateTime(cn.issued_at))}</div></div><div class="acts"></div></div>`);
        it.querySelector('.acts').appendChild(btn('PDF', 'ghost', async b => { busy(b, true); try{ FC.saveBlob(await FCPDF.coverNote(cn, r), FCPDF.fileName('FREIGHTCON_CoverNote', cn.number)); }catch(e){ console.error(e); toast('PDF failed.', 'error'); } busy(b, false); }));
        ch.appendChild(it);
      });
      const accepted = qs.filter(q => q.status === 'accepted').pop();
      $('#csCoverActs', body).appendChild(btn('Issue cover note', accepted ? 'primary' : 'ghost', () => coverNoteEditor(r, accepted || qs.filter(q => q.status !== 'superseded').pop()).then(ok => ok && refresh())));
      // invoices
      const { data: invs } = await sb.from('invoices').select('*').eq('indication_id', r.id).order('created_at');
      const ih = $('#csInv', body);
      if(!(invs || []).length) ih.innerHTML = '<p class="small muted" style="margin:0">No invoice yet.</p>';
      (invs || []).forEach(inv => {
        const it = FC.el(`<div class="item"><div><div class="t">${esc(inv.number)} ${chip(inv.paid_at ? 'paid' : 'pending', inv.paid_at ? 'Paid' : 'Open')}</div><div class="meta">${esc(money2(inv.amount, inv.currency))}${inv.due_date ? ', due ' + esc(FC.date(inv.due_date)) : ''}</div></div><div class="acts"></div></div>`);
        const a = it.querySelector('.acts');
        if(inv.file_path) a.appendChild(btn('Open', 'ghost', async () => { const { data, error } = await sb.storage.from('invoices').createSignedUrl(inv.file_path, 60); if(error) return toast('Could not open the file.', 'error'); window.open(data.signedUrl, '_blank', 'noopener'); }));
        a.appendChild(btn(inv.paid_at ? 'Mark unpaid' : 'Mark paid', 'ghost', async () => { const { error } = await sb.from('invoices').update({ paid_at: inv.paid_at ? null : new Date().toISOString() }).eq('id', inv.id); if(error) return toast(error.message, 'error'); paintCase(); }));
        a.appendChild(btn('Delete', 'danger', async () => {
          if(!(await FC.confirm('Delete this invoice?', 'The record and its file are removed for the client too.', 'Delete', 'danger'))) return;
          if(inv.file_path) await sb.storage.from('invoices').remove([inv.file_path]);
          const { error } = await sb.from('invoices').delete().eq('id', inv.id); if(error) return toast(error.message, 'error'); paintCase();
        }));
        ih.appendChild(it);
      });
      $('#csInvActs', body).appendChild(btn('Upload invoice', 'ghost', () => invoiceUpload(r).then(ok => ok && paintCase())));
      // notes
      const { data: notes } = await sb.from('case_notes').select('*').eq('indication_id', r.id).order('created_at');
      $('#csNotes', body).innerHTML = (notes || []).length ? (notes || []).map(n => `<div class="notice info" style="margin:0 0 8px"><b>${esc(n.author)}, ${esc(FC.dateTime(n.created_at))}</b>${esc(n.body)}</div>`).join('') : '<p class="small muted" style="margin:0">No notes.</p>';
      $('#csNoteHost', body).appendChild(btn('Add note', 'ghost', async b => {
        const t = $('#csNote', body).value.trim(); if(!t) return;
        busy(b, true); const { error } = await sb.from('case_notes').insert({ indication_id: r.id, author: myInitials(), body: t }); busy(b, false);
        if(error) return toast(error.message, 'error'); paintCase();
      }));
      // timeline
      const ev = [[r.created_at, 'Indication calculated']];
      if(r.pdf_downloaded_at) ev.push([r.pdf_downloaded_at, 'PDF downloaded by the client']);
      if(r.quote_requested_at) ev.push([r.quote_requested_at, 'Quotation requested']);
      qs.forEach(q => { ev.push([q.created_at, 'Quotation version ' + q.version + ' sent']); if(q.responded_at) ev.push([q.responded_at, 'Client ' + q.status + ' version ' + q.version]); });
      cns.forEach(c => ev.push([c.issued_at, 'Cover note ' + c.number + ' issued']));
      (notes || []).forEach(n => ev.push([n.created_at, 'Note by ' + n.author]));
      ev.sort((a, b) => new Date(a[0]) - new Date(b[0]));
      $('#csTl', body).innerHTML = ev.map(([t, l]) => `<li>${esc(l)}<span>${esc(FC.dateTime(t))}</span></li>`).join('');
      // danger zone
      $('#csMore', body).appendChild(btn('Delete case', 'danger', async () => {
        if(!(await FC.confirm('Delete this case?', 'The indication, its quotations, cover notes, notes and invoices are deleted for good. Prefer the stage "Lost" or "Closed" if you need the record.', 'Delete for good', 'danger'))) return;
        if(!(await deleteCases([r.id]))) return;
        close(); await loadAll(); render(); toast('Deleted.');
      }));
    };
    paintCase();
  }

  // ---------------- rating helper: split cargo / war parts for the editor ----------------
  function splitRate(r){
    const land = r.conveyance === 'road' || r.conveyance === 'rail';
    return { cargo: r.rate_pct != null ? Number(r.rate_pct) : null, land, detail: r.calc_detail || null };
  }
  function calcQuote(lines, discPct, minPrem, taxPct){
    const sub = lines.reduce((s, l) => s + l.premium, 0);
    const discountAmount = Math.round(sub * (discPct || 0)) / 100;
    let net = Math.round((sub - discountAmount) * 100) / 100, minApplied = false;
    if(minPrem > 0 && net < minPrem){ net = minPrem; minApplied = true; }
    const tax = Math.round(net * (taxPct || 0)) / 100;
    return { subtotal: Math.round(sub * 100) / 100, discountAmount, net, minApplied, tax, total: Math.round((net + tax) * 100) / 100 };
  }

  // ---------------- quotation editor ----------------
  function quotationEditor(r, prev, prevId){
    const w = who(r), sp = splitRate(r), land = sp.land, prevInt = prevId ? S.qint[prevId] : null;
    const og = orgOfCase(r), pp = S.profiles[r.user_id] || {};
    const ocDed = og.policy ? effDed(og.policy, og.office, pp) : null, ocMin = og.policy ? (sp.detail && sp.detail.min_premium != null ? Number(sp.detail.min_premium) : effMin(og.policy, og.office, pp)) : null;
    const conds = (FC.COVER[r.cover] || {}).clause + (r.war_strikes ? (land ? ', Institute Strikes Clauses (Cargo)' : ', Institute War Clauses (Cargo), Institute Strikes Clauses (Cargo)') : '') + ', warehouse to warehouse';
    const d = Object.assign({
      client: r.insured_name || w.company, clientAddress: r.insured_name ? (r.insured_address || '') : addrOf(w.p), policyholder: og.policy && og.policy.policyholder ? og.policy.policyholder : r.insured_name ? [w.company, addrOf(w.p)].filter(Boolean).join(', ') : '', policyNo: og.policy ? og.policy.policy_no || '' : '', customerRef: r.customer_ref || '', coAssured: String((r.details || {}).parties || '').split('\n').map(x => x.trim()).filter(Boolean).slice(0, 6), goods: r.goods_description, packaging: r.packaging || '', conveyance: r.conveyance, vessel: r.vessel || '', incoterm: r.incoterm ? r.incoterm + ' ' + (r.origin_place || r.dest_place || '') : '',
      originCountry: r.origin_country, originPlace: r.origin_place || '', destCountry: r.dest_country, destPlace: r.dest_place || '',
      voyage: [r.origin_place, cName(r.origin_country)].filter(Boolean).join(', ') + ' to ' + [r.dest_place, cName(r.dest_country)].filter(Boolean).join(', '),
      period: r.departure_date ? 'Transit commencing on or about ' + FC.date(r.departure_date) : 'Single transit as per voyage',
      conditions: conds, insurer: (og.policy && og.policy.placed_via) || setting('default_insurer', ''),
      deductible: ocDed != null ? money2(ocDed, og.policy.currency) + ' each and every loss' : ((S.commodities.find(c => c.id === r.commodity_id) || {}).deductible) || setting('deductible_text', ''), special: r.conditions || '',
      currency: r.currency, discountPct: Number(r.discount_pct || w.p.client_discount_pct || 0), taxPct: 0,
      minPremium: ocMin != null ? ocMin : Number(sp.detail && sp.detail.mode === 'land' ? setting('land_min_premium', 75) : (((S.rateTables.find(t => sp.detail && t.id === sp.detail.table) || {}).min_premium) || (setting('min_premium', {}) || {})[r.currency] || 0)),
      lines: [{ key:'cargo', label:'Cargo, ' + ((FC.COVER[r.cover] || {}).clause || '') + (r.interest_only ? ", seller's / buyer's interest only" : '') + (r.on_deck ? ', on deck' : '') + (r.ext_hssc ? ', incl. HSSC' : '') + (r.ext_liw ? ', incl. loss / difference in weight' : '') + (r.war_strikes ? (land ? ', incl. strikes' : ', incl. war & strikes') : ''), sum: Number(r.sum_insured), rate: sp.cargo }],
      subjectivities: setting('quote_subjectivities', []), note: '', closing: setting('quote_closing', '')
    }, prev ? JSON.parse(JSON.stringify(prev)) : {});
    const toLocal = dt => { const z = new Date(dt.getTime() - dt.getTimezoneOffset() * 60000); return z.toISOString().slice(0, 16); };
    const actIns = S.insurers.filter(i => i.active || (prevInt && prevInt.insurer_id === i.id));
    const preIns = (prevInt && actIns.find(i => i.id === prevInt.insurer_id)) || actIns.find(i => i.name === d.insurer) || actIns.find(i => i.name === setting('default_insurer', '')) || actIns[0] || null;
    const otherName = preIns ? '' : (d.insurer || '');
    const insOpts = actIns.map(i => `<option value="${i.id}" ${preIns && preIns.id === i.id ? 'selected' : ''}>${esc(i.name)}</option>`).join('') + `<option value="" ${preIns ? '' : 'selected'}>Other insurer (type name)</option>`;
    const preBrk = prevInt ? Number(prevInt.brokerage_pct) : preIns ? Number(preIns.brokerage_pct || 0) : 0;
    const taxDefault = Number(setting('insurance_tax_pct', 19));
    const taxOn = prev ? Number(d.taxPct) > 0 : (r.origin_country === 'DE' && r.dest_country === 'DE');
    const lineRow = (l, i) => `<tr data-i="${i}"><td><input class="ln-label" value="${esc(l.label)}" maxlength="120"></td><td><input class="ln-sum" inputmode="decimal" value="${l.sum != null ? esc(l.sum) : ''}"></td><td><input class="ln-rate" inputmode="decimal" value="${l.rate != null ? esc(l.rate) : ''}"></td><td class="r num ln-prem">—</td><td><button type="button" class="linkbtn ln-del" aria-label="Remove line">Remove</button></td></tr>`;
    const body = FC.el(`<div>
      <div class="grid2">
        <div class="field"><label>Assured</label><input id="qeClient" maxlength="150" value="${esc(d.client)}"></div>
        <div class="field"><label>Assured address</label><input id="qeAddr" maxlength="250" value="${esc(d.clientAddress || '')}"></div>
        <div class="field"><label>Policyholder (if not the assured, e.g. the forwarder)</label><input id="qePH" maxlength="300" value="${esc(d.policyholder || '')}"></div>
        <div class="field"><label>Client's reference</label><input id="qeCRef" maxlength="60" value="${esc(d.customerRef || '')}"></div>
        <div class="field"><label>Incoterm (as in the sales contract)</label><input id="qeInco" maxlength="60" value="${esc(d.incoterm || '')}"></div>
        <div class="field"><label>Co-assured (one per line)</label><textarea id="qeCo" rows="1">${esc((d.coAssured || []).join('\n'))}</textarea></div>
        <div class="field"><label>Goods</label><input id="qeGoods" maxlength="300" value="${esc(d.goods)}"></div>
        <div class="field"><label>Packaging</label><input id="qePack" maxlength="100" value="${esc(d.packaging)}"></div>
        <div class="field"><label>Conveyance</label><select id="qeConv">${Object.entries(FC.CONVEYANCE).map(([k, v]) => `<option value="${k}" ${k === d.conveyance ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select></div>
        <div class="field"><label>Vessel / flight / truck (optional)</label><input id="qeVessel" maxlength="120" value="${esc(d.vessel || '')}"></div>
        <div class="field"><label>From country (ISO) and place</label><div class="grid2" style="grid-template-columns:80px 1fr"><input id="qeOC" maxlength="2" value="${esc(d.originCountry)}"><input id="qeOP" maxlength="100" value="${esc(d.originPlace)}"></div></div>
        <div class="field"><label>To country (ISO) and place</label><div class="grid2" style="grid-template-columns:80px 1fr"><input id="qeDC" maxlength="2" value="${esc(d.destCountry)}"><input id="qeDP" maxlength="100" value="${esc(d.destPlace)}"></div></div>
      </div>
      <div class="field" style="margin-top:12px"><label>Voyage</label><input id="qeVoy" maxlength="300" value="${esc(d.voyage)}"></div>
      <div class="field"><label>Period</label><input id="qePer" maxlength="200" value="${esc(d.period)}"></div>
      <div class="field"><label>Conditions</label><textarea id="qeCond" rows="2" maxlength="800">${esc(d.conditions)}</textarea></div>
      <div class="grid2" style="margin-top:12px">
        <div class="field"><label for="qeInsSel">Insurer</label><select id="qeInsSel">${insOpts}</select><input id="qeIns" maxlength="200" value="${esc(otherName)}" placeholder="Name of the insurer" style="margin-top:6px" ${preIns ? 'hidden' : ''}></div>
        <div class="field"><label>Deductible</label><input id="qeDed" maxlength="200" value="${esc(d.deductible)}"></div>
      </div>
      <h3 style="margin:18px 0 6px">Premium</h3>
      <div class="grid3">
        <div class="field"><label>Currency</label><select id="qeCur"><option ${d.currency === 'EUR' ? 'selected' : ''}>EUR</option><option ${d.currency === 'USD' ? 'selected' : ''}>USD</option><option ${d.currency === 'GBP' ? 'selected' : ''}>GBP</option></select></div>
        <div class="field"><label>Client discount %</label><input id="qeDisc" inputmode="decimal" value="${esc(d.discountPct || 0)}"></div>
        <div class="field"><label>Minimum premium</label><input id="qeMin" inputmode="decimal" value="${esc(d.minPremium || 0)}"></div>
      </div>
      ${(() => { const W = d.warExcl || null, areas = W ? W.areas : ((r.war && r.war.areas) || []).map(a => a.name);
          if(!areas.length) return '';
          const all = W ? W.offerBuyback : ((r.war && r.war.areas) || []).every(a => a.net_permille != null);
          const bb = W ? W.buybackPct : ((r.war && r.war.areas) || []).reduce((t, a) => t + Number(a.net_permille || 0), 0) / 10;
          return `<div class="qe-war"><h4>War &amp; strikes excluded on this voyage</h4>
            <div class="grid2"><div class="field"><label for="qeWarAreas">Areas (one per line, shown to the client)</label><textarea id="qeWarAreas" rows="2">${esc(areas.join('\n'))}</textarea></div>
            <div class="field"><label for="qeBb">Buy-back loading, net % on the rate</label><input id="qeBb" inputmode="decimal" value="${esc(bb ? Math.round(bb * 10000) / 10000 : '')}" placeholder="e.g. 0.175"><span class="hint">Gross loading less no-claims bonus, e.g. 0.35 % − 50 % = 0.175 %.</span></div></div>
            <label class="switch" style="margin-top:4px"><input type="checkbox" id="qeBbOn" ${all ? 'checked' : ''}><span><b>Offer the buy-back</b><span>The quotation shows both rates next to the minimum premium.</span></span></label>
            <div id="qeWarRates" class="small" style="margin-top:8px"></div></div>`; })()}
      <div class="tbl-wrap" style="margin-top:12px"><table class="tbl"><thead><tr><th>Cover line</th><th>Sum insured</th><th>Rate %</th><th class="r">Premium</th><th></th></tr></thead><tbody id="qeLines">${(d.lines || []).map(lineRow).join('')}</tbody></table></div>
      <div class="toolbar" style="margin-top:8px"><button type="button" class="btn btn-ghost btn-sm" id="qeAdd">Add line</button>
        <label class="switch" style="margin:0"><input type="checkbox" id="qeTaxOn" ${taxOn ? 'checked' : ''}><span><b>Add insurance tax</b></span></label>
        <div class="field" style="flex-direction:row;align-items:center;gap:8px;margin:0"><label for="qeTax" style="white-space:nowrap">Rate %</label><input id="qeTax" inputmode="decimal" value="${esc(Number(d.taxPct) > 0 ? d.taxPct : taxDefault)}" style="width:80px" ${taxOn ? '' : 'disabled'}></div></div>
      <p class="xs muted" style="margin:4px 0 0">German insurance tax applies to the net premium. International transports of goods are usually exempt; tick it for domestic transports or where the insurer requires it.</p>
      <table class="qtable" id="qeSum"></table>
      <div class="qe-internal"><h4>Internal, never shown to the client</h4>
        <div class="grid3"><div class="field"><label for="qeBrk">Brokerage % with this insurer</label><input id="qeBrk" inputmode="decimal" value="${esc(preBrk)}"></div>
        <div class="field"><label>Brokerage</label><div class="num" id="qeBrkAmt" style="padding-top:10px">—</div></div>
        <div class="field"><label>Net premium to insurer</label><div class="num" id="qeNetIns" style="padding-top:10px">—</div></div>
        <div class="field"><label for="qeReb">Commission / rebate to the client, % of premium</label><input id="qeReb" inputmode="decimal" value="${esc(prevInt ? Number(prevInt.client_rebate_pct || 0) : 0)}"></div>
        <div class="field"><label>Rebate</label><div class="num" id="qeRebAmt" style="padding-top:10px">—</div></div>
        <div class="field"><label>Net retained brokerage</label><div class="num" id="qeKeep" style="padding-top:10px">—</div></div></div>
        <p class="xs muted" style="margin:0">Calculated on the premium after discount and minimum, before insurance tax. The default comes from the insurer (tab Insurers).</p></div>
      <div class="grid2" style="margin-top:6px">
        <div class="field"><label>Valid until (your local time)</label><input id="qeValid" type="datetime-local" value="${toLocal(new Date(Date.now() + 3 * 864e5))}"></div>
        <div class="field"><label>Handled by</label><input id="qeHandler" maxlength="100" value="${esc(me().full_name || '')}"></div>
      </div>
      <h3 style="margin:22px 0 6px">Quotation wording</h3>
      <p class="xs muted" style="margin:0 0 10px">Tick clauses from the library (defaults of ${og.policy ? esc(og.policy.name) : 'spot quotations'}); every text stays editable in the document. The pricing block follows the figures above.</p>
      <div class="qe-wording"><div class="qe-picks" id="qePicks"></div>
        <div class="qe-docwrap"><div class="rt-bar" role="toolbar" aria-label="Formatting">
            <button type="button" data-rt="bold" title="Bold"><b>B</b></button><button type="button" data-rt="big" title="Larger text">A+</button>
            <button type="button" data-rt="box" title="Outline box">▢ Box</button><button type="button" data-rt="mark" title="Highlight"><mark>Highlight</mark></button>
            <span style="flex:1"></span><button type="button" data-rt="copy" title="Copy for e-mail">Copy formatted text</button></div>
          <div class="qe-doc" id="qeDoc" contenteditable="true" spellcheck="true"></div></div></div>
      <div class="field"><label>Note for the client (optional)</label><textarea id="qeNote" rows="2" maxlength="800">${esc(d.note || '')}</textarea></div>
      <div class="field"><label>How to accept</label><textarea id="qeClose" rows="2" maxlength="1200">${esc(d.closing || '')}</textarea></div>
      <div class="err-msg" id="qeErr"></div></div>`);
    const $b = s => body.querySelector(s);
    // ---------- wording: library clauses → one editable document ----------
    const isLand = /^(road|rail)$/.test(r.conveyance), polId = og.policy ? og.policy.id : null;
    const fillIn = t => String(t || '').replace(/\{policy_no\}/g, (og.policy && og.policy.policy_no) || '—').replace(/\{assured\}/g, d.client || '').replace(/\{ref\}/g, r.ref || '').replace(/\{currency\}/g, d.currency || '');
    const lib = S.clauses.filter(c => c.active && !(isLand && c.maritime));
    // clauses suggested by the internal alerts of this shipment
    const alertTxt = (r.alerts || []).map(a => a.text).join(' ');
    const suggest = new Set([].concat(/Used goods/.test(alertTxt) ? ['Used machinery', 'Pre-shipment exception report'] : [], /warranty survey/.test(alertTxt) ? ['Marine warranty survey'] : [],
      r.on_deck ? ['On deck'] : [], /^unpacked/i.test(r.packaging || '') ? ['Unpacked goods'] : [], /Storage/.test(alertTxt) ? ['Storage'] : []));
    const docEl = $b('#qeDoc'), picks = $b('#qePicks');
    const sectionFor = cat => {
      let sec = docEl.querySelector(`section[data-cat="${cat}"]`);
      if(!sec){
        sec = document.createElement('section'); sec.dataset.cat = cat; sec.innerHTML = `<h4>${esc(CL_CAT.find(x => x[0] === cat)[1].replace(/^\d · /, ''))}</h4>`;
        const order = CL_CAT.map(x => x[0]), after = Array.from(docEl.querySelectorAll('section[data-cat]')).find(x => order.indexOf(x.dataset.cat) > order.indexOf(cat));
        docEl.insertBefore(sec, after || null);
      }
      return sec;
    };
    const addClause = c => { if(docEl.querySelector(`[data-cid="${c.id}"]`)) return; const p = document.createElement('p'); p.dataset.cid = c.id; p.textContent = fillIn(c.body); sectionFor(c.category).appendChild(p); };
    const dropClause = id => { const p = docEl.querySelector(`[data-cid="${id}"]`); if(!p) return; const sec = p.closest('section'); p.remove(); if(sec && sec.dataset.cat !== 'pricing' && !sec.querySelector('p,li,div')) sec.remove(); };
    picks.innerHTML = CL_CAT.filter(([cat]) => lib.some(c => c.category === cat)).map(([cat, label]) => `<div class="qe-pick"><b>${esc(label)}</b>${lib.filter(c => c.category === cat).map(c => `<label><input type="checkbox" data-cid="${c.id}"> ${esc(c.title)}${suggest.has(c.title) ? ' <span class="chip pending">suggested</span>' : ''}</label>`).join('')}</div>`).join('');
    if(d.doc){
      docEl.innerHTML = FC.cleanHtml(d.doc);
      // the clean-up drops the markers; re-attach them by text so the tick boxes match
      lib.forEach(c => { const t = fillIn(c.body); const p = Array.from(docEl.querySelectorAll('p')).find(x => !x.dataset.cid && x.textContent.trim() === t.trim()); if(p) p.dataset.cid = c.id; });
    }else{
      lib.filter(c => c.category !== 'pricing' && (clauseOn(c, polId) || (suggest.has(c.title) && !(c.category === 'special' && r.conditions)))).forEach(addClause);
      if(r.conditions){ const p = document.createElement('p'); p.textContent = r.conditions; const sec = sectionFor('special'); sec.insertBefore(p, sec.children[1] || null); }
    }
    lib.forEach(c => { const cb = picks.querySelector(`[data-cid="${c.id}"]`); if(cb) cb.checked = c.category === 'pricing' ? (d.doc ? docEl.textContent.includes(fillIn(c.body).trim()) : clauseOn(c, polId)) : !!docEl.querySelector(`[data-cid="${c.id}"]`); });
    picks.addEventListener('change', e => { const cb = e.target.closest('[data-cid]'); if(!cb) return; const c = lib.find(x => String(x.id) === cb.dataset.cid); if(c.category === 'pricing'){ recalc(); return; } cb.checked ? addClause(c) : dropClause(c.id); });
    // the pricing block is rebuilt from the figures; brokers cannot edit numbers by accident
    const paintPricing = (c, t, wx) => {
      const sec = sectionFor('pricing'); sec.setAttribute('contenteditable', 'false');
      const ln = c.lines[0] || {}, notes = lib.filter(x => x.category === 'pricing' && picks.querySelector(`[data-cid="${x.id}"]`) && picks.querySelector(`[data-cid="${x.id}"]`).checked);
      sec.innerHTML = `<h4>Pricing, valuation &amp; minimum premium</h4>
        <p>Sum insured ${esc(money2(ln.sum, c.cur))} (${esc(r.incoterm ? r.incoterm + ' value' : 'invoice value')}${Number(r.freight_value) > 0 ? ' incl. freight' : ''} + ${esc(Number(r.uplift_pct))} %) · rate ${esc(isFinite(ln.rate) ? FC.pct(ln.rate) : '—')} · premium ${esc(money2(t ? t.net : NaN, c.cur))}</p>
        <div class="box"><b>Minimum premium ${esc(money2(c.min, c.cur))}</b>${wx && wx.offerBuyback ? `<br>Rate with war &amp; strikes excluded: <b>${esc(FC.pct(wx.rateExcl))}</b><br>Rate with war &amp; strikes re-included for ${esc(wx.areas.join(', '))}: <b>${esc(FC.pct(wx.rateIncl))}</b>` : ''}</div>
        ${wx ? `<p>War &amp; strikes excluded for: ${esc(wx.areas.join(', '))}; remaining in force for the rest of the voyage.</p>` : ''}
        <p>Deductible: ${esc($b('#qeDed').value.trim() || '—')}</p>
        <p>${c.tax ? 'Insurance tax ' + esc(c.tax) + ' % = ' + esc(money2(t ? t.tax : NaN, c.cur)) + '; total payable ' + esc(money2(t ? t.total : NaN, c.cur)) : 'No insurance tax applied (international transport)'}.</p>
        ${notes.map(x => `<p data-cid="${x.id}">${esc(fillIn(x.body))}</p>`).join('')}`;
    };
    const docHtml = () => FC.cleanHtml(docEl.innerHTML);
    const docTexts = cat => Array.from(docEl.querySelectorAll(`section[data-cat="${cat}"] p, section[data-cat="${cat}"] li, section[data-cat="${cat}"] div`)).map(x => x.textContent.trim()).filter(Boolean);
    // toolbar
    const wrapSel = (tag, cls) => {
      const sel = getSelection(); if(!sel.rangeCount || !docEl.contains(sel.anchorNode) || sel.isCollapsed) return;
      const tmp = document.createElement('div'); tmp.appendChild(sel.getRangeAt(0).cloneContents());
      document.execCommand('insertHTML', false, `<${tag}${cls ? ' class="' + cls + '"' : ''}>${tmp.innerHTML}</${tag}>`);
    };
    $b('.rt-bar').addEventListener('mousedown', e => { if(e.target.closest('button')) e.preventDefault(); });
    $b('.rt-bar').addEventListener('click', async e => {
      const b = e.target.closest('[data-rt]'); if(!b) return; const k = b.dataset.rt;
      if(k === 'bold'){ docEl.focus(); document.execCommand('bold'); }
      else if(k === 'big') wrapSel('span', 'big');
      else if(k === 'mark') wrapSel('mark');
      else if(k === 'box'){ const sel = getSelection(); let n = sel.anchorNode; if(!n || !docEl.contains(n)) return; while(n && n !== docEl && !(n.nodeType === 1 && /^(P|DIV|LI)$/.test(n.tagName))) n = n.parentNode; if(n && n !== docEl) n.classList.toggle('box'); }
      else if(k === 'copy'){ recalc(); const ok = await FC.copyRich(FC.emailHtml(docHtml()), FC.htmlText(docHtml())); toast(ok ? 'Copied — paste it into your e-mail.' : 'Copy failed; select the text and copy it manually.', ok ? undefined : 'error'); }
    });
    const collect = () => {
      const lines = Array.from(body.querySelectorAll('#qeLines tr')).map(tr => {
        const sum = FC.parseNum(tr.querySelector('.ln-sum').value), rate = FC.parseNum(tr.querySelector('.ln-rate').value);
        return { label: tr.querySelector('.ln-label').value.trim(), sum, rate, premium: isFinite(sum) && isFinite(rate) ? Math.round(sum * rate) / 100 : NaN, tr };
      });
      return { lines, disc: FC.parseNum($b('#qeDisc').value) || 0, min: FC.parseNum($b('#qeMin').value) || 0, tax: $b('#qeTaxOn').checked ? (FC.parseNum($b('#qeTax').value) || 0) : 0, brk: FC.parseNum($b('#qeBrk').value) || 0, reb: FC.parseNum($b('#qeReb').value) || 0, cur: $b('#qeCur').value };
    };
    const recalc = () => {
      const c = collect();
      c.lines.forEach(l => { l.tr.querySelector('.ln-prem').textContent = isFinite(l.premium) ? money2(l.premium, c.cur) : '—'; });
      const ok = c.lines.length && c.lines.every(l => isFinite(l.premium));
      if(!ok){ $b('#qeSum').innerHTML = '<tr><td class="muted">Enter sum insured and rate for each line.</td></tr>'; $b('#qeBrkAmt').textContent = $b('#qeNetIns').textContent = '—'; return; }
      const t = calcQuote(c.lines, c.disc, c.min, c.tax);
      const ba = Math.round(t.net * c.brk) / 100;
      $b('#qeBrkAmt').textContent = money2(ba, c.cur); $b('#qeNetIns').textContent = money2(Math.round((t.net - ba) * 100) / 100, c.cur);
      const ra = Math.round(t.net * c.reb) / 100; $b('#qeRebAmt').textContent = money2(ra, c.cur); $b('#qeKeep').textContent = money2(Math.round((ba - ra) * 100) / 100, c.cur);
      $b('#qeKeep').style.color = ba - ra < 0 ? 'var(--danger)' : '';
      $b('#qeSum').innerHTML = `<tr><td>Premium</td><td class="r">${esc(money2(t.subtotal, c.cur))}</td></tr>
        ${c.disc ? `<tr><td>Client discount ${esc(c.disc)} %</td><td class="r">− ${esc(money2(t.discountAmount, c.cur))}</td></tr>` : ''}
        ${t.minApplied ? `<tr><td>Minimum premium applies</td><td class="r">${esc(money2(t.net, c.cur))}</td></tr>` : ''}
        ${c.tax ? `<tr><td>Insurance tax ${esc(c.tax)} %</td><td class="r">${esc(money2(t.tax, c.cur))}</td></tr>` : ''}
        <tr class="tot"><td>Total premium payable</td><td class="r">${esc(money2(t.total, c.cur))}</td></tr>`;
      const wx = warBlock(c);
      paintPricing(c, t, wx);
      if($b('#qeWarRates')) $b('#qeWarRates').innerHTML = wx && wx.offerBuyback ? `Rate with war &amp; strikes excluded: <b>${esc(FC.pct(wx.rateExcl))}</b> → ${esc(money2(wx.totalExcl, c.cur))} · Rate with war &amp; strikes re-included: <b>${esc(FC.pct(wx.rateIncl))}</b> → ${esc(money2(wx.totalIncl, c.cur))}` : wx ? 'The client sees the exclusion notice only.' : '';
    };
    // war & strikes excluded areas: the cargo line carries the rate without war; the buy-back adds the net loading
    const warBlock = c => {
      if(!$b('#qeWarAreas')) return null;
      const areas = $b('#qeWarAreas').value.split('\n').map(x => x.trim()).filter(Boolean); if(!areas.length) return null;
      const bb = FC.parseNum($b('#qeBb').value), on = $b('#qeBbOn').checked && bb > 0;
      const out = { areas, offerBuyback: on, buybackPct: isFinite(bb) ? bb : null };
      if(on && c.lines.length && isFinite(c.lines[0].rate)){
        const incl = c.lines.map((l, i) => i ? l : Object.assign({}, l, { rate: l.rate + bb, premium: Math.round(l.sum * (l.rate + bb)) / 100 }));
        const te = calcQuote(c.lines, c.disc, c.min, c.tax), ti = calcQuote(incl, c.disc, c.min, c.tax);
        Object.assign(out, { rateExcl: c.lines[0].rate, rateIncl: Math.round((c.lines[0].rate + bb) * 10000) / 10000, totalExcl: te.total, totalIncl: ti.total, netIncl: ti.net });
      }
      return out;
    };
    body.addEventListener('input', recalc);
    $b('#qeTaxOn').addEventListener('change', () => { $b('#qeTax').disabled = !$b('#qeTaxOn').checked; recalc(); });
    $b('#qeInsSel').addEventListener('change', () => {
      const ins = S.insurers.find(i => String(i.id) === $b('#qeInsSel').value);
      $b('#qeIns').hidden = !!ins; if(!ins) $b('#qeIns').focus();
      $b('#qeBrk').value = ins ? Number(ins.brokerage_pct || 0) : 0; recalc();
    });
    const insurerPick = () => { const ins = S.insurers.find(i => String(i.id) === $b('#qeInsSel').value); return ins ? { id: ins.id, name: ins.name } : { id: null, name: $b('#qeIns').value.trim() }; };
    body.addEventListener('click', e => { if(e.target.classList.contains('ln-del')){ e.target.closest('tr').remove(); recalc(); } });
    $b('#qeAdd').addEventListener('click', () => { $b('#qeLines').insertAdjacentHTML('beforeend', lineRow({ label:'', sum: Number(r.sum_insured), rate:null }, Date.now())); recalc(); });
    const build = () => {
      const c = collect(), err = t => { $b('#qeErr').textContent = t; return null; };
      if(!$b('#qeClient').value.trim()) return err('Enter the assured.');
      if(!c.lines.length || c.lines.some(l => !l.label || !(l.sum > 0) || !(l.rate >= 0))) return err('Every cover line needs a name, a sum insured above 0 and a rate.');
      if(c.disc < 0 || c.disc >= 100 || c.tax < 0 || c.tax > 40) return err('Check discount and tax.');
      if(!insurerPick().name) return err('Choose the insurer or type its name.');
      if(c.brk < 0 || c.brk > 50) return err('Brokerage must be between 0 and 50 %.');
      if(c.reb < 0 || c.reb > 50) return err('The client rebate must be between 0 and 50 %.');
      const vu = new Date($b('#qeValid').value); if(isNaN(vu) || vu.getTime() < Date.now() + 60000) return err('The validity must lie in the future.');
      const t = calcQuote(c.lines, c.disc, c.min, c.tax); $b('#qeErr').textContent = '';
      const ip = insurerPick(), ba = Math.round(t.net * c.brk) / 100;
      return { validUntil: vu.toISOString(), internal: { insurer_id: ip.id, insurer_name: ip.name, brokerage_pct: c.brk, brokerage_amount: ba, net_to_insurer: Math.round((t.net - ba) * 100) / 100, client_rebate_pct: c.reb, client_rebate_amount: Math.round(t.net * c.reb) / 100 }, data: {
        client: $b('#qeClient').value.trim(), clientAddress: $b('#qeAddr').value.trim(), policyholder: $b('#qePH').value.trim(), policyNo: d.policyNo || '', customerRef: $b('#qeCRef').value.trim(), incoterm: $b('#qeInco').value.trim(), coAssured: $b('#qeCo').value.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 6),
        goods: $b('#qeGoods').value.trim(), packaging: $b('#qePack').value.trim(), conveyance: $b('#qeConv').value, vessel: $b('#qeVessel').value.trim(),
        originCountry: $b('#qeOC').value.trim().toUpperCase(), originPlace: $b('#qeOP').value.trim(), destCountry: $b('#qeDC').value.trim().toUpperCase(), destPlace: $b('#qeDP').value.trim(),
        voyage: $b('#qeVoy').value.trim(), period: $b('#qePer').value.trim(), conditions: $b('#qeCond').value.trim(), insurer: insurerPick().name,
        deductible: $b('#qeDed').value.trim(), special: docTexts('special').join(' '), doc: docHtml(), currency: c.cur, discountPct: c.disc, minPremium: c.min, taxPct: c.tax,
        lines: c.lines.map(l => ({ label:l.label, sum: Math.round(l.sum * 100) / 100, rate: l.rate, premium: l.premium })),
        subtotal: t.subtotal, discountAmount: t.discountAmount, net: t.net, minApplied: t.minApplied, tax: t.tax, total: t.total, warExcl: warBlock(c),
        sumInsured: Math.max(...c.lines.map(l => l.sum)),
        subjectivities: docTexts('subjectivity').slice(0, 40), note: $b('#qeNote').value.trim(), closing: $b('#qeClose').value.trim(),
        handler: { name: $b('#qeHandler').value.trim(), email: me().email, initials: myInitials() }, issuedAt: new Date().toISOString()
      } };
    };
    return FC.dialog({ title: 'Quotation for ' + (r.ref || 'indication #' + r.id), wide:true, body, onOpen: () => recalc(),
      actions: [
        { label:'Cancel', kind:'ghost', value:false },
        { label:'Preview PDF', kind:'ghost', onClick: async () => { const b = build(); if(!b) return; FC.saveBlob(await FCPDF.quotation({ data:b.data, valid_until:b.validUntil, version:1, created_at:new Date().toISOString() }, r), FCPDF.fileName('PREVIEW_Quotation', r.ref)); } },
        { label:'Send to client', kind:'primary', onClick: async () => {
          const b = build(); if(!b) return;
          if(!(await FC.confirm('Send this quotation?', 'Total ' + money2(b.data.total, b.data.currency) + ', valid until ' + FC.dateTime(b.validUntil) + '. The client is notified by e-mail and can accept it online.', 'Send quotation'))) return;
          const { error } = await sb.rpc('admin_save_quotation', { p_indication_id: r.id, p_data: b.data, p_valid_until: b.validUntil, p_internal: b.internal });
          if(error){ $b('#qeErr').textContent = 'Could not send: ' + error.message; return; }
          toast('Quotation sent.'); return true;
        } }
      ] });
  }

  // ---------------- cover note editor ----------------
  function coverNoteEditor(r, q){
    const qd = (q && q.data) || {}, w = who(r);
    const d = {
      client: qd.client || r.insured_name || w.company, clientAddress: qd.clientAddress || (r.insured_name ? r.insured_address || '' : addrOf(w.p)), policyholder: qd.policyholder != null ? qd.policyholder : (r.insured_name ? [w.company, addrOf(w.p)].filter(Boolean).join(', ') : ''), customerRef: qd.customerRef != null ? qd.customerRef : (r.customer_ref || ''), coAssured: qd.coAssured || [], insurer: qd.insurer || setting('default_insurer', ''), policyNo: '',
      goods: qd.goods || r.goods_description, packaging: qd.packaging || r.packaging || '', marks: '', conveyance: qd.conveyance || r.conveyance, vessel: qd.vessel || '',
      transportDoc: '', voyage: qd.voyage || '', departure: r.departure_date ? FC.date(r.departure_date) : '', period: qd.period || '',
      originCountry: qd.originCountry || r.origin_country, originPlace: qd.originPlace || r.origin_place || '', destCountry: qd.destCountry || r.dest_country, destPlace: qd.destPlace || r.dest_place || '',
      sumInsured: qd.sumInsured || Number(r.sum_insured), currency: qd.currency || r.currency, conditions: qd.conditions || '', deductible: qd.deductible || setting('deductible_text', ''),
      special: qd.special || '', total: qd.total != null ? qd.total : r.premium, claims: setting('claims_text', 'Notify us immediately of any loss or damage. Note exceptions on the delivery receipt, keep damaged goods and packing, and hold carriers liable in writing within the time limits. A surveyor will be appointed where needed.'), note: ''
    };
    const f = (id, label, val, o) => `<div class="field"${o && o.wide ? ' style="grid-column:1/-1"' : ''}><label for="${id}">${esc(label)}</label>${o && o.area ? `<textarea id="${id}" rows="${o.rows || 2}" maxlength="1500">${esc(val)}</textarea>` : `<input id="${id}" maxlength="300" value="${esc(val == null ? '' : val)}">`}</div>`;
    const body = FC.el(`<div><div class="grid2">
        ${f('cnClient', 'Assured', d.client)}${f('cnAddr', 'Assured address', d.clientAddress)}${f('cnPH', 'Policyholder (if not the assured)', d.policyholder)}${f('cnCRef', "Client's reference", d.customerRef)}${f('cnCo', 'Co-assured (comma separated)', d.coAssured.join(', '))}
        ${f('cnIns', 'Insurer(s)', d.insurer)}${f('cnPol', 'Policy / certificate no.', d.policyNo)}
        ${f('cnGoods', 'Goods', d.goods)}${f('cnPack', 'Packaging', d.packaging)}
        ${f('cnMarks', 'Marks & numbers / container no.', d.marks)}${f('cnDoc', 'B/L, AWB or CMR no.', d.transportDoc)}
        ${f('cnVessel', 'Vessel / flight / truck', d.vessel)}${f('cnDep', 'Sailing / departure', d.departure)}
        ${f('cnVoy', 'Voyage', d.voyage, { wide:true })}${f('cnPer', 'Period', d.period, { wide:true })}
        ${f('cnSI', 'Sum insured', d.sumInsured)}<div class="field"><label for="cnCur">Currency</label><select id="cnCur"><option ${d.currency === 'EUR' ? 'selected' : ''}>EUR</option><option ${d.currency === 'USD' ? 'selected' : ''}>USD</option><option ${d.currency === 'GBP' ? 'selected' : ''}>GBP</option></select></div>
        ${f('cnCond', 'Conditions', d.conditions, { area:true, wide:true })}${f('cnDed', 'Deductible', d.deductible)}${f('cnTot', 'Premium (total)', d.total)}
        ${f('cnSpec', 'Special conditions', d.special, { area:true, wide:true })}${f('cnClaims', 'In case of loss or damage', d.claims, { area:true, wide:true, rows:3 })}
        ${f('cnNote', 'Additional note (optional)', d.note, { area:true, wide:true })}
      </div><div class="err-msg" id="cnErr"></div></div>`);
    const v = id => body.querySelector('#' + id).value.trim();
    const build = () => {
      const si = FC.parseNum(v('cnSI'));
      if(!v('cnClient') || !v('cnGoods') || !(si > 0)){ body.querySelector('#cnErr').textContent = 'Assured, goods and sum insured are required.'; return null; }
      return { client:v('cnClient'), clientAddress:v('cnAddr'), policyholder:v('cnPH'), customerRef:v('cnCRef'), coAssured: v('cnCo').split(',').map(s => s.trim()).filter(Boolean), insurer:v('cnIns'), policyNo:v('cnPol'), goods:v('cnGoods'), packaging:v('cnPack'), marks:v('cnMarks'),
        transportDoc:v('cnDoc'), vessel:v('cnVessel'), departure:v('cnDep'), voyage:v('cnVoy'), period:v('cnPer'), conveyance:d.conveyance,
        originCountry:d.originCountry, originPlace:d.originPlace, destCountry:d.destCountry, destPlace:d.destPlace,
        sumInsured: si, currency: body.querySelector('#cnCur').value, conditions:v('cnCond'), deductible:v('cnDed'), total: FC.parseNum(v('cnTot')),
        special:v('cnSpec'), claims:v('cnClaims'), note:v('cnNote'), issuedAt:new Date().toISOString() };
    };
    return FC.dialog({ title:'Cover note for ' + (r.ref || '#' + r.id), wide:true, body, actions:[
      { label:'Cancel', kind:'ghost', value:false },
      { label:'Preview PDF', kind:'ghost', onClick: async () => { const b = build(); if(!b) return; FC.saveBlob(await FCPDF.coverNote({ data:Object.assign({ number:'PREVIEW' }, b), issued_at:new Date().toISOString() }, r), 'PREVIEW_CoverNote.pdf'); } },
      { label:'Issue cover note', kind:'primary', onClick: async () => {
        const b = build(); if(!b) return;
        if(!(await FC.confirm('Issue the cover note?', 'A cover note number is assigned and the client is notified. Make sure cover has been confirmed by the insurer.', 'Issue cover note'))) return;
        const { data, error } = await sb.rpc('admin_issue_cover_note', { p_indication_id: r.id, p_quotation_id: q ? q.id : null, p_data: b });
        if(error){ body.querySelector('#cnErr').textContent = 'Could not issue: ' + error.message; return; }
        toast('Cover note ' + data + ' issued.'); return true;
      } }] });
  }

  // ---------------- invoice upload ----------------
  function invoiceUpload(r){
    const q = (S.quotes[r.id] || []).filter(x => x.status === 'accepted').pop();
    const body = FC.el(`<div><div class="grid2">
        <div class="field"><label for="ivNo">Invoice number</label><input id="ivNo" maxlength="40"></div>
        <div class="field"><label for="ivDue">Due date</label><input id="ivDue" type="date"></div>
        <div class="field"><label for="ivAmt">Amount</label><input id="ivAmt" inputmode="decimal" value="${q ? esc(q.data.total) : r.premium != null ? esc(r.premium) : ''}"></div>
        <div class="field"><label for="ivCur">Currency</label><select id="ivCur"><option ${r.currency === 'EUR' ? 'selected' : ''}>EUR</option><option ${r.currency === 'USD' ? 'selected' : ''}>USD</option><option ${r.currency === 'GBP' ? 'selected' : ''}>GBP</option></select></div></div>
      <div class="field" style="margin-top:12px"><label for="ivFile">PDF file</label><input id="ivFile" type="file" accept="application/pdf"></div>
      <p class="xs muted">The client sees the invoice under My quotations → Invoices.</p><div class="err-msg" id="ivErr"></div></div>`);
    return FC.dialog({ title:'Upload invoice', body, actions:[{ label:'Cancel', kind:'ghost', value:false }, { label:'Upload', kind:'primary', onClick: async () => {
      const e = t => { body.querySelector('#ivErr').textContent = t; };
      const no = body.querySelector('#ivNo').value.trim(), amt = FC.parseNum(body.querySelector('#ivAmt').value), file = body.querySelector('#ivFile').files[0];
      if(!no) return e('Enter the invoice number.'); if(!(amt > 0)) return e('Enter the amount.'); if(!file) return e('Choose the PDF file.');
      if(file.size > 8e6) return e('The file is larger than 8 MB.');
      const path = r.user_id + '/' + no.replace(/[^A-Za-z0-9_-]+/g, '_') + '_' + Date.now() + '.pdf';
      const up = await sb.storage.from('invoices').upload(path, file, { contentType:'application/pdf', upsert:false });
      if(up.error) return e('Upload failed: ' + up.error.message);
      const { error } = await sb.from('invoices').insert({ indication_id: r.id, user_id: r.user_id, number: no, amount: amt, currency: body.querySelector('#ivCur').value, due_date: body.querySelector('#ivDue').value || null, file_path: path });
      if(error){ await sb.storage.from('invoices').remove([path]); return e('Could not save: ' + error.message); }
      toast('Invoice uploaded.'); return true;
    } }] });
  }

  // ---------------- text for insurers (copy & paste into an e-mail) ----------------
  function insurerText(r){
    const w = who(r), conv = (FC.CONVEYANCE[r.conveyance] || {}).label;
    const t = [
      'Dear colleagues,', '', 'we would be grateful for your quotation on the following single shipment:', '',
      'Assured: ' + w.company, 'Goods: ' + r.goods_description + (r.packaging ? ' (' + r.packaging + ')' : ''),
      'Conveyance: ' + conv + (r.vessel ? ', vessel ' + r.vessel : ''), r.incoterm ? 'Incoterm: ' + r.incoterm + ' (assured is the ' + (r.insured_party || 'seller') + ')' : '', 'Voyage: ' + [r.origin_place, cName(r.origin_country)].filter(Boolean).join(', ') + ' to ' + [r.dest_place, cName(r.dest_country)].filter(Boolean).join(', '),
      'Departure: ' + (r.departure_date ? FC.date(r.departure_date) : 'tba'),
      'Sum insured: ' + money2(r.sum_insured, r.currency) + ' (invoice value + ' + Number(r.uplift_pct) + ' %)',
      'Cover: ' + (FC.COVER[r.cover] || {}).clause + (r.war_strikes ? (r.conveyance === 'road' || r.conveyance === 'rail' ? ' incl. strikes' : ' incl. war and strikes') : ''),
      r.customer_comment ? 'Remarks: ' + r.customer_comment : '', '', 'Kind regards', me().full_name || ''
    ].filter((x, i, a) => x !== '' || a[i - 1] !== '').join('\n');
    FC.dialog({ title:'Text for insurer', body:`<textarea class="input" rows="16" style="width:100%">${esc(t)}</textarea>`,
      actions:[{ label:'Close', kind:'ghost', value:null }, { label:'Copy text', kind:'primary', onClick: async () => { await FC.copy(t); toast('Copied.'); return true; } }] });
  }

  // =================================================================== OVERVIEW
  async function renderOverview(body){
    body.innerHTML = `<div class="toolbar"><select class="input" id="ovDays" aria-label="Period"><option value="7">Last 7 days</option><option value="30" selected>Last 30 days</option><option value="90">Last 90 days</option><option value="365">Last 12 months</option></select></div><div id="ovBody"><div class="empty">Loading…</div></div>`;
    const paint = async () => {
      const { data, error } = await sb.rpc('admin_overview', { p_days: Number($('#ovDays', body).value) });
      const host = $('#ovBody', body);
      if(error){ host.innerHTML = `<div class="empty">Could not load: ${esc(error.message)}</div>`; return; }
      const conv = (data.requests && data.indications) ? Math.round(100 * data.requests / data.indications) : 0;
      const prem = Object.entries(data.premium_bound || {}).map(([c, v]) => money2(v, c)).join(' + ') || '—';
      const max = Math.max(1, ...(data.by_day || []).map(d => d.n));
      host.innerHTML = `<div class="stats">
          <div class="stat"><b>${esc(data.indications)}</b><span>Indications</span></div>
          <div class="stat"><b>${esc(data.requests)}</b><span>Quotation requests (${conv} %)</span></div>
          <div class="stat"><b>${esc(data.quoted)}</b><span>Quotations sent</span></div>
          <div class="stat"><b>${esc(data.accepted)}</b><span>Accepted</span></div>
          <div class="stat"><b>${esc(data.bound)}</b><span>Cover notes issued</span></div>
          <div class="stat"><b style="font-size:var(--fs-lg)">${esc(prem)}</b><span>Premium bound</span></div></div>
        <div class="grid2" style="align-items:start">
          <div class="card card-pad"><h3>Indications per day</h3><div class="bars" aria-label="Indications per day, amber part are requests">${(data.by_day || []).map(d => `<div style="height:${100 * d.n / max}%" title="${esc(FC.date(d.d))}: ${d.n} indications, ${d.r} requests"><i style="height:${d.n ? 100 * d.r / d.n : 0}%"></i></div>`).join('') || '<span class="muted small">No data yet.</span>'}</div><p class="xs muted" style="margin:0">Amber: share that led to a quotation request.</p></div>
          <div class="card card-pad"><h3>Most frequent routes</h3><table class="qtable">${(data.top_routes || []).map(t => `<tr><td>${esc(t.route)}</td><td class="r">${esc(t.n)}</td></tr>`).join('') || '<tr><td class="muted">No data yet.</td></tr>'}</table></div></div>
        <div class="stats" style="margin-top:20px">
          <div class="stat${data.pending_users ? ' alert' : ''}"><b>${esc(data.pending_users)}</b><span>Accounts waiting for activation</span></div>
          <div class="stat${data.pending_referrals ? ' alert' : ''}"><b>${esc(data.pending_referrals)}</b><span>Referrals to decide</span></div>
          <div class="stat${data.open_feedback ? ' alert' : ''}"><b>${esc(data.open_feedback)}</b><span>Open feedback</span></div></div>`;
    };
    $('#ovDays', body).addEventListener('change', paint); paint();
  }

  // =================================================================== LEDGER
  // three tiers: the client sees premium and tax; the underwriter bordereau shows technical risk data only;
  // this ledger adds underwriter commission, rebate to the client and the net brokerage retained
  let ldFilter = { period:'year', scope:'' };
  const ledgerRows = () => {
    const now = new Date(), from = ldFilter.period === 'month' ? new Date(now.getFullYear(), now.getMonth(), 1) : ldFilter.period === 'last' ? new Date(now.getFullYear(), now.getMonth() - 1, 1) : ldFilter.period === 'year' ? new Date(now.getFullYear(), 0, 1) : new Date(0);
    const to = ldFilter.period === 'last' ? new Date(now.getFullYear(), now.getMonth(), 1) : new Date(8.64e15);
    const out = [];
    S.rows.filter(r => !r.is_test).forEach(r => {
      const q = (S.quotes[r.id] || []).filter(x => x.status === 'accepted').pop(); if(!q) return;
      const when = new Date(q.responded_at || q.created_at); if(when < from || when >= to) return;
      const og = orgOfCase(r);
      if(ldFilter.scope === 'spot' && og.policy) return;
      if(ldFilter.scope && ldFilter.scope !== 'spot' && String(og.policy && og.policy.id) !== ldFilter.scope) return;
      const x = S.qint[q.id] || {}, d = q.data || {}, cn = (S.coverNotes[r.id] || []).slice(-1)[0];
      const gross = Number(d.net || 0), brk = Number(x.brokerage_amount || 0), reb = Number(x.client_rebate_amount || 0);
      out.push({ r, q, d, x, og, cn, when, cur: d.currency || r.currency, gross, tax: Number(d.tax || 0), total: Number(d.total || 0), brk, brkPct: Number(x.brokerage_pct || 0), reb, rebPct: Number(x.client_rebate_pct || 0), keep: Math.round((brk - reb) * 100) / 100 });
    });
    return out.sort((a, b) => b.when - a.when);
  };
  function renderLedger(body){
    body.innerHTML = `<p class="small muted" style="margin:0 0 14px">Accepted quotations. <b>Gross premium</b> = premium after discount and minimum, before insurance tax. <b>UW commission</b> = brokerage received from the insurer; <b>rebate</b> = commission passed to the client; <b>net retained</b> = what stays with you. The bordereau for underwriters contains technical risk data only — no commissions, no co-insurer shares.</p>
      <div class="toolbar"><select class="input" id="ldPer"><option value="month">This month</option><option value="last">Last month</option><option value="year">This year</option><option value="all">All time</option></select>
        <select class="input" id="ldScope"><option value="">All business</option><option value="spot">Spot clients only</option>${S.policies.map(po => `<option value="${po.id}">${esc(po.name)} ${esc(po.policy_no || '')}</option>`).join('')}</select>
        <span style="flex:1"></span><span id="ldActs" class="toolbar" style="margin:0"></span></div><div id="ldBody"></div>`;
    $('#ldPer', body).value = ldFilter.period; $('#ldScope', body).value = ldFilter.scope;
    const paint = () => {
      const rows = ledgerRows(), host = $('#ldBody', body);
      const tot = {}; rows.forEach(x => { const t = tot[x.cur] = tot[x.cur] || { n:0, gross:0, tax:0, brk:0, reb:0, keep:0 }; t.n++; t.gross += x.gross; t.tax += x.tax; t.brk += x.brk; t.reb += x.reb; t.keep += x.keep; });
      host.innerHTML = `<div class="stats">${Object.entries(tot).map(([c, t]) => `<div class="stat"><b class="num" style="font-size:20px">${esc(money2(t.keep, c))}</b><span>Net retained · ${t.n} case${t.n > 1 ? 's' : ''} · premium ${esc(money2(t.gross, c))} · commission ${esc(money2(t.brk, c))} · rebate ${esc(money2(t.reb, c))}</span></div>`).join('') || '<div class="stat"><b>0</b><span>No accepted quotations in this period</span></div>'}</div>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Accepted</th><th>Reference</th><th>Client</th><th>Policy</th><th>Insurer</th><th class="r">Gross premium</th><th class="r">Tax</th><th class="r">UW commission</th><th class="r">Rebate</th><th class="r">Net retained</th></tr></thead><tbody>
        ${rows.map(x => `<tr class="click" data-id="${x.r.id}"><td class="xs">${esc(FC.date(x.when))}</td><td><b>${esc(x.r.ref || '')}</b>${x.cn ? '<br><span class="xs muted">' + esc(x.cn.number) + '</span>' : ''}</td><td>${esc(who(x.r).company)}${x.r.insured_name ? '<br><span class="xs muted">for ' + esc(x.r.insured_name) + '</span>' : ''}</td>
          <td class="small">${x.og.policy ? esc(x.og.policy.name) : '<span class="muted">Spot</span>'}</td><td class="small">${esc(x.x.insurer_name || x.d.insurer || '')}</td>
          <td class="r num">${esc(money2(x.gross, x.cur))}</td><td class="r num">${esc(money2(x.tax, x.cur))}</td><td class="r num">${esc(money2(x.brk, x.cur))}<br><span class="xs muted">${esc(x.brkPct)} %</span></td>
          <td class="r num">${esc(money2(x.reb, x.cur))}${x.rebPct ? '<br><span class="xs muted">' + esc(x.rebPct) + ' %</span>' : ''}</td><td class="r num"><b>${esc(money2(x.keep, x.cur))}</b></td></tr>`).join('') || '<tr><td colspan="10" class="muted small">Nothing in this period.</td></tr>'}</tbody></table></div>`;
      host.querySelectorAll('tr[data-id]').forEach(tr => tr.addEventListener('click', () => openCase(Number(tr.dataset.id))));
    };
    const acts = $('#ldActs', body);
    acts.appendChild(btn('Ledger (.xlsx)', 'ghost', b => exportLedger(b, false)));
    acts.appendChild(btn('Bordereau for underwriters (.xlsx)', 'primary', b => exportLedger(b, true)));
    $('#ldPer', body).addEventListener('change', e => { ldFilter.period = e.target.value; paint(); });
    $('#ldScope', body).addEventListener('change', e => { ldFilter.scope = e.target.value; paint(); });
    paint();
  }
  async function exportLedger(b, bordereau){
    const rows = ledgerRows(); if(!rows.length) return toast('Nothing to export in this period.');
    busy(b, true);
    try{
      if(!window.XLSX) await FC.loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
      const num = v => Math.round(Number(v || 0) * 100) / 100;
      let head, data;
      if(bordereau){
        head = ['Reference', 'Cover note', 'Accepted', 'Departure', 'Open policy', 'Assured', 'Policyholder / office', 'Goods', 'Cargo type', 'Packaging', 'Conveyance', 'Vessel', 'From', 'To', 'Via', 'Sum insured', 'Currency', 'Conditions', 'Rate %', 'Premium (excl. tax)', 'Deductible', 'War & strikes excluded for'];
        data = rows.map(x => { const r = x.r, d = x.d; return [r.ref, x.cn ? x.cn.number : '', FC.date(x.when), r.departure_date || '', x.og.policy ? x.og.policy.policy_no || x.og.policy.name : '', d.client || r.insured_name || who(r).company, x.og.office ? x.og.office.name : who(r).company,
          r.goods_description, (S.commodities.find(c => c.id === r.commodity_id) || {}).name || r.commodity_id, r.packaging || '', (FC.CONVEYANCE[r.conveyance] || {}).label || r.conveyance, d.vessel || r.vessel || '',
          [r.origin_place, cName(r.origin_country)].filter(Boolean).join(', '), [r.dest_place, cName(r.dest_country)].filter(Boolean).join(', '), (r.transit_countries || []).map(cName).join(', '),
          num(d.sumInsured || r.sum_insured), x.cur, d.conditions || '', (d.lines || [])[0] ? Number(d.lines[0].rate) : '', num(x.gross), d.deductible || '', (d.warExcl ? d.warExcl.areas : (r.war_excluded || [])).join(', ')]; });
      }else{
        head = ['Accepted', 'Reference', 'Cover note', 'Client', 'Office', 'Policy', 'Insurer', 'Currency', 'Gross premium', 'Insurance tax', 'Total payable', 'UW commission %', 'UW commission', 'Client rebate %', 'Client rebate', 'Net retained', 'Net to insurer'];
        data = rows.map(x => [FC.date(x.when), x.r.ref, x.cn ? x.cn.number : '', who(x.r).company, x.og.office ? x.og.office.name : '', x.og.policy ? x.og.policy.name : 'Spot', x.x.insurer_name || x.d.insurer || '', x.cur,
          num(x.gross), num(x.tax), num(x.total), x.brkPct, num(x.brk), x.rebPct, num(x.reb), num(x.keep), num(x.x.net_to_insurer)]);
      }
      const ws = XLSX.utils.aoa_to_sheet([head].concat(data)); ws['!cols'] = head.map(h => ({ wch: Math.max(12, h.length + 2) }));
      const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, bordereau ? 'Bordereau' : 'Ledger');
      const pol = ldFilter.scope && ldFilter.scope !== 'spot' ? polOf(Number(ldFilter.scope)) : null;
      XLSX.writeFile(wb, (bordereau ? 'Bordereau_' : 'FREIGHTCON_ledger_') + (pol ? (pol.policy_no || pol.name).replace(/[^\w-]+/g, '_') + '_' : '') + FC.today() + '.xlsx');
    }catch(err){ console.error(err); toast('The file could not be created.', 'error'); }
    busy(b, false);
  }

  // =================================================================== CUSTOMERS
  let custTab = 'users';
  function renderCustomers(body){
    body.innerHTML = `<div class="tabs" role="tablist">${[['users','Users'],['groups','Client groups, policies & offices']].map(([k, l]) => `<button role="tab" data-ctab="${k}" aria-selected="${k === custTab}">${l}</button>`).join('')}</div><div id="ctBody"></div>`;
    $$('[data-ctab]', body).forEach(b => b.addEventListener('click', () => { custTab = b.dataset.ctab; renderCustomers(body); }));
    const host = $('#ctBody', body);
    (custTab === 'groups' ? renderGroups : renderUsers)(host);
  }
  async function renderUsers(body){
    const { data: refs } = await sb.from('referrals').select('*').order('created_at', { ascending:false });
    const pend = pendingUsers(), P = S.profiles;
    if(pend.length){
      body.appendChild(FC.el('<h2 style="margin-bottom:10px">Waiting for activation</h2>'));
      const l = FC.el('<div class="list" style="margin-bottom:24px"></div>');
      pend.forEach(p => {
        const ref = p.referred_by && P[p.referred_by];
        const it = FC.el(`<div class="item new"><div><div class="t">${esc(p.company || '—')}</div><div class="meta">${esc(p.full_name || '')}, ${esc(p.email)}${p.phone ? ', ' + esc(p.phone) : ''}${addrOf(p) ? '<br>' + esc(addrOf(p)) : ''}<br>Registered ${esc(FC.dateTime(p.created_at))}${ref ? ', invited by ' + esc(ref.company || ref.email) : ''}</div></div><div class="acts"></div></div>`);
        it.querySelector('.acts').appendChild(btn('Reject', 'danger', async () => { if(!(await FC.confirm('Reject this account?', 'The user cannot log in.', 'Reject', 'danger'))) return; await upd(p.id, { rejected:true }); }));
        it.querySelector('.acts').appendChild(btn('Activate', 'ok', async () => upd(p.id, { approved:true, rejected:false })));
        l.appendChild(it);
      });
      body.appendChild(l);
    }
    const pr = (refs || []).filter(r => r.status === 'pending' && P[r.referred_id] && P[r.referred_id].approved);
    if(pr.length){
      body.appendChild(FC.el(`<h2 style="margin-bottom:6px">Referrals to decide</h2><p class="small muted" style="margin:0 0 10px">Approving grants the inviting customer a ${esc(setting('referral_discount_pct', 5))} % client discount.</p>`));
      const l = FC.el('<div class="list" style="margin-bottom:24px"></div>');
      pr.forEach(r => {
        const a = P[r.referrer_id] || {}, b = P[r.referred_id] || {};
        const it = FC.el(`<div class="item"><div><div class="t">${esc(a.company || a.email)} invited ${esc(b.company || b.email)}</div><div class="meta">${esc(FC.dateTime(r.created_at))}</div></div><div class="acts"></div></div>`);
        it.querySelector('.acts').appendChild(btn('Reject', 'ghost', async () => { await sb.rpc('admin_decide_referral', { p_id: r.id, p_approve:false }); await loadAll(); render(); }));
        it.querySelector('.acts').appendChild(btn('Approve discount', 'ok', async () => { const { error } = await sb.rpc('admin_decide_referral', { p_id: r.id, p_approve:true }); if(error) return toast(error.message, 'error'); toast('Discount granted.'); await loadAll(); render(); }));
        l.appendChild(it);
      });
      body.appendChild(l);
    }
    body.appendChild(FC.el('<h2 style="margin-bottom:10px">All customers</h2>'));
    const tb = FC.el('<div class="toolbar"><input class="input" type="search" placeholder="Search company, name, e-mail" aria-label="Search customers"></div>'); body.appendChild(tb);
    const wrap = FC.el('<div class="tbl-wrap"></div>'); body.appendChild(wrap);
    const count = {}; S.rows.forEach(r => { const c = count[r.user_id] = count[r.user_id] || { i:0, q:0, b:0 }; c.i++; if(r.quote_requested_at) c.q++; if(r.stage === 'bound') c.b++; });
    const paint = () => {
      const s = tb.querySelector('input').value.trim().toLowerCase();
      const rows = Object.values(P).filter(p => !s || [p.company, p.full_name, p.email, p.country, (userGroup(p) || {}).name, (ofcOf(p.office_id) || {}).name].join(' ').toLowerCase().includes(s));
      wrap.innerHTML = `<table class="tbl"><thead><tr><th>Company</th><th>Contact</th><th>Group / office</th><th>Status</th><th class="r">Indications</th><th class="r">Requests</th><th class="r">Bound</th><th class="r">Discount</th><th>Registered</th></tr></thead><tbody></tbody></table>`;
      rows.forEach(p => {
        const c = count[p.id] || { i:0, q:0, b:0 };
        const st = p.rejected ? chip('rejected', 'Rejected') : p.approved ? chip('approved', p.is_admin ? 'Admin' : 'Active') : chip('pending', 'Waiting');
        const tr = FC.el(`<tr class="click" tabindex="0"><td><b>${esc(p.company || '—')}</b>${p.deletion_requested_at ? ' ' + chip('declined', 'Deletion requested') : ''}</td><td>${esc(p.full_name || '')}<br><span class="xs muted">${esc(p.email)}</span></td><td>${(() => { const g = userGroup(p), o = ofcOf(p.office_id); return g ? esc(g.name) + (o ? '<br><span class="xs muted">' + esc(o.name) + (o.location ? ', ' + esc(o.location) : '') + '</span>' : g.kind === 'open_cover' ? '<br>' + chip('pending', 'No office yet') : '') : '<span class="muted">—</span>'; })()}</td><td>${st}</td><td class="r">${c.i}</td><td class="r">${c.q}</td><td class="r">${c.b}</td><td class="r">${esc(Number(p.client_discount_pct))} %</td><td class="xs">${esc(FC.date(p.created_at))}</td></tr>`);
        tr.addEventListener('click', () => editCustomer(p)); tr.addEventListener('keydown', e => { if(e.key === 'Enter') editCustomer(p); });
        wrap.querySelector('tbody').appendChild(tr);
      });
    };
    tb.querySelector('input').addEventListener('input', paint); paint();
  }
  // ---------------- client groups → policies → offices ----------------
  const RULE_DEF = { icc_c_pct:50, interest_pct:40, deck_loading_pct:50, air_war_permille:0.5, air_freight:{ used_pct:50, cars_pct:50, household_permille:10 }, air_charter:{ used_pct:25, cars_pct:25, household_permille:null } };
  const KIND = { office:'Office', warehouse:'Warehouse', agent:'Approved agent' };
  let grpQ = '';
  function renderGroups(body){
    const users = Object.values(S.profiles);
    const usersOf = g => users.filter(p => (userGroup(p) || {}).id === g.id).length;
    const bar = FC.el(`<div class="toolbar"><input class="input" type="search" id="gpQ" placeholder="Search offices, cities, countries, contacts" value="${esc(grpQ)}" aria-label="Search offices"><span style="flex:1"></span><button class="btn btn-primary btn-sm" type="button" id="gpAdd">+ Add group</button></div>`);
    body.appendChild(bar);
    body.appendChild(FC.el(`<p class="small muted" style="margin:0 0 14px">Each user belongs to a group (by assignment or by e-mail domain). In open cover groups every user and every shipment is linked to an office; minimum premium and deductible come from the user, else the office, else the policy. Clients never see rates, minimum premiums, security or contacts here.</p>`));
    const list = FC.el('<div class="gp-list"></div>'); body.appendChild(list);
    bar.querySelector('#gpAdd').addEventListener('click', () => groupDialog(null));
    const paint = () => {
      const q = grpQ.trim().toLowerCase();
      list.innerHTML = '';
      if(!S.groups.length){ list.innerHTML = '<div class="empty card"><h3>No client groups yet</h3><p>Run update_2026-11-12l.sql in Supabase, or add a group.</p></div>'; return; }
      S.groups.forEach(g => {
        const pols = S.policies.filter(po => po.group_id === g.id);
        const card = FC.el(`<section class="card gp-card"><div class="gp-head"><div><h2>${esc(g.name)}</h2>
            <div class="gp-tags">${chip(g.kind === 'open_cover' ? 'accepted' : 'neutral', g.kind === 'open_cover' ? 'Open cover' : 'Spot / one-off')} ${g.show_premium ? chip('neutral', 'Client sees indicative premium') : chip('pending', 'Request only — premium stays internal')} ${(g.email_domains || []).map(d => chip('neutral', '@' + d)).join(' ')} <span class="xs muted">${usersOf(g)} user(s)</span></div>
            ${g.notes ? `<p class="xs muted" style="margin:6px 0 0">${esc(g.notes)}</p>` : ''}</div><div class="acts"></div></div><div class="gp-pols"></div></section>`);
        card.querySelector('.acts').appendChild(btn('Edit group', 'ghost', () => groupDialog(g)));
        card.querySelector('.acts').appendChild(btn('+ Add policy', 'ghost', () => policyDialog(null, g.id)));
        const ph = card.querySelector('.gp-pols');
        if(!pols.length) ph.innerHTML = `<p class="small muted" style="margin:0">${g.kind === 'open_cover' ? 'No policy yet — add the open cover policy.' : 'Spot clients need no policy: terms are set per quotation.'}</p>`;
        pols.forEach(po => {
          const offs = S.offices.filter(o => o.policy_id === po.id).filter(o => !q || [o.name, o.location, o.country, cName(o.country), o.contacts, o.subcategory, KIND[o.kind]].join(' ').toLowerCase().includes(q));
          const sec = (po.security || []).map(x => `${esc(x.insurer)} ${esc(x.share)} %${x.lead ? ' (lead)' : ''}`).join(' · ');
          const secSum = (po.security || []).reduce((t, x) => t + Number(x.share || 0), 0);
          const pc = FC.el(`<div class="gp-pol"><div class="gp-pol-head"><div><h3>${esc(po.name)} <span class="muted" style="font-weight:400">${esc(po.policy_no || '')}</span> ${po.active ? '' : chip('declined', 'Inactive')}</h3>
              <div class="gp-facts">
                <span><i>Currency</i><b>${esc(po.currency)}</b></span>
                <span><i>Rating</i><b>${po.rating === 'schedule' ? 'Policy schedules' : 'Standard FREIGHTCON'}</b></span>
                <span><i>Minimum premium</i><b>${esc(amt(po.min_premium, po.currency))}</b></span>
                <span><i>Deductible</i><b>${esc(amt(po.deductible, po.currency))}</b></span>
                <span><i>Any one conveyance</i><b>${esc(amt(po.limit_conveyance, po.currency))}</b></span>
                <span><i>On deck / barge</i><b>${esc(amt(po.limit_on_deck, po.currency))}</b></span>
                <span><i>Parcel post</i><b>${esc(amt(po.limit_post, po.currency))}</b></span></div>
              ${po.policyholder ? `<p class="xs" style="margin:8px 0 0"><span class="muted">Policyholder</span> ${esc(po.policyholder)}</p>` : ''}
              ${sec ? `<p class="xs" style="margin:4px 0 0"><span class="muted">Security${po.placed_via ? ' via ' + esc(po.placed_via) : ''}</span> ${sec}${secSum !== 100 ? ' ' + chip('declined', 'total ' + secSum + ' %') : ''}</p>` : ''}</div><div class="acts"></div></div>
            <div class="tbl-wrap"><table class="tbl gp-off"><thead><tr><th>Office / entity</th><th>Location</th><th>Type</th><th class="r">Min. premium</th><th class="r">Deductible</th><th class="r">Users</th></tr></thead><tbody></tbody></table></div></div>`);
          pc.querySelector('.acts').appendChild(btn('Edit policy', 'ghost', () => policyDialog(po, g.id)));
          pc.querySelector('.acts').appendChild(btn('+ Add office', 'ghost', () => officeDialog(null, po.id)));
          pc.querySelector('.acts').appendChild(btn('Clauses', 'ghost', () => { clPolicy = po.id; clTab = 'policy'; tab = 'clauses'; $$('[data-atab]', root).forEach(x => x.setAttribute('aria-selected', String(x.dataset.atab === 'clauses'))); render(); }));
          pc.querySelector('.acts').appendChild(btn('Copy terms from…', 'ghost', () => copyTermsDialog(po)));
          const tb = pc.querySelector('tbody');
          if(!offs.length) tb.innerHTML = `<tr><td colspan="6" class="muted small">${q ? 'No match.' : 'No offices yet.'}</td></tr>`;
          offs.forEach(o => {
            const nu = users.filter(p => p.office_id === o.id).length;
            const tr = FC.el(`<tr class="click" tabindex="0"><td><b>${esc(o.name)}</b>${o.subcategory ? ' ' + chip('neutral', o.subcategory) : ''}${o.active ? '' : ' ' + chip('declined', 'Inactive')}${o.contacts ? '<br><span class="xs muted">' + esc(o.contacts) + '</span>' : ''}</td>
              <td>${esc(o.location || '')}<br><span class="xs muted">${esc(cName(o.country))}</span></td><td class="xs">${esc(KIND[o.kind] || o.kind)}</td>
              <td class="r num">${o.min_premium != null ? '<b>' + esc(amt(o.min_premium, po.currency)) + '</b>' : '<span class="muted">' + esc(amt(po.min_premium, po.currency)) + '</span>'}</td>
              <td class="r num">${o.deductible != null ? '<b>' + esc(amt(o.deductible, po.currency)) + '</b>' : '<span class="muted">' + esc(amt(po.deductible, po.currency)) + '</span>'}</td><td class="r">${nu}</td></tr>`);
            tr.addEventListener('click', () => officeDialog(o, po.id)); tr.addEventListener('keydown', e => { if(e.key === 'Enter') officeDialog(o, po.id); });
            tb.appendChild(tr);
          });
          ph.appendChild(pc);
        });
        list.appendChild(card);
      });
    };
    bar.querySelector('#gpQ').addEventListener('input', e => { grpQ = e.target.value; paint(); });
    paint();
  }
  async function saveRow(table, row, id){
    const r = id ? await sb.from(table).update(row).eq('id', id) : await sb.from(table).insert(row);
    if(r.error){ toast('Could not save: ' + r.error.message, 'error'); return false; }
    toast('Saved.'); await loadAll(); render(); return true;
  }
  async function delRow(table, id, title, text){
    if(!(await FC.confirm(title, text, 'Delete', 'danger'))) return false;
    const { error } = await sb.from(table).delete().eq('id', id);
    if(error){ toast('Could not delete: ' + error.message, 'error'); return false; }
    toast('Deleted.'); await loadAll(); render(); return true;
  }
  const numOrNull = v => { const t = String(v == null ? '' : v).trim(); return t === '' ? null : FC.parseNum(t); };
  function groupDialog(g){
    const body = FC.el(`<div><div class="grid2">
        <div class="field"><label for="gdName">Name</label><input id="gdName" maxlength="150" value="${esc(g ? g.name : '')}"></div>
        <div class="field"><label for="gdKind">Type</label><select id="gdKind"><option value="spot" ${g && g.kind === 'spot' ? 'selected' : ''}>Spot / one-off clients</option><option value="open_cover" ${!g || g.kind === 'open_cover' ? 'selected' : ''}>Open cover client</option></select></div>
        <div class="field"><label for="gdDom">E-mail domains <span class="muted">(comma separated, e.g. bertling.com)</span></label><input id="gdDom" value="${esc(g ? (g.email_domains || []).join(', ') : '')}"></div>
        <div class="field"><label for="gdSort">Sort</label><input id="gdSort" inputmode="numeric" value="${esc(g ? g.sort : 100)}"></div></div>
      <label class="switch"><input type="checkbox" id="gdShow" ${!g || g.show_premium ? 'checked' : ''}><span><b>Client sees the indicative premium</b><span>Off: the portal only takes declarations and requests. Rates and premiums stay in the internal area until you send a quotation.</span></span></label>
      <div class="field" style="margin-top:12px"><label for="gdNotes">Internal notes</label><textarea id="gdNotes" rows="2" maxlength="1000">${esc(g ? g.notes || '' : '')}</textarea></div>
      <div class="err-msg" id="gdErr"></div></div>`);
    const actions = [{ label:'Cancel', kind:'ghost', value:null }];
    if(g) actions.unshift({ label:'Delete group', kind:'danger', onClick: async () => (await delRow('client_groups', g.id, 'Delete the group ' + g.name + '?', 'Its policies and offices are deleted too. Users keep their account but lose the assignment.')) ? true : undefined });
    actions.push({ label:'Save', kind:'primary', onClick: async () => {
      const name = body.querySelector('#gdName').value.trim(); if(!name){ body.querySelector('#gdErr').textContent = 'Name required.'; return; }
      const doms = body.querySelector('#gdDom').value.split(/[,;\s]+/).map(x => x.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
      if(doms.some(d => !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d))){ body.querySelector('#gdErr').textContent = 'Please enter domains like bertling.com.'; return; }
      const row = { name, kind: body.querySelector('#gdKind').value, show_premium: body.querySelector('#gdShow').checked, email_domains: doms, notes: body.querySelector('#gdNotes').value.trim() || null, sort: Number(body.querySelector('#gdSort').value) || 100 };
      return (await saveRow('client_groups', row, g && g.id)) ? true : undefined;
    } });
    FC.dialog({ title: g ? 'Client group' : 'New client group', body, actions });
  }
  function policyDialog(po, groupId){
    const R = Object.assign({}, (po && po.rules) || {}), rv = (path) => { let v = R; path.forEach(k => v = v && v[k]); return v == null ? '' : v; }, rd = (path) => { let v = RULE_DEF; path.forEach(k => v = v && v[k]); return v == null ? 'on request' : v; };
    const rIn = (id, path, label) => `<div class="field"><label for="${id}">${label}</label><input id="${id}" data-rule="${path.join('.')}" inputmode="decimal" value="${esc(rv(path))}" placeholder="${esc(rd(path))}"></div>`;
    const secRow = x => `<div class="gp-sec"><input class="sc-ins" placeholder="Insurer" value="${esc(x.insurer || '')}"><input class="sc-share" inputmode="decimal" placeholder="%" value="${esc(x.share ?? '')}"><label class="xs"><input type="checkbox" class="sc-lead" ${x.lead ? 'checked' : ''} style="width:auto;min-width:0"> Lead</label><button type="button" class="linkbtn sc-del">Remove</button></div>`;
    const body = FC.el(`<div><div class="grid3">
        <div class="field"><label for="pdName">Name</label><input id="pdName" maxlength="150" value="${esc(po ? po.name : '')}" placeholder="e.g. Bertling Global"></div>
        <div class="field"><label for="pdNo">Policy number</label><input id="pdNo" maxlength="60" value="${esc(po ? po.policy_no || '' : '')}"></div>
        <div class="field"><label for="pdGroup">Client group</label><select id="pdGroup">${S.groups.map(g => `<option value="${g.id}" ${g.id === (po ? po.group_id : groupId) ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></div>
        <div class="field" style="grid-column:1/-1"><label for="pdHolder">Policyholder (as on the policy)</label><input id="pdHolder" maxlength="300" value="${esc(po ? po.policyholder || '' : '')}"></div>
        <div class="field"><label for="pdCur">Base currency</label><select id="pdCur">${['EUR','USD','GBP'].map(c => `<option ${po && po.currency === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
        <div class="field"><label for="pdMin">Minimum premium</label><input id="pdMin" inputmode="decimal" value="${esc(po ? po.min_premium : 100)}"></div>
        <div class="field"><label for="pdDed">Deductible (each and every loss)</label><input id="pdDed" inputmode="decimal" value="${esc(po ? po.deductible ?? '' : 100)}"></div>
        <div class="field"><label for="pdL1">Limit any one conveyance / storage</label><input id="pdL1" inputmode="decimal" value="${esc(po ? po.limit_conveyance ?? '' : '')}"></div>
        <div class="field"><label for="pdL2">Limit on deck / barge</label><input id="pdL2" inputmode="decimal" value="${esc(po ? po.limit_on_deck ?? '' : '')}"></div>
        <div class="field"><label for="pdL3">Limit parcel post / mail</label><input id="pdL3" inputmode="decimal" value="${esc(po ? po.limit_post ?? '' : '')}"></div>
        <div class="field"><label for="pdRating">Rating</label><select id="pdRating"><option value="schedule" ${!po || po.rating === 'schedule' ? 'selected' : ''}>Policy schedules (zone matrices as they stand)</option><option value="standard" ${po && po.rating === 'standard' ? 'selected' : ''}>Standard FREIGHTCON rating</option></select></div>
        <div class="field"><label for="pdVia">Placed via</label><input id="pdVia" maxlength="150" value="${esc(po ? po.placed_via || '' : '')}" placeholder="e.g. Assekuranz-Kontor Montan GmbH"></div>
        <div class="field"><label for="pdSort">Sort</label><input id="pdSort" inputmode="numeric" value="${esc(po ? po.sort : 100)}"></div></div>
      <h3 style="margin:16px 0 6px">Security</h3><p class="xs muted" style="margin:0 0 8px">Internal only — never shown to clients or on slips.</p>
      <div id="pdSec">${((po && po.security) || []).map(secRow).join('')}</div><button type="button" class="btn btn-ghost btn-sm" id="pdSecAdd" style="margin-top:6px">+ Add insurer</button> <span class="xs" id="pdSecSum"></span>
      <h3 style="margin:18px 0 6px">Schedule rules</h3><p class="xs muted" style="margin:0 0 8px">Only used with “Policy schedules”. Empty = the value shown in grey (Bertling 2025).</p>
      <div class="grid3">
        ${rIn('ruC', ['icc_c_pct'], 'ICC (C): % of schedule rate')}${rIn('ruI', ['interest_pct'], "Seller's / buyer's interest: % of rate")}${rIn('ruD', ['deck_loading_pct'], 'Conventional on deck: loading %')}
        ${rIn('ruW', ['air_war_permille'], 'Air: war &amp; strikes A.P. ‰')}${rIn('ruAU', ['air_freight', 'used_pct'], 'Airfreight: used goods loading %')}${rIn('ruAC', ['air_freight', 'cars_pct'], 'Airfreight: cars loading %')}
        ${rIn('ruAH', ['air_freight', 'household_permille'], 'Airfreight: household goods flat ‰')}${rIn('ruCU', ['air_charter', 'used_pct'], 'Air charter: used goods loading %')}${rIn('ruCC', ['air_charter', 'cars_pct'], 'Air charter: cars loading %')}</div>
      <label class="switch"><input type="checkbox" id="pdActive" ${!po || po.active ? 'checked' : ''}><span><b>Active</b><span>Inactive policies send every shipment to the brokers.</span></span></label>
      <div class="field" style="margin-top:12px"><label for="pdNotes">Internal notes</label><textarea id="pdNotes" rows="2" maxlength="2000">${esc(po ? po.notes || '' : '')}</textarea></div>
      <div class="err-msg" id="pdErr"></div></div>`);
    const secHost = body.querySelector('#pdSec');
    const sum = () => { const t = Array.from(secHost.querySelectorAll('.sc-share')).reduce((a, i) => a + (FC.parseNum(i.value) || 0), 0); body.querySelector('#pdSecSum').innerHTML = secHost.children.length ? `Total <b>${Math.round(t * 100) / 100} %</b>${Math.abs(t - 100) > 0.001 ? ' <span class="chip declined">should be 100 %</span>' : ''}` : ''; };
    secHost.addEventListener('input', sum); secHost.addEventListener('click', e => { if(e.target.closest('.sc-del')){ e.target.closest('.gp-sec').remove(); sum(); } });
    body.querySelector('#pdSecAdd').addEventListener('click', () => { secHost.appendChild(FC.el(secRow({}))); sum(); }); sum();
    const actions = [{ label:'Cancel', kind:'ghost', value:null }];
    if(po) actions.unshift({ label:'Delete policy', kind:'danger', onClick: async () => (await delRow('policies', po.id, 'Delete ' + po.name + '?', 'Its offices are deleted too. Past shipments keep their figures.')) ? true : undefined });
    actions.push({ label:'Save', kind:'primary', onClick: async () => {
      const err = t => { body.querySelector('#pdErr').textContent = t; };
      const v = id => body.querySelector(id).value.trim();
      if(!v('#pdName')) return err('Name required.');
      const nums = { min_premium: numOrNull(v('#pdMin')), deductible: numOrNull(v('#pdDed')), limit_conveyance: numOrNull(v('#pdL1')), limit_on_deck: numOrNull(v('#pdL2')), limit_post: numOrNull(v('#pdL3')) };
      if(nums.min_premium == null) return err('Minimum premium required (0 is allowed).');
      if(Object.values(nums).some(x => x != null && !(x >= 0))) return err('Amounts must be numbers of 0 or more.');
      const security = Array.from(secHost.querySelectorAll('.gp-sec')).map(r => ({ insurer: r.querySelector('.sc-ins').value.trim(), share: FC.parseNum(r.querySelector('.sc-share').value), lead: r.querySelector('.sc-lead').checked })).filter(x => x.insurer);
      if(security.some(x => !(x.share > 0 && x.share <= 100))) return err('Every insurer needs a share between 0 and 100 %.');
      security.forEach(x => { if(!x.lead) delete x.lead; });
      const rules = {};
      for(const inp of body.querySelectorAll('[data-rule]')){
        const t = inp.value.trim(); if(t === '') continue; const n = FC.parseNum(t); if(!(n >= 0)) return err('Schedule rules must be numbers of 0 or more.');
        const path = inp.dataset.rule.split('.'); let o = rules; path.slice(0, -1).forEach(k => o = o[k] = o[k] || {}); o[path[path.length - 1]] = n;
      }
      const row = Object.assign({ name: v('#pdName'), policy_no: v('#pdNo') || null, group_id: Number(v('#pdGroup')), policyholder: v('#pdHolder') || null, currency: v('#pdCur'),
        rating: v('#pdRating'), placed_via: v('#pdVia') || null, security, rules, active: body.querySelector('#pdActive').checked, notes: v('#pdNotes') || null, sort: Number(v('#pdSort')) || 100 }, nums);
      const sibs = po ? S.policies.filter(x => x.group_id === row.group_id && x.id !== po.id) : [];
      const rulesChanged = po && (JSON.stringify(po.rules || {}) !== JSON.stringify(rules) || po.rating !== row.rating);
      if(!(await saveRow('policies', row, po && po.id))) return;
      if(rulesChanged && sibs.length && await FC.confirm('Also apply to ' + sibs.map(x => x.name).join(', ') + '?', 'Copies the schedule rules (and rating) to the sibling polic' + (sibs.length > 1 ? 'ies' : 'y') + '. Policy number, currency, limits, minimum premium, deductible and security stay as they are.', 'Apply to siblings')){
        for(const sb2 of sibs){ const { error } = await sb.from('policies').update({ rules, rating: row.rating }).eq('id', sb2.id); if(error) toast(error.message, 'error'); }
        toast('Rules applied to ' + sibs.length + ' sibling polic' + (sibs.length > 1 ? 'ies' : 'y') + '.'); await loadAll(); render();
      }
      return true;
    } });
    FC.dialog({ title: po ? po.name : 'New policy', wide:true, body, actions });
  }
  function officeDialog(o, policyId){
    const po = polOf(o ? o.policy_id : policyId) || {};
    const body = FC.el(`<div><div class="grid2">
        <div class="field" style="grid-column:1/-1"><label for="odName">Entity / office name</label><input id="odName" maxlength="200" value="${esc(o ? o.name : '')}"></div>
        <div class="field"><label for="odLoc">City / location</label><input id="odLoc" maxlength="200" value="${esc(o ? o.location || '' : '')}"></div>
        <div class="field"><label for="odCty">Country</label><select id="odCty"><option value="">—</option>${S.countries.map(c => `<option value="${c.iso2}" ${o && o.country === c.iso2 ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
        <div class="field"><label for="odKind">Type</label><select id="odKind">${Object.entries(KIND).map(([k, l]) => `<option value="${k}" ${o && o.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field"><label for="odPol">Policy</label><select id="odPol">${S.policies.map(x => `<option value="${x.id}" ${x.id === po.id ? 'selected' : ''}>${esc(x.name)} ${esc(x.policy_no || '')} (${esc(x.currency)})</option>`).join('')}</select></div>
        <div class="field"><label for="odSub">Subcategory <span class="muted">(e.g. Singapore)</span></label><input id="odSub" maxlength="60" value="${esc(o ? o.subcategory || '' : '')}"></div>
        <div class="field"><label for="odSort">Sort</label><input id="odSort" inputmode="numeric" value="${esc(o ? o.sort : 100)}"></div>
        <div class="field"><label for="odMin">Minimum premium <span class="muted">(empty = policy: ${esc(amt(po.min_premium, po.currency))})</span></label><input id="odMin" inputmode="decimal" value="${esc(o ? o.min_premium ?? '' : '')}"></div>
        <div class="field"><label for="odDed">Deductible <span class="muted">(empty = policy: ${esc(amt(po.deductible, po.currency))})</span></label><input id="odDed" inputmode="decimal" value="${esc(o ? o.deductible ?? '' : '')}"></div>
        <div class="field" style="grid-column:1/-1"><label for="odCon">Contacts <span class="muted">(internal only)</span></label><input id="odCon" maxlength="500" value="${esc(o ? o.contacts || '' : '')}"></div></div>
      <label class="switch"><input type="checkbox" id="odActive" ${!o || o.active ? 'checked' : ''}><span><b>Active</b><span>Inactive offices cannot be chosen for new shipments.</span></span></label>
      <div class="err-msg" id="odErr"></div></div>`);
    const actions = [{ label:'Cancel', kind:'ghost', value:null }];
    if(o) actions.unshift({ label:'Delete', kind:'danger', onClick: async () => (await delRow('offices', o.id, 'Delete ' + o.name + '?', 'Users of this office must choose a new one. Past shipments keep their figures.')) ? true : undefined });
    actions.push({ label:'Save', kind:'primary', onClick: async () => {
      const v = id => body.querySelector(id).value.trim();
      if(!v('#odName')) return void (body.querySelector('#odErr').textContent = 'Name required.');
      const mn = numOrNull(v('#odMin')), dd = numOrNull(v('#odDed'));
      if((mn != null && !(mn >= 0)) || (dd != null && !(dd >= 0))) return void (body.querySelector('#odErr').textContent = 'Amounts must be numbers of 0 or more, or empty.');
      const row = { name: v('#odName'), location: v('#odLoc') || null, country: v('#odCty') || null, kind: v('#odKind'), policy_id: Number(v('#odPol')), subcategory: v('#odSub') || null,
        min_premium: mn, deductible: dd, contacts: v('#odCon') || null, active: body.querySelector('#odActive').checked, sort: Number(v('#odSort')) || 100 };
      return (await saveRow('offices', row, o && o.id)) ? true : undefined;
    } });
    FC.dialog({ title: o ? o.name : 'New office / entity', wide:true, body, actions });
  }
  async function upd(id, patch){
    const { error } = await sb.from('profiles').update(patch).eq('id', id);
    if(error){ toast('Could not save: ' + error.message, 'error'); return false; }
    toast('Saved.'); await loadAll(); render(); return true;
  }
  function editCustomer(p){
    const body = FC.el(`<div><dl class="kv"><dt>E-mail</dt><dd>${esc(p.email)}</dd><dt>Registered</dt><dd>${esc(FC.dateTime(p.created_at))}</dd><dt>Referral code</dt><dd>${esc(p.referral_code || '')}</dd>${p.deletion_requested_at ? `<dt>Deletion requested</dt><dd>${esc(FC.dateTime(p.deletion_requested_at))}</dd>` : ''}</dl>
      <div class="grid2" style="margin-top:14px">
        <div class="field"><label for="ecFirst">First name</label><input id="ecFirst" maxlength="60" value="${esc(p.first_name || (p.full_name || '').split(' ')[0] || '')}"></div>
        <div class="field"><label for="ecLast">Last name</label><input id="ecLast" maxlength="60" value="${esc(p.last_name || (p.full_name || '').split(' ').slice(1).join(' ') || '')}"></div>
        <div class="field"><label for="ecCo">Company</label><input id="ecCo" maxlength="150" value="${esc(p.company || '')}"></div>
        <div class="field"><label for="ecAddr">Street and number</label><input id="ecAddr" maxlength="150" value="${esc(p.address_line || '')}"></div>
        <div class="field"><label for="ecZip">Postcode and city</label><div class="grid2" style="grid-template-columns:100px 1fr"><input id="ecZip" maxlength="20" value="${esc(p.postcode || '')}"><input id="ecCity" maxlength="80" value="${esc(p.city || '')}" aria-label="City"></div></div>
        <div class="field"><label for="ecCountry">Country</label><input id="ecCountry" maxlength="80" value="${esc(p.country || '')}"></div>
        <div class="field"><label for="ecPhone">Phone</label><input id="ecPhone" maxlength="40" value="${esc(p.phone || '')}"></div>
        <div class="field"><label for="ecDisc">Client discount %</label><input id="ecDisc" inputmode="decimal" value="${esc(Number(p.client_discount_pct))}"></div>
        <div class="field"><label for="ecStatus">Access</label><select id="ecStatus"><option value="active" ${p.approved && !p.rejected ? 'selected' : ''}>Active</option><option value="waiting" ${!p.approved && !p.rejected ? 'selected' : ''}>Waiting</option><option value="rejected" ${p.rejected ? 'selected' : ''}>Rejected / blocked</option></select></div>
      </div>
      <h3 style="margin:18px 0 8px">Client group &amp; office</h3>
      <div class="grid2">
        <div class="field"><label for="ecGroup">Client group</label><select id="ecGroup"><option value="">${domainGroup(p.email) ? 'By e-mail domain: ' + esc(domainGroup(p.email).name) : 'None (spot client)'}</option>${S.groups.map(g => `<option value="${g.id}" ${p.group_id === g.id ? 'selected' : ''}>${esc(g.name)}${g.kind === 'open_cover' ? ' (open cover)' : ''}</option>`).join('')}</select></div>
        <div class="field"><label for="ecOffice">Office / entity</label><select id="ecOffice"></select></div>
        <div class="field"><label for="ecMin">Minimum premium for this user <span class="muted">(empty = office / policy)</span></label><input id="ecMin" inputmode="decimal" value="${esc(p.min_premium_override ?? '')}"></div>
        <div class="field"><label for="ecDed">Deductible for this user <span class="muted">(empty = office / policy)</span></label><input id="ecDed" inputmode="decimal" value="${esc(p.deductible_override ?? '')}"></div>
      </div>
      <p class="xs muted" id="ecEff" style="margin:-4px 0 0"></p>
      <div class="field" style="margin-top:12px"><label for="ecNote">Internal note</label><textarea id="ecNote" rows="2" maxlength="1000">${esc(p.internal_note || '')}</textarea></div>
      <label class="switch"><input type="checkbox" id="ecAdmin" ${p.is_admin ? 'checked' : ''} ${p.id === me().id ? 'disabled' : ''}><span><b>Staff access (Internal area)</b><span>Sees all customers, rates and requests.</span></span></label>
      <div class="err-msg" id="ecErr"></div></div>`);
    const gSel = body.querySelector('#ecGroup'), oSel = body.querySelector('#ecOffice');
    const paintOffices = () => {
      const gid = Number(gSel.value) || (domainGroup(p.email) || {}).id || null;
      const pols = S.policies.filter(po => !gid || po.group_id === gid);
      oSel.innerHTML = `<option value="">No office</option>` + pols.map(po => `<optgroup label="${esc(po.name + (po.policy_no ? ' · ' + po.policy_no : '') + ' · ' + po.currency)}">${S.offices.filter(o => o.policy_id === po.id).map(o => `<option value="${o.id}" ${p.office_id === o.id ? 'selected' : ''}>${esc(o.name)}${o.location ? ' — ' + esc(o.location) : ''}${o.active ? '' : ' (inactive)'}</option>`).join('')}</optgroup>`).join('');
      paintEff();
    };
    const paintEff = () => {
      const o = ofcOf(Number(oSel.value)), po = o && polOf(o.policy_id), x = Object.assign({}, p, { min_premium_override: body.querySelector('#ecMin').value.trim() === '' ? null : FC.parseNum(body.querySelector('#ecMin').value), deductible_override: body.querySelector('#ecDed').value.trim() === '' ? null : FC.parseNum(body.querySelector('#ecDed').value) });
      body.querySelector('#ecEff').textContent = po ? `Applies: ${po.name} ${po.policy_no || ''} in ${po.currency} · minimum premium ${amt(effMin(po, o, x), po.currency)} · deductible ${amt(effDed(po, o, x), po.currency)}` : (x.min_premium_override != null ? 'Spot client: minimum premium ' + x.min_premium_override + ' in the shipment currency.' : 'Spot client: standard FREIGHTCON rating.');
    };
    gSel.addEventListener('change', paintOffices); oSel.addEventListener('change', paintEff);
    body.querySelector('#ecMin').addEventListener('input', paintEff); body.querySelector('#ecDed').addEventListener('input', paintEff);
    paintOffices();
    FC.dialog({ title: p.company || p.email, wide:true, body, actions:[{ label:'Cancel', kind:'ghost', value:null }, { label:'Save', kind:'primary', onClick: async () => {
      const disc = FC.parseNum(body.querySelector('#ecDisc').value);
      const minO = body.querySelector('#ecMin').value.trim(), dedO = body.querySelector('#ecDed').value.trim();
      if((minO && !(FC.parseNum(minO) >= 0)) || (dedO && !(FC.parseNum(dedO) >= 0))){ body.querySelector('#ecErr').textContent = 'Minimum premium and deductible must be numbers (or empty).'; return; }
      const offId = Number(oSel.value) || null, offPol = offId && polOf(ofcOf(offId).policy_id);
      if(!(disc >= 0 && disc < 100)){ body.querySelector('#ecErr').textContent = 'The discount must be between 0 and 99.99 %.'; return; }
      const st = body.querySelector('#ecStatus').value;
      const fn = body.querySelector('#ecFirst').value.trim(), ln = body.querySelector('#ecLast').value.trim();
      const patch = { full_name: [fn, ln].filter(Boolean).join(' ') || null, first_name: fn || null, last_name: ln || null, address_line: body.querySelector('#ecAddr').value.trim() || null, postcode: body.querySelector('#ecZip').value.trim() || null, city: body.querySelector('#ecCity').value.trim() || null, company: body.querySelector('#ecCo').value.trim() || null, country: body.querySelector('#ecCountry').value.trim() || null,
        phone: body.querySelector('#ecPhone').value.trim() || null, client_discount_pct: disc, internal_note: body.querySelector('#ecNote').value.trim() || null,
        approved: st === 'active', rejected: st === 'rejected',
        group_id: offPol ? offPol.group_id : (Number(gSel.value) || null), office_id: offId,
        min_premium_override: minO ? FC.parseNum(minO) : null, deductible_override: dedO ? FC.parseNum(dedO) : null };
      if(p.id !== me().id) patch.is_admin = body.querySelector('#ecAdmin').checked;
      return (await upd(p.id, patch)) ? true : undefined;
    } }] });
  }

  // =================================================================== RATES
  let rateTab = 'tables', curTable = null, rtUnlocked = false;
  // per mille fields: a comma is always the decimal separator here (3,575 = 3.575, never 3575)
  const ppm = v => { const t = String(v == null ? '' : v).trim().replace(/\s/g, '').replace(/\.(?=.*,)/g, '').replace(',', '.'); return t === '' ? NaN : Number(t); };
  const pm = v => v == null || v === '' || !isFinite(Number(v)) ? '' : Number(v).toLocaleString('de-DE', { minimumFractionDigits:2, maximumFractionDigits:4 });
  // locked data: every change needs a reason and lands in the change log
  function askReason(summary){
    return FC.dialog({ title:'Reason for this change', body:`<p class="small" style="margin:0 0 10px">${esc(summary)}</p><div class="field"><label for="rsTxt">Reason <span class="muted">(shown in the change log with your name and the date)</span></label><textarea id="rsTxt" rows="3" maxlength="500" placeholder="e.g. Renewal 2027 agreed with AKM, e-mail of 12 Nov"></textarea></div><div class="err-msg" id="rsErr"></div>`,
      actions:[{ label:'Cancel', kind:'ghost', value:null }, { label:'Save with reason', kind:'primary', onClick: async (c, box) => { const t = box.querySelector('#rsTxt').value.trim(); if(t.length < 3){ box.querySelector('#rsErr').textContent = 'Please give a short reason.'; return; } return t; } }] });
  }
  const auditFoot = (entity, id, n) => {
    const rows = S.audit.filter(a => a.entity === entity && (id == null || a.entity_id === id)).slice(0, n || 5);
    return rows.length ? `<div class="audit-foot"><b>Change log</b>${rows.map(a => `<div><span class="xs muted">${esc(FC.dateTime(a.at))} · ${esc(a.user_name || '')}</span><br>${esc(a.summary)}<br><i>Reason: ${esc(a.reason || '—')}</i></div>`).join('')}</div>` : `<div class="audit-foot"><b>Change log</b><div class="xs muted">No changes recorded yet.</div></div>`;
  };
  // =================================================================== CLAUSES
  const CL_CAT = [['header','1 · Opening & policy header'],['general','2 · General conditions'],['sanctions','3 · German / EU market sanctions'],['pricing','4 · Pricing, valuation & minimum premium'],['disclaimer','5 · Disclaimer'],['special','6 · Special conditions'],['subjectivity','7 · Subjectivities & warranties']];
  // is a clause ticked by default for this policy (spot: the library default)
  const clauseOn = (c, policyId) => { if(!policyId) return !!c.default_spot; const x = S.polClauses.find(pc => pc.policy_id === policyId && pc.clause_id === c.id); return x ? !!x.enabled : !!c.default_spot; };
  A.clauseOn = clauseOn;
  let clTab = 'policy', clPolicy = null;
  function renderClauses(body){
    body.innerHTML = `<p class="small muted" style="margin:0 0 14px">One clause library for every client, in seven categories. Per open cover policy you tick which clauses go into a quotation by default; spot quotations start from the library defaults. Brokers can still tick, untick and edit every clause in the quotation editor. Vessel clauses are left out automatically for road and rail.</p>
      <div class="tabs" role="tablist">${[['policy','Defaults per policy'],['library','Library']].map(([k, l]) => `<button role="tab" data-cltab="${k}" aria-selected="${k === clTab}">${l}</button>`).join('')}</div><div id="clBody"></div>`;
    $$('[data-cltab]', body).forEach(b => b.addEventListener('click', () => { clTab = b.dataset.cltab; renderClauses(body); }));
    const host = $('#clBody', body);
    if(clTab === 'library') return clLibrary(host);
    clDefaults(host);
  }
  function clLibrary(host){
    editTable(host, { table:'clause_library', key:'id', search:true, rows:S.clauses,
      add: () => ({ id: undefined, category:'general', title:'', body:'', maritime:false, default_spot:false, active:true, sort:100 }),
      cols:[ { k:'category', l:'Category', type:'select', options: CL_CAT }, { k:'title', l:'Title', w:220 }, { k:'body', l:'Wording ({policy_no}, {assured}, {ref}, {currency} are filled in)', w:520 },
        { k:'maritime', l:'Vessel / sea clause', type:'bool' }, { k:'default_spot', l:'Default for spot', type:'bool' }, { k:'active', l:'Active', type:'bool' }, { k:'sort', l:'Sort', type:'num' } ],
      keyOptional:true });
  }
  function clDefaults(host){
    if(!S.policies.length){ host.innerHTML = '<div class="empty card"><h3>No policies yet</h3><p>Add an open cover policy under Customers → Client groups.</p></div>'; return; }
    if(!clPolicy || !polOf(clPolicy)) clPolicy = S.policies[0].id;
    const po = polOf(clPolicy), sibs = S.policies.filter(x => x.group_id === po.group_id && x.id !== po.id);
    const bar = FC.el(`<div class="toolbar"><select class="input" id="clPol">${S.policies.map(x => `<option value="${x.id}" ${x.id === clPolicy ? 'selected' : ''}>${esc(x.name)} ${esc(x.policy_no || '')}</option>`).join('')}</select><span style="flex:1"></span>
      ${sibs.length ? `<label class="small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="clSync" style="width:auto;min-width:0"> Also apply to ${esc(sibs.map(x => x.name).join(', '))}</label>` : ''}
      <button class="btn btn-primary btn-sm" id="clSave" disabled><span class="spin"></span>Save</button></div>`);
    host.appendChild(bar);
    const list = FC.el('<div class="cl-cols"></div>'); host.appendChild(list);
    CL_CAT.forEach(([cat, label]) => {
      const items = S.clauses.filter(c => c.category === cat && c.active);
      if(!items.length) return;
      list.appendChild(FC.el(`<section class="card cl-cat"><h3>${esc(label)}</h3>${items.map(c => `<label class="cl-item"><input type="checkbox" data-cid="${c.id}" ${clauseOn(c, po.id) ? 'checked' : ''}><span><b>${esc(c.title)}</b>${c.maritime ? ' <span class="chip neutral">sea</span>' : ''}<span>${esc(c.body)}</span></span></label>`).join('')}</section>`));
    });
    const save = bar.querySelector('#clSave');
    list.addEventListener('change', () => { save.disabled = false; });
    bar.querySelector('#clPol').addEventListener('change', e => { clPolicy = Number(e.target.value); host.innerHTML = ''; clDefaults(host); });
    save.addEventListener('click', async () => {
      const ticks = Array.from(list.querySelectorAll('[data-cid]')).map(i => ({ clause_id: Number(i.dataset.cid), enabled: i.checked }));
      const targets = [po.id].concat(bar.querySelector('#clSync') && bar.querySelector('#clSync').checked ? sibs.map(x => x.id) : []);
      busy(save, true);
      for(const pid of targets){
        for(const t of ticks){
          const ex = S.polClauses.find(pc => pc.policy_id === pid && pc.clause_id === t.clause_id);
          const res = ex ? await sb.from('policy_clauses').update({ enabled: t.enabled }).eq('policy_id', pid).eq('clause_id', t.clause_id) : await sb.from('policy_clauses').insert({ policy_id: pid, clause_id: t.clause_id, enabled: t.enabled });
          if(res.error){ busy(save, false); return toast('Could not save: ' + res.error.message, 'error'); }
        }
      }
      busy(save, false); toast('Saved for ' + targets.length + ' polic' + (targets.length > 1 ? 'ies' : 'y') + '.'); await loadAll(); host.innerHTML = ''; clDefaults(host);
    });
  }
  // copy the terms of one policy to another — never its number, currency, limits, minimum premium, deductible or security
  async function copyTerms(fromId, toIds){
    const src = polOf(fromId); if(!src) return false;
    for(const tid of toIds){
      let r = await sb.from('policies').update({ rules: src.rules || {}, rating: src.rating }).eq('id', tid); if(r.error){ toast(r.error.message, 'error'); return false; }
      for(const c of S.clauses){
        const on = clauseOn(c, src.id), ex = S.polClauses.find(pc => pc.policy_id === tid && pc.clause_id === c.id);
        r = ex ? await sb.from('policy_clauses').update({ enabled: on }).eq('policy_id', tid).eq('clause_id', c.id) : await sb.from('policy_clauses').insert({ policy_id: tid, clause_id: c.id, enabled: on });
        if(r.error){ toast(r.error.message, 'error'); return false; }
      }
      for(const x of S.warEx.filter(x => x.policy_id === tid)){ await sb.from('war_exclusions').delete().eq('id', x.id); }
      for(const x of S.warEx.filter(x => x.policy_id === src.id)){
        r = await sb.from('war_exclusions').insert({ policy_id: tid, area_code: x.area_code, buyback_permille: x.buyback_permille, ncb_pct: x.ncb_pct, active: x.active, note: x.note });
        if(r.error){ toast(r.error.message, 'error'); return false; }
      }
    }
    return true;
  }
  function copyTermsDialog(po){
    const others = S.policies.filter(x => x.id !== po.id);
    if(!others.length) return toast('There is no other policy to copy from.');
    FC.dialog({ title:'Copy terms to ' + po.name, body:`<p class="small" style="margin-top:0">Copies the schedule rules, the clause defaults and the policy's own war &amp; strikes exclusions. <b>Never copied:</b> policy number, currency, limits, minimum premium, deductible and security.</p><div class="field"><label for="ctFrom">Copy from</label><select id="ctFrom">${others.map(x => `<option value="${x.id}">${esc(x.name)} ${esc(x.policy_no || '')}</option>`).join('')}</select></div>`,
      actions:[{ label:'Cancel', kind:'ghost', value:null }, { label:'Copy terms', kind:'primary', onClick: async (c, box) => { const ok = await copyTerms(Number(box.querySelector('#ctFrom').value), [po.id]); if(ok){ toast('Terms copied.'); await loadAll(); render(); return true; } } }] });
  }

  // ---- war & strikes lifted / excluded areas and buy-back terms ----
  function rtWar(host){
    host.appendChild(FC.el(`<p class="small muted" style="margin:0 0 12px">Areas where war &amp; strikes cover is lifted. A coast is matched by the port typed in the shipment (no or unknown port = every coast of that country counts). A sea is matched by its ports, its littoral countries, a transit country, or routing via Suez. The rate is never reduced; a buy-back loading (less no-claims bonus) gives a second rate with war &amp; strikes re-included.</p><h3 style="margin:0 0 8px">Areas</h3>`));
    editTable(host, { table:'war_areas', key:'code', search:false,
      rows: S.warAreas.map(a => Object.assign({}, a, { countries: (a.countries || []).join(', '), ports: (a.ports || []).join(', ') })),
      add: () => ({ code:'', name:'', kind:'coast', country:'', countries:'', ports:'', sort:100 }),
      cols:[ { k:'code', l:'Code', ro:true, w:90 }, { k:'name', l:'Name (shown to clients)', w:240 }, { k:'kind', l:'Type', type:'select', options:[['coast', 'Coast of a country'], ['sea', 'Sea']] },
        { k:'country', l:'Country (coast)', w:60 }, { k:'countries', l:'Littoral countries (sea)', w:150 }, { k:'ports', l:'Ports / places', w:360 }, { k:'note', l:'Note', w:200 }, { k:'sort', l:'Sort', type:'num' } ],
      clean: r => { ['countries','ports'].forEach(k => { if(k in r) r[k] = String(r[k] || '').split(',').map(x => x.trim()).filter(Boolean).map(x => k === 'countries' ? x.toUpperCase() : x); }); if('country' in r) r.country = (r.country || '').toUpperCase() || null; if('code' in r) r.code = String(r.code || '').toLowerCase().replace(/[^a-z0-9_]/g, '_'); return r; } });
    const scopes = [].concat(S.groups.filter(g => g.kind === 'open_cover').map(g => ['g' + g.id, 'All policies of ' + g.name + ' (blanket)']), S.policies.map(po => ['p' + po.id, 'Policy ' + po.name + (po.policy_no ? ' ' + po.policy_no : '')]));
    const card = FC.el(`<div style="margin-top:22px"><h3 style="margin:0 0 8px">Exclusions and buy-back terms</h3><div class="toolbar"><span style="flex:1"></span><button class="btn btn-ghost btn-sm" type="button" id="wxAdd">Add exclusion</button><button class="btn btn-primary btn-sm" type="button" id="wxSave" disabled><span class="spin"></span>Save changes</button></div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Applies to</th><th>Area</th><th>Buy-back gross ‰</th><th>NCB %</th><th>Net ‰</th><th>Active</th><th>Note</th><th></th></tr></thead><tbody id="wxBody"></tbody></table></div>
      <p class="xs muted">Example: +0.35 % gross = 3.5 ‰, less 50 % NCB = 1.75 ‰ net (0.175 %). Empty buy-back = no terms; the case then shows "no buy-back terms set".</p></div>`);
    host.appendChild(card);
    const rows = S.warEx.map(x => Object.assign({}, x, { scope: x.group_id ? 'g' + x.group_id : 'p' + x.policy_id })), removed = [];
    const tb = card.querySelector('#wxBody'), save = card.querySelector('#wxSave');
    const net = x => x.buyback_permille == null || x.buyback_permille === '' ? '—' : pm(Number(x.buyback_permille) * (1 - Number(x.ncb_pct || 0) / 100));
    const paint = () => {
      tb.innerHTML = rows.map((x, i) => `<tr data-i="${i}"><td><select data-k="scope">${scopes.map(([v, l]) => `<option value="${v}" ${v === x.scope ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></td>
        <td><select data-k="area_code">${S.warAreas.map(a => `<option value="${esc(a.code)}" ${a.code === x.area_code ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></td>
        <td><input data-k="buyback_permille" inputmode="decimal" value="${x.buyback_permille == null ? '' : pm(x.buyback_permille)}" style="width:90px"></td>
        <td><input data-k="ncb_pct" inputmode="decimal" value="${esc(x.ncb_pct ?? 0)}" style="width:70px"></td><td class="num">${net(x)}</td>
        <td><input type="checkbox" data-k="active" ${x.active !== false ? 'checked' : ''} style="width:auto;min-width:0"></td>
        <td><input data-k="note" value="${esc(x.note || '')}" style="min-width:160px"></td><td><button type="button" class="linkbtn" data-del>Remove</button></td></tr>`).join('') || '<tr><td colspan="8" class="muted small">No exclusions.</td></tr>';
    };
    const onWx = e => { const tr = e.target.closest('tr'), k = e.target.dataset.k; if(!tr || !k) return; const x = rows[+tr.dataset.i];
      x[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; x.__dirty = true; save.disabled = false;
      if(k === 'buyback_permille' || k === 'ncb_pct'){ const v = { buyback_permille: x.buyback_permille === '' ? null : ppm(x.buyback_permille), ncb_pct: FC.parseNum(x.ncb_pct) }; tr.children[4].textContent = net(v); } };
    tb.addEventListener('input', onWx); tb.addEventListener('change', onWx);
    tb.addEventListener('click', e => { if(e.target.matches('[data-del]')){ const i = +e.target.closest('tr').dataset.i; const x = rows.splice(i, 1)[0]; if(x.id) removed.push(x.id); save.disabled = false; paint(); } });
    card.querySelector('#wxAdd').addEventListener('click', () => { if(!scopes.length || !S.warAreas.length) return toast('Add an open cover group and an area first.', 'error'); rows.push({ scope: scopes[0][0], area_code: S.warAreas[0].code, buyback_permille:null, ncb_pct:0, active:true, note:'', __dirty:true }); save.disabled = false; paint(); });
    save.addEventListener('click', async () => {
      const dirty = rows.filter(x => x.__dirty);
      for(const x of dirty){ const bb = x.buyback_permille === '' || x.buyback_permille == null ? null : ppm(x.buyback_permille), ncb = FC.parseNum(x.ncb_pct);
        if((bb != null && !(bb >= 0)) || !(ncb >= 0 && ncb <= 100)) return toast('Buy-back must be a number in ‰, NCB between 0 and 100 %.', 'error'); }
      busy(save, true);
      for(const id of removed){ const { error } = await sb.from('war_exclusions').delete().eq('id', id); if(error){ busy(save, false); return toast(error.message, 'error'); } }
      for(const x of dirty){
        const bb = x.buyback_permille === '' || x.buyback_permille == null ? null : (typeof x.buyback_permille === 'number' ? x.buyback_permille : ppm(x.buyback_permille));
        const row = { group_id: x.scope[0] === 'g' ? Number(x.scope.slice(1)) : null, policy_id: x.scope[0] === 'p' ? Number(x.scope.slice(1)) : null, area_code: x.area_code, buyback_permille: bb, ncb_pct: FC.parseNum(x.ncb_pct) || 0, active: x.active !== false, note: (x.note || '').trim() || null, updated_at: new Date().toISOString() };
        const { error } = x.id ? await sb.from('war_exclusions').update(row).eq('id', x.id) : await sb.from('war_exclusions').insert(row);
        if(error){ busy(save, false); return toast(error.message, 'error'); }
      }
      busy(save, false); toast('Saved.'); await loadAll(); host.innerHTML = ''; rtWar(host);
    });
    paint();
  }
  function rtLog(host){
    if(!S.audit.length){ host.innerHTML = '<div class="empty card"><h3>No changes yet</h3><p>Changes to schedules and zones are listed here with date, user and reason.</p></div>'; return; }
    host.innerHTML = `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Date</th><th>User</th><th>What</th><th>Change</th><th>Reason</th></tr></thead><tbody>${S.audit.map(a => `<tr><td class="xs">${esc(FC.dateTime(a.at))}</td><td>${esc(a.user_name || '')}</td><td>${esc(a.entity === 'zones' ? 'Country zones' : a.entity_id || a.entity)}</td><td class="small" style="max-width:520px">${esc(a.summary)}</td><td class="small">${esc(a.reason || '')}</td></tr>`).join('')}</tbody></table></div>`;
  }
  function renderRates(body){
    body.innerHTML = `<p class="small muted" style="margin:0 0 14px"><b>Open cover policies</b> use the schedules as they stand (incl. war &amp; strikes, never deducted) with the rules of the policy (Customers → Client groups). <b>Spot clients:</b> rate (‰ of the sum insured) = route base rate (sea / air zone matrix without war, road / rail by band) × cargo class factor × cover × conveyance × packing × on deck × theft loading (land) × extra loading; plus war &amp; strikes (strikes on land) and crisis surcharge; × interest factor for seller's / buyer's interest. Minimum premium per schedule (land: setting). Countries without a zone, local-insurance countries, sanctioned countries and amounts over the limit go on request.</p>
      <div class="tabs" role="tablist">${[['tables','Schedules (zone matrices)'],['commodities','Cargo types'],['countries','Countries & zones'],['factors','Factors & limits'],['war','War & strikes areas'],['test','Test a calculation'],['log','Change log']].map(([k, l]) => `<button role="tab" data-rtab="${k}" aria-selected="${k === rateTab}">${l}</button>`).join('')}</div><div id="rtBody"></div>`;
    $$('[data-rtab]', body).forEach(b => b.addEventListener('click', () => { rateTab = b.dataset.rtab; renderRates(body); }));
    const host = $('#rtBody', body);
    ({ tables: rtTables, commodities: rtCommodities, countries: rtCountries, factors: rtFactors, test: rtTest, log: rtLog, war: rtWar })[rateTab](host);
  }
  // generic editable table
  function editTable(host, o){
    const wrap = FC.el('<div></div>'); host.appendChild(wrap);
    let unlocked = false;
    const tbar = FC.el(`<div class="toolbar">${o.search ? '<input class="input" type="search" placeholder="Search" aria-label="Search">' : ''}<span class="spacer" style="flex:1"></span>${o.lock ? `<span class="chip neutral" data-lockchip>🔒 ${esc(o.lock.label)} locked</span><button class="btn btn-ghost btn-sm" type="button" data-unlock>Unlock ${esc(o.lock.label)}</button>` : ''}${o.add ? '<button class="btn btn-ghost btn-sm" type="button" data-add>Add row</button>' : ''}<button class="btn btn-primary btn-sm" type="button" data-save disabled><span class="spin"></span>Save changes</button></div>`);
    wrap.appendChild(tbar);
    if(o.lock) tbar.querySelector('[data-unlock]').addEventListener('click', e => { unlocked = !unlocked; e.currentTarget.textContent = (unlocked ? 'Lock ' : 'Unlock ') + o.lock.label; tbar.querySelector('[data-lockchip]').hidden = unlocked; paint(); });
    const tw = FC.el('<div class="tbl-wrap"></div>'); wrap.appendChild(tw);
    const dirty = new Map();
    const rows = o.rows.map(r => Object.assign({}, r));
    const cell = (r, c) => {
      const v = r[c.k];
      if(c.type === 'bool') return `<input type="checkbox" data-k="${c.k}" ${v ? 'checked' : ''} aria-label="${esc(c.l)}" style="width:auto;min-width:0">`;
      if(c.type === 'select') return `<select data-k="${c.k}" aria-label="${esc(c.l)}" ${o.lock && !unlocked && o.lock.cols.includes(c.k) ? 'disabled' : ''}>${c.options.map(([ov, ol]) => `<option value="${esc(ov)}" ${String(ov) === String(v) ? 'selected' : ''}>${esc(ol)}</option>`).join('')}</select>`;
      if(c.type === 'covers') return ['icc_a','icc_b','icc_c'].map(x => `<label class="xs" style="white-space:nowrap;margin-right:6px"><input type="checkbox" data-k="${c.k}" data-v="${x}" ${(v || []).includes(x) ? 'checked' : ''} style="width:auto;min-width:0"> ${x.slice(-1).toUpperCase()}</label>`).join('');
      if(c.ro && !r.__new) return esc(v == null ? '' : v);
      return `<input data-k="${c.k}" value="${esc(v == null ? '' : v)}" ${c.type === 'num' ? 'inputmode="decimal"' : ''} aria-label="${esc(c.l)}" style="${c.w ? 'min-width:' + c.w + 'px' : ''}">`;
    };
    const paint = () => {
      const s = tbar.querySelector('input[type=search]') ? tbar.querySelector('input[type=search]').value.trim().toLowerCase() : '';
      tw.innerHTML = `<table class="tbl"><thead><tr>${o.cols.map(c => `<th>${esc(c.l)}</th>`).join('')}</tr></thead><tbody></tbody></table>`;
      rows.filter(r => !s || o.cols.some(c => String(r[c.k] == null ? '' : r[c.k]).toLowerCase().includes(s))).forEach(r => {
        const tr = document.createElement('tr'); tr.innerHTML = o.cols.map(c => `<td>${cell(r, c)}</td>`).join(''); tr.__row = r;
        tr.addEventListener('input', e => onEdit(tr, e)); tr.addEventListener('change', e => onEdit(tr, e));
        tw.querySelector('tbody').appendChild(tr);
      });
    };
    const onEdit = (tr, e) => {
      const el = e.target, k = el.dataset.k; if(!k) return;
      const r = tr.__row, c = o.cols.find(x => x.k === k);
      let v;
      if(c.type === 'bool') v = el.checked;
      else if(c.type === 'covers') v = Array.from(tr.querySelectorAll(`[data-k="${k}"]:checked`)).map(x => x.dataset.v);
      else if(c.type === 'num'){ const t = el.value.trim(); v = t === '' ? null : FC.parseNum(t); if(t !== '' && !isFinite(v)){ el.classList.add('dirty'); el.style.borderColor = 'var(--danger)'; return; } el.style.borderColor = ''; }
      else v = el.value.trim();
      r[k] = v; el.classList.add('dirty'); dirty.set(r[o.key] || r, r);
      tbar.querySelector('[data-save]').disabled = false;
    };
    if(o.foot) wrap.appendChild(FC.el(o.foot));
    if(tbar.querySelector('input[type=search]')) tbar.querySelector('input[type=search]').addEventListener('input', paint);
    if(o.add) tbar.querySelector('[data-add]').addEventListener('click', () => { const r = Object.assign({ __new:true }, o.add()); rows.unshift(r); paint(); });
    tbar.querySelector('[data-save]').addEventListener('click', async e => {
      const b = e.currentTarget; busy(b, true);
      let payload = Array.from(dirty.values()).map(r => { let x = {}; o.cols.forEach(c => { if(!c.virtual && r[c.k] !== undefined) x[c.k] = r[c.k]; }); x[o.key] = r[o.key]; if(o.clean) x = o.clean(x); return x; });
      if(!o.keyOptional && payload.some(x => !x[o.key])){ busy(b, false); toast('Every row needs an ID.', 'error'); return; }
      if(o.beforeSave){ payload = await o.beforeSave(payload); if(!payload){ busy(b, false); return; } }
      const fresh = o.keyOptional ? payload.filter(x => !x[o.key]).map(x => { const y = Object.assign({}, x); delete y[o.key]; return y; }) : [];
      if(fresh.length){ const r0 = await sb.from(o.table).insert(fresh); if(r0.error){ busy(b, false); toast('Could not save: ' + r0.error.message, 'error'); return; } }
      payload = payload.filter(x => x[o.key]);
      const { error } = payload.length ? await sb.from(o.table).upsert(payload, { onConflict: o.key, defaultToNull: false }) : { error: null };
      busy(b, false);
      if(error){ toast('Could not save: ' + error.message, 'error'); return; }
      dirty.clear(); toast('Saved ' + (payload.length + fresh.length) + ' row(s).'); await loadAll(); render();
    });
    paint();
  }
  // ---- schedules: one matrix per rate table, upper triangle editable, Excel import in the Bertling layout
  // the rate breakdown in words, used in the case and in the test tab
  function explain(d){
    if(!d) return '';
    if(d.scheme === 'open_cover'){
      const parts = [['ICC (C)', d.f_cover], ['on deck', d.f_deck], ['loading', d.f_loading]].filter(([, v]) => v != null && Number(v) !== 1).map(([k, v]) => k + ' × ' + pm(v));
      const extra = [['war', d.war_permille], ['crisis', d.crisis_permille], ['HSSC', d.hssc_permille], ['LiW/DiW', d.liw_permille]].filter(([, v]) => Number(v)).map(([k, v]) => ' + ' + k + ' ' + pm(v) + ' ‰').join('');
      let t = `Open cover ${d.policy_no || ''} · ${d.table_name}, zone ${d.zone_from} → ${d.zone_to}: schedule ${pm(d.schedule_permille)} ‰${Number(d.war_included_permille) ? ' (incl. ' + pm(d.war_included_permille) + ' ‰ war & strikes, not deducted)' : ''}`;
      if(parts.length) t += ' × ' + parts.join(' × ') + ' = ' + pm(d.cargo_permille) + ' ‰';
      t += extra;
      if(Number(d.f_interest) !== 1) t += ', × interest ' + pm(d.f_interest);
      if(parts.length || extra || Number(d.f_interest) !== 1) t += ' = ' + pm(d.rate_permille) + ' ‰';
      return t + ' · min. premium ' + (d.min_premium != null ? money2(d.min_premium, d.currency) : '—');
    }
    const parts = [['class', d.f_class], ['cover', d.f_cover], ['conveyance', d.f_conveyance], ['packing', d.f_packing], ['on deck', d.f_deck], ['theft', d.f_theft], ['extra', d.f_loading]]
      .filter(([, v]) => v != null && Number(v) !== 1).map(([k, v]) => k + ' ' + pm(v));
    const route = d.mode === 'land' ? 'land ' + String(d.band || '').replace('_', '-') : 'zone ' + d.zone_from + ' → ' + d.zone_to;
    return `${d.table_name}, ${route}: base ${pm(d.base_permille)} ‰${parts.length ? ' × ' + parts.join(' × ') : ''} = ${pm(d.cargo_permille)} ‰${Number(d.hssc_permille) ? ' + HSSC ' + pm(d.hssc_permille) + ' ‰' : ''}${Number(d.liw_permille) ? ' + LiW/DiW ' + pm(d.liw_permille) + ' ‰' : ''} + ${d.mode === 'land' ? 'strikes' : 'war'} ${pm(d.war_permille)} ‰${Number(d.crisis_permille) ? ' + crisis ' + pm(d.crisis_permille) + ' ‰' : ''}${Number(d.f_interest) !== 1 ? ', × interest ' + pm(d.f_interest) : ''} = ${pm(d.rate_permille)} ‰`;
  }
  function rtTables(host){
    if(!S.rateTables.length){ host.innerHTML = '<div class="empty card"><h3>No schedules yet</h3><p>Run update_2026-10-20c.sql in Supabase.</p></div>'; return; }
    if(!curTable || !S.rateTables.find(t => t.id === curTable)) curTable = S.rateTables[0].id;
    const t = S.rateTables.find(x => x.id === curTable);
    const bar = FC.el(`<div class="toolbar"><select class="input" id="tbSel" aria-label="Schedule">${S.rateTables.map(x => `<option value="${esc(x.id)}" ${x.id === curTable ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
      <span style="flex:1"></span>${rtUnlocked ? `<label class="btn btn-ghost btn-sm" style="cursor:pointer">Import Excel sheet<input type="file" id="tbFile" accept=".xls,.xlsx" hidden></label><button class="btn btn-ghost btn-sm" id="tbLock" type="button">Lock again</button>` : `<span class="chip neutral">🔒 Locked</span><button class="btn btn-ghost btn-sm" id="tbUnlock" type="button">Unlock to edit</button>`}<button class="btn btn-primary btn-sm" id="tbSave" disabled ${rtUnlocked ? '' : 'hidden'}><span class="spin"></span>Save changes</button></div>`);
    host.appendChild(bar);
    const relock = () => { rtUnlocked = !rtUnlocked; host.innerHTML = ''; rtTables(host); };
    if(bar.querySelector('#tbUnlock')) bar.querySelector('#tbUnlock').addEventListener('click', relock);
    if(bar.querySelector('#tbLock')) bar.querySelector('#tbLock').addEventListener('click', relock);
    host.appendChild(FC.el(`<div class="grid3" style="margin-bottom:12px">
      <div class="field"><label>Minimum premium</label><input id="tbMin" inputmode="decimal" value="${esc(t.min_premium)}"></div>
      <div class="field"><label>War &amp; strikes inside the rates (‰)</label><input id="tbWar" inputmode="decimal" value="${pm(t.war_included_permille)}"></div>
      <div class="field"><label>Options</label><div class="small" style="padding-top:10px;display:flex;gap:16px;flex-wrap:wrap"><label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="tbDeck" ${t.deck_allowed ? 'checked' : ''}> On deck allowed</label><label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="tbCont" ${t.contingency_allowed ? 'checked' : ''}> Interest cover allowed</label></div></div>
      ${t.mode === 'air' ? `<div class="field"><label>Loading used goods %</label><input id="tbUsed" inputmode="decimal" value="${esc(t.used_loading_pct ?? '')}"></div><div class="field"><label>Loading cars %</label><input id="tbCars" inputmode="decimal" value="${esc(t.cars_loading_pct ?? '')}"></div><div class="field"><label>Household flat ‰ (empty = on request)</label><input id="tbHh" inputmode="decimal" value="${pm(t.household_flat_permille)}"></div>` : ''}
    </div><p class="xs muted" style="margin:-4px 0 12px">${esc(t.notes || '')} Rates in per mille (‰), valid both ways. Empty cell = quoted individually.</p>`));
    const n = t.zones, cells = {}; S.rateCells.filter(c => c.table_id === t.id).forEach(c => { cells[c.zone_a + '-' + c.zone_b] = c.permille; });
    const tw = FC.el('<div class="tbl-wrap"></div>'); host.appendChild(tw);
    let head = '<tr><th>Zone</th>'; for(let b = 1; b <= n; b++) head += `<th class="r">${b}</th>`; head += '</tr>';
    let rowsH = '';
    for(let a = 1; a <= n; a++){
      rowsH += `<tr><th>${a}</th>`;
      for(let b = 1; b <= n; b++){
        rowsH += b < a ? '<td class="muted xs" style="text-align:center">·</td>'
          : `<td style="padding:3px"><input data-a="${a}" data-b="${b}" inputmode="decimal" value="${pm(cells[a + '-' + b])}" style="min-width:52px;width:56px;text-align:right;padding:5px 6px" aria-label="Zone ${a} to ${b}"></td>`;
      }
      rowsH += '</tr>';
    }
    tw.innerHTML = `<table class="tbl">${head}${rowsH}</table>`;
    host.appendChild(FC.el(auditFoot('schedule', t.name, 5)));
    if(!rtUnlocked) host.querySelectorAll('.grid3 input, .tbl input').forEach(i => { i.disabled = true; });
    const save = bar.querySelector('#tbSave');
    host.addEventListener('input', e => { if(e.target.matches('input')){ e.target.classList.add('dirty'); save.disabled = false; } });
    host.addEventListener('change', e => { if(e.target.type === 'checkbox'){ save.disabled = false; } });
    bar.querySelector('#tbSel').addEventListener('change', e => { curTable = e.target.value; host.innerHTML = ''; rtTables(host); });
    if(bar.querySelector('#tbFile')) bar.querySelector('#tbFile').addEventListener('change', async e => {
      const f = e.target.files[0]; if(!f) return;
      try{
        if(!window.XLSX) await FC.loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
        const wb = XLSX.read(await f.arrayBuffer());
        const pick = await FC.dialog({ title:'Which sheet?', body:`<div class="field"><label for="shSel">Sheet to import into “${esc(t.name)}”</label><select id="shSel">${wb.SheetNames.map(nm => `<option>${esc(nm)}</option>`).join('')}</select></div>`,
          actions:[{ label:'Cancel', kind:'ghost', value:null }, { label:'Import', kind:'primary', onClick: async (c, box) => box.querySelector('#shSel').value }] });
        if(!pick) return;
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[pick], { header:1, raw:true });
        const hi = rows.findIndex(r => String(r[0]).trim().toLowerCase() === 'zone');
        if(hi < 0) throw new Error('No row starting with "Zone" found.');
        const cols = rows[hi].slice(1).map(Number).filter(x => x > 0);
        let count = 0;
        for(let k = hi + 1; k < rows.length && k <= hi + cols.length; k++){
          const za = Number(rows[k][0]); if(!(za > 0)) continue;
          cols.forEach((zb, ci) => { const raw = rows[k][ci + 1]; const v = typeof raw === 'number' ? raw : ppm(raw); if(!isFinite(v)) return; const a = Math.min(za, zb), b = Math.max(za, zb); const inp = tw.querySelector(`input[data-a="${a}"][data-b="${b}"]`); if(inp){ inp.value = pm(v); inp.classList.add('dirty'); count++; } });
        }
        save.disabled = false; toast(count + ' rates read. Check them and click Save changes.');
      }catch(err){ console.error(err); toast('Import failed: ' + err.message, 'error'); }
      e.target.value = '';
    });
    save.addEventListener('click', async () => {
      const num = id => { const el = host.querySelector(id); if(!el) return undefined; const x = el.value.trim(); return x === '' ? null : ppm(x); };
      const meta = { min_premium: num('#tbMin') || 0, war_included_permille: num('#tbWar') || 0, deck_allowed: host.querySelector('#tbDeck').checked, contingency_allowed: host.querySelector('#tbCont').checked };
      if(t.mode === 'air'){ meta.used_loading_pct = num('#tbUsed'); meta.cars_loading_pct = num('#tbCars'); meta.household_flat_permille = num('#tbHh'); }
      const up = [], del = []; let bad = 0;
      tw.querySelectorAll('input.dirty').forEach(inp => { const v = inp.value.trim(), a = Number(inp.dataset.a), b = Number(inp.dataset.b); if(v === '') del.push({ a, b }); else { const x = ppm(v); if(isFinite(x) && x >= 0) up.push({ a, b, v: x }); else bad++; } });
      if(bad) return toast(bad + ' cell(s) are not valid numbers.', 'error');
      const reason = await askReason(`${t.name}: ${up.length} rate(s) changed${del.length ? ', ' + del.length + ' removed' : ''}, settings checked for changes.`);
      if(!reason) return;
      busy(save, true);
      const { data, error } = await sb.rpc('admin_save_rate_table', { p_table: t.id, p_meta: meta, p_cells: up, p_removed: del, p_reason: reason });
      busy(save, false);
      if(error) return toast('Could not save: ' + error.message, 'error');
      toast(data ? data + ' change(s) saved and logged.' : 'Nothing changed.'); rtUnlocked = false; await loadAll(); host.innerHTML = ''; rtTables(host);
    });
  }
  function rtCommodities(host){
    const tables = [['', '— not by sea —']].concat(S.rateTables.filter(t => t.mode === 'sea').map(t => [t.id, t.name]));
    editTable(host, { table:'commodities', key:'id', rows:S.commodities, search:true,
      add: () => ({ id:'', name:'', group_name:'General & industrial', class_factor:1, sea_table:'sea_new', air_class:'new', allowed_covers:['icc_a','icc_b','icc_c'], active:true, on_request:false, sort:200, loading_pct:0 }),
      cols:[ { k:'id', l:'ID', ro:true, w:110 }, { k:'group_name', l:'Group', w:150 }, { k:'name', l:'Name', w:200 },
        { k:'class_factor', l:'Class factor', type:'num' },
        { k:'allowed_covers', l:'Covers', type:'covers' },
        { k:'sea_table', l:'Sea base rates (spot)', type:'select', options: tables },
        { k:'oc_class', l:'Open cover schedule', type:'select', options:[['', '— on request —'], ['new', 'New goods'], ['used', 'Used goods'], ['cars_new', 'New vehicles'], ['cars_used', 'Used vehicles'], ['household', 'Household goods']] },
        { k:'air_class', l:'By air', type:'select', options:[['', 'no'], ['new', 'yes']] },
        { k:'theft_attractive', l:'Theft-attractive', type:'bool' }, { k:'temp_controlled', l:'Temp.-controlled', type:'bool' },
        { k:'ext_hssc', l:'Offer HSSC', type:'bool' }, { k:'ext_liw', l:'Offer LiW / DiW', type:'bool' },
        { k:'loading_pct', l:'Extra loading %', type:'num' }, { k:'max_sum_insured', l:'Max. sum insured', type:'num' },
        { k:'on_request', l:'Always on request', type:'bool' }, { k:'active', l:'Active', type:'bool' }, { k:'sort', l:'Sort', type:'num' },
        { k:'deductible', l:'Deductible (shown to clients)', w:240 },
        { k:'description', l:'Description (shown to clients)', w:220 }, { k:'conditions', l:'Special conditions', w:280 } ],
      clean: r => { if(r.sea_table === '') r.sea_table = null; if(r.air_class === '') r.air_class = null; if(r.oc_class === '') r.oc_class = null; if(r.class_factor == null) r.class_factor = 1; if(r.loading_pct == null) r.loading_pct = 0; ['theft_attractive','temp_controlled','ext_hssc','ext_liw','on_request','active'].forEach(k => { if(k in r && r[k] == null) r[k] = k === 'active'; }); return r; } });
  }
  function rtCountries(host){
    const zs = n => [['', '— none —']].concat(Array.from({ length:n }, (_, i) => [String(i + 1), String(i + 1)]));
    const sea = (S.rateTables.find(t => t.mode === 'sea') || {}).zones || 19, air = (S.rateTables.find(t => t.mode === 'air') || {}).zones || 12;
    editTable(host, { table:'countries', key:'iso2', rows:S.countries.map(c => Object.assign({}, c, { sea_zone: c.sea_zone == null ? '' : String(c.sea_zone), air_zone: c.air_zone == null ? '' : String(c.air_zone) })), search:true,
      lock: { cols:['sea_zone','air_zone'], label:'zones' },
      beforeSave: async payload => {
        const changed = payload.filter(x => { const o = S.countries.find(c => c.iso2 === x.iso2) || {}; return ('sea_zone' in x && x.sea_zone !== o.sea_zone) || ('air_zone' in x && x.air_zone !== o.air_zone); });
        if(changed.length){
          const reason = await askReason(changed.length + ' countr' + (changed.length > 1 ? 'ies' : 'y') + ' moved to another zone: ' + changed.map(x => x.iso2).join(', ') + '.');
          if(!reason) return false;
          const { error } = await sb.rpc('admin_set_zones', { p_rows: changed.map(x => ({ iso2: x.iso2, sea_zone: x.sea_zone, air_zone: x.air_zone })), p_reason: reason });
          if(error){ toast('Could not save the zones: ' + error.message, 'error'); return false; }
        }
        return payload.map(x => { const y = Object.assign({}, x); delete y.sea_zone; delete y.air_zone; return y; });
      },
      cols:[ { k:'iso2', l:'ISO', ro:true }, { k:'name', l:'Name', w:170 },
        { k:'sea_zone', l:'Sea zone', type:'select', options: zs(sea) }, { k:'air_zone', l:'Air zone', type:'select', options: zs(air) },
        { k:'local_insurance', l:'Local insurance rules (*)', type:'bool' }, { k:'crisis_permille', l:'Crisis surcharge ‰', type:'num' },
        { k:'compliance', l:'Country check', type:'select', options:[['ok', 'OK'], ['local', 'Amber · licensing / local insurers'], ['hold', 'Yellow · hold covered (refer)'], ['blocked', 'Red · blocked']] },
        { k:'on_request', l:'On request', type:'bool' }, { k:'sanctioned', l:'Sanctioned', type:'bool' }, { k:'note', l:'Note', w:200 } ],
      foot: auditFoot('zones', null, 5),
      clean: r => { r.sea_zone = r.sea_zone === '' || r.sea_zone == null ? null : Number(r.sea_zone); r.air_zone = r.air_zone === '' || r.air_zone == null ? null : Number(r.air_zone); if(r.crisis_permille == null) r.crisis_permille = 0; return r; } });
  }
  function rtFactors(host){
    const cf = setting('cover_factors', {}), al = setting('auto_limit', {}), conv = setting('conveyance_factors', {}), pack = setting('packing_factors', {}), land = setting('land_rates', {});
    const inp = (attr, k, v) => `<input data-${attr}="${esc(k)}" inputmode="decimal" value="${esc(v ?? '')}">`;
    const body = FC.el(`<div class="card card-pad" style="max-width:820px">
      <h3 style="margin-bottom:6px">Cover factors</h3><p class="xs muted" style="margin:0 0 10px">Share of the cargo rate. War &amp; strikes are not affected.</p>
      <div class="grid3">${['icc_a','icc_b','icc_c'].map(k => `<div class="field"><label>${esc(FC.COVER[k].clause)}</label>${inp('cf', k, cf[k])}</div>`).join('')}</div>
      <h3 style="margin:20px 0 6px">Conveyance factors</h3><div class="grid3">${Object.entries(FC.CONVEYANCE).map(([k, v]) => `<div class="field"><label>${esc(v.label)}</label>${inp('cv', k, conv[k] ?? 1)}</div>`).join('')}</div>
      <h3 style="margin:20px 0 6px">Packing factors</h3><div class="grid3">${Object.keys(Object.assign({ '':1 }, pack)).map(k => `<div class="field"><label>${esc(k || 'Not stated')}</label>${inp('pk', k, pack[k] ?? 1)}</div>`).join('')}</div>
      <h3 style="margin:20px 0 6px">Road &amp; rail base rates (‰)</h3><div class="grid3">
        <div class="field"><label>Domestic (same country)</label>${inp('lr', 'domestic', land.domestic)}</div>
        <div class="field"><label>Regional (same sea zone)</label>${inp('lr', 'regional', land.regional)}</div>
        <div class="field"><label>Long-haul (other zone)</label>${inp('lr', 'long_haul', land.long_haul)}</div></div>
      <div class="field" style="margin-top:12px"><label>Zones connected by land (JSON: group → sea zones)</label><input id="ffGroups" value="${esc(JSON.stringify(setting('land_groups', {})))}"></div>
      <h3 style="margin:20px 0 6px">War, strikes &amp; loadings</h3><div class="grid3">
        <div class="field"><label>War &amp; strikes sea (‰)</label><input id="ffSeaWar" inputmode="decimal" value="${esc(setting('sea_war_permille', 0.5))}"></div>
        <div class="field"><label>War &amp; strikes air (‰)</label><input id="ffAirWar" inputmode="decimal" value="${esc(setting('air_war_permille', 0.5))}"></div>
        <div class="field"><label>Strikes road / rail (‰)</label><input id="ffLandSt" inputmode="decimal" value="${esc(setting('land_strikes_permille', 0.1))}"></div>
        <div class="field"><label>On-deck loading %</label><input id="ffDeck" inputmode="decimal" value="${esc(setting('deck_loading_pct', 50))}"></div>
        <div class="field"><label>Theft loading on land (factor)</label><input id="ffTheft" inputmode="decimal" value="${esc(setting('theft_land_factor', 1.5))}"></div>
        <div class="field"><label>Seller's / buyer's interest factor</label><input id="ffCont" inputmode="decimal" value="${esc(setting('contingency_factor', 0.4))}"></div></div>
      <h3 style="margin:20px 0 6px">Optional extensions</h3><p class="xs muted" style="margin:0 0 10px">Added flat to the rate in ‰ of the sum insured, only for cargo types that offer them (tab Cargo types). 0.15 ‰ = 0.015 %.</p><div class="grid3">
        <div class="field"><label>HSSC surcharge (‰)</label><input id="ffHssc" inputmode="decimal" value="${esc(((setting('extensions', {}) || {}).hssc || {}).permille ?? 0.15)}"></div>
        <div class="field"><label>LiW / DiW surcharge (‰)</label><input id="ffLiw" inputmode="decimal" value="${esc(((setting('extensions', {}) || {}).liw || {}).permille ?? 0.75)}"></div>
        <div class="field"><label>LiW / DiW deductible</label><input id="ffLiwDed" maxlength="100" value="${esc(((setting('extensions', {}) || {}).liw || {}).deductible || '0.5 % of the sum insured')}"></div></div>
      <h3 style="margin:20px 0 6px">Limits &amp; defaults</h3><div class="grid3">
        ${['EUR','USD'].map(c => `<div class="field"><label>Automatic limit ${c}</label>${inp('al', c, al[c])}</div>`).join('')}
        <div class="field"><label>Minimum premium road / rail</label><input id="ffLandMin" inputmode="decimal" value="${esc(setting('land_min_premium', 75))}"></div>
        <div class="field"><label>Default uplift %</label><input id="ffUp" inputmode="decimal" value="${esc(setting('uplift_pct', 10))}"></div>
        <div class="field"><label>Referral discount %</label><input id="ffRef" inputmode="decimal" value="${esc(setting('referral_discount_pct', 5))}"></div></div>
      <div class="field" style="margin-top:12px"><label>Default deductible (if the cargo type has none)</label><input id="ffDed" maxlength="200" value="${esc(setting('deductible_text', ''))}"></div>
      <p class="xs muted">Sea and air minimum premiums are set per schedule (tab Schedules). Cargo class factors, deductibles and limits per cargo type (tab Cargo types).</p>
      <div class="err-msg" id="ffErr"></div><div id="ffSave" style="margin-top:12px"></div></div>`);
    host.appendChild(body);
    body.querySelector('#ffSave').appendChild(btn('Save', 'primary', async b => {
      const num = el => FC.parseNum(el.value), obj = attr => { const o = {}; body.querySelectorAll(`[data-${attr}]`).forEach(i => { o[i.getAttribute('data-' + attr)] = num(i); }); return o; };
      let groups; try{ groups = JSON.parse(body.querySelector('#ffGroups').value); }catch(e){ body.querySelector('#ffErr').textContent = 'Zones connected by land: not valid JSON.'; return; }
      const vals = { cover_factors: obj('cf'), conveyance_factors: obj('cv'), packing_factors: obj('pk'), land_rates: obj('lr'), auto_limit: obj('al'), land_groups: groups,
        sea_war_permille: num(body.querySelector('#ffSeaWar')), air_war_permille: num(body.querySelector('#ffAirWar')), land_strikes_permille: num(body.querySelector('#ffLandSt')),
        deck_loading_pct: num(body.querySelector('#ffDeck')), theft_land_factor: num(body.querySelector('#ffTheft')), contingency_factor: num(body.querySelector('#ffCont')),
        land_min_premium: num(body.querySelector('#ffLandMin')), uplift_pct: num(body.querySelector('#ffUp')), referral_discount_pct: num(body.querySelector('#ffRef')),
        deductible_text: body.querySelector('#ffDed').value.trim() };
      const ex = JSON.parse(JSON.stringify(setting('extensions', {}) || {})); ex.hssc = ex.hssc || {}; ex.liw = ex.liw || {};
      ex.hssc.permille = num(body.querySelector('#ffHssc')); ex.liw.permille = num(body.querySelector('#ffLiw')); ex.liw.deductible = body.querySelector('#ffLiwDed').value.trim() || '0.5 % of the sum insured';
      if(!(ex.hssc.permille >= 0) || !(ex.liw.permille >= 0)){ body.querySelector('#ffErr').textContent = 'Extension surcharges need a value of 0 or more.'; return; }
      ex.liw.clause = 'Extended to cover loss in weight / difference in weight (shortage), subject to a deductible of ' + ex.liw.deductible + '.';
      vals.extensions = ex;
      const nums = Object.entries(vals).filter(([k]) => !['land_groups','deductible_text','extensions'].includes(k)).flatMap(([, v]) => typeof v === 'object' ? Object.values(v) : [v]);
      if(nums.some(v => !(v >= 0))){ body.querySelector('#ffErr').textContent = 'All number fields need a value of 0 or more.'; return; }
      busy(b, true);
      const { error } = await sb.from('settings').upsert(Object.entries(vals).map(([key, value]) => ({ key, value, updated_at: new Date().toISOString() })), { onConflict: 'key' });
      busy(b, false);
      if(error) return toast(error.message, 'error'); toast('Saved.'); await loadAll();
    }));
  }
  function rtTest(host){
    const com = S.commodities.filter(c => c.active), cty = S.countries;
    const body = FC.el(`<div class="card card-pad" style="max-width:760px"><p class="small muted" style="margin-top:0">Runs the real calculation as you (logged as a test case, hidden from statistics).</p>
      <div class="grid2">
        <div class="field"><label>Cargo</label><select id="ttC">${com.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></div>
        <div class="field"><label>Conveyance</label><select id="ttV">${Object.entries(FC.CONVEYANCE).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('')}</select></div>
        <div class="field"><label>From</label><select id="ttO">${cty.map(c => `<option value="${c.iso2}" ${c.iso2 === 'DE' ? 'selected' : ''}>${esc(c.name)}${c.sea_zone || c.air_zone ? ' (S' + (c.sea_zone || '–') + ' / A' + (c.air_zone || '–') + ')' : ''}</option>`).join('')}</select></div>
        <div class="field"><label>To</label><select id="ttD">${cty.map(c => `<option value="${c.iso2}" ${c.iso2 === 'CN' ? 'selected' : ''}>${esc(c.name)}${c.sea_zone || c.air_zone ? ' (S' + (c.sea_zone || '–') + ' / A' + (c.air_zone || '–') + ')' : ''}</option>`).join('')}</select></div>
        <div class="field"><label>Invoice value <span class="muted" id="ttCur">(EUR)</span></label><input id="ttI" value="100000" inputmode="decimal"></div>
        <div class="field"><label>Cover</label><select id="ttK"><option value="icc_a">ICC A</option><option value="icc_b">ICC B</option><option value="icc_c">ICC C</option></select></div>
        <div class="field"><label>As office (open cover)</label><select id="ttOf"><option value="">— spot client (standard rating) —</option>${S.policies.map(po => `<optgroup label="${esc(po.name + ' · ' + po.currency)}">${S.offices.filter(o => o.policy_id === po.id && o.active).map(o => `<option value="${o.id}" data-cur="${po.currency}">${esc(o.name)}${o.location ? ' — ' + esc(o.location) : ''}</option>`).join('')}</optgroup>`).join('')}</select></div>
        <div class="field"><label>Packaging</label><select id="ttP">${Object.keys(Object.assign({ '':1 }, setting('packing_factors', {}))).map(k => `<option value="${esc(k)}">${esc(k || 'Not stated')}</option>`).join('')}</select></div>
      </div><div class="small" style="margin-top:12px;display:flex;gap:18px;flex-wrap:wrap"><label><input type="checkbox" id="ttW" checked> War &amp; strikes</label><label><input type="checkbox" id="ttDk"> On deck</label><label><input type="checkbox" id="ttHs"> HSSC</label><label><input type="checkbox" id="ttLw"> LiW / DiW</label><label><input type="checkbox" id="ttIn"> Interest only</label></div>
      <div id="ttRun" style="margin-top:12px"></div><div id="ttOut" style="margin-top:14px"></div></div>`);
    host.appendChild(body);
    body.querySelector('#ttOf').addEventListener('change', e => { const o = e.target.selectedOptions[0]; body.querySelector('#ttCur').textContent = '(' + ((o && o.dataset.cur) || 'EUR') + ')'; });
    body.querySelector('#ttRun').appendChild(btn('Calculate', 'primary', async b => {
      busy(b, true);
      const v = id => body.querySelector(id).value, c = id => body.querySelector(id).checked;
      const of = body.querySelector('#ttOf'), cur = (of.selectedOptions[0] && of.selectedOptions[0].dataset.cur) || 'EUR';
      const { data, error } = await sb.rpc('calc_indication', { p: { commodity_id:v('#ttC'), goods_description:'Rate test', conveyance:v('#ttV'), origin_country:v('#ttO'), dest_country:v('#ttD'), invoice_value:FC.parseNum(v('#ttI')), currency:cur, office_id: of.value || null, ext_hssc:c('#ttHs'), ext_liw:c('#ttLw'), uplift_pct:10, cover:v('#ttK'), packaging:v('#ttP'), war_strikes:c('#ttW'), on_deck:c('#ttDk'), interest_only:c('#ttIn') } });
      busy(b, false);
      if(error){ body.querySelector('#ttOut').innerHTML = `<div class="notice danger" style="margin:0">${esc(error.message)}</div>`; return; }
      await sb.from('indications').update({ is_test:true, hidden_by_user:true }).eq('id', data.id);
      loadAll();
      const d = data.calc_detail || {};
      body.querySelector('#ttOut').innerHTML = data.status === 'quoted'
        ? `<div class="notice ok" style="margin:0"><b>${esc(money2(data.premium, data.currency))} at ${esc(pm(d.rate_permille))} ‰</b>${esc(explain(d))}. Sum insured ${esc(money2(data.sum_insured, data.currency))}${data.min_applied ? ', minimum premium applied' : ''}${Number(data.discount_pct) ? ', your own discount ' + esc(Number(data.discount_pct)) + ' % applied' : ''}. Deductible: ${esc(data.deductible_text || '')}.</div>`
        : `<div class="notice warn" style="margin:0"><b>${esc(FC.STATUS[data.status])}</b>${esc((data.reasons || []).join('; '))}${(data.notes || []).length ? '<br><i>For the broker: ' + esc(data.notes.join('; ')) + '</i>' : ''}</div>`;
    }));
  }

  // =================================================================== CLAIMS
  const CLS = () => FC.CL_STATUS || {};
  // a claim needs action when it is new, or when the client wrote last
  const claimNeedsAction = c => c.status === 'reported' || (() => { const ev = (S.claimEvents[c.id] || []).filter(e => e.author_role !== 'system'); const l = ev[ev.length - 1]; return l && l.author_role === 'client'; })();
  let clFilter = { q:'', scope:'open' };
  function renderClaimsAdmin(body){
    const all = S.claims, open = all.filter(c => !['settled','rejected','closed'].includes(c.status)), act = all.filter(claimNeedsAction);
    const reserve = {}; open.forEach(c => { const r = S.claimInt[c.id]; if(r && r.reserve != null) reserve[c.currency] = (reserve[c.currency] || 0) + Number(r.reserve); });
    const scopeBtn = (k, label, cnt, cls) => `<button type="button" class="stat stat-btn${cls ? ' ' + cls : ''}" data-cscope="${k}" aria-pressed="${clFilter.scope === k}"><b>${cnt}</b><span>${label}</span></button>`;
    body.appendChild(FC.el(`<div class="stats">${scopeBtn('action', 'Need action (new or client wrote)', act.length, act.length ? 'alert' : '')}${scopeBtn('open', 'Open claims', open.length)}
      ${scopeBtn('settled', 'Settled', all.filter(c => c.status === 'settled').length, 'won')}${scopeBtn('all', 'All claims', all.length)}
      <div class="stat"><b class="num" style="font-size:20px">${esc(Object.keys(reserve).length ? Object.entries(reserve).map(([c, v]) => money2(v, c)).join(' · ') : '—')}</b><span>Reserves on open claims (internal)</span></div></div>`));
    body.querySelectorAll('.stat-btn b').forEach(b => FC.countUp(b, Number(b.textContent), null, 500));
    const tb = FC.el(`<div class="toolbar"><input class="input" type="search" id="clQ" placeholder="Search claim, customer, goods" value="${esc(clFilter.q)}" aria-label="Search"></div>`); body.appendChild(tb);
    const wrap = FC.el('<div class="tbl-wrap"></div>'); body.appendChild(wrap);
    const paint = () => {
      body.querySelectorAll('[data-cscope]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.cscope === clFilter.scope)));
      const s = clFilter.q.trim().toLowerCase();
      const rows = all.filter(c => clFilter.scope === 'all' || (clFilter.scope === 'open' && open.includes(c)) || (clFilter.scope === 'action' && act.includes(c)) || (clFilter.scope === 'settled' && c.status === 'settled'))
        .filter(c => { if(!s) return true; const i = S.rows.find(x => x.id === c.indication_id) || {}, p = S.profiles[c.user_id] || {}; return [c.ref, c.cover_note_no, c.insurer_claim_no, p.company, p.full_name, p.email, i.goods_description, i.ref].join(' ').toLowerCase().includes(s); });
      if(!rows.length){ wrap.innerHTML = '<div class="empty"><h3>No claims here</h3><p>Reported claims appear here.</p></div>'; return; }
      wrap.innerHTML = '<table class="tbl"><thead><tr><th>Claim</th><th>Reported</th><th>Customer</th><th>What happened</th><th>Shipment</th><th class="r">Estimated</th><th>Status</th><th>Handler</th></tr></thead><tbody></tbody></table>';
      rows.forEach(c => {
        const i = S.rows.find(x => x.id === c.indication_id) || {}, p = S.profiles[c.user_id] || {}, ci = S.claimInt[c.id] || {};
        const tr = FC.el(`<tr class="click" tabindex="0"><td><b>${esc(c.ref)}</b>${claimNeedsAction(c) ? ' ' + chip('pending', c.status === 'reported' ? 'New' : 'Client wrote') : ''}</td>
          <td class="xs">${esc(FC.ago(c.created_at))}</td><td>${esc(p.company || '')}<br><span class="xs muted">${esc(p.full_name || p.email || '')}</span></td>
          <td>${esc((FC.LOSS && FC.LOSS[c.loss_type] || {}).label || c.loss_type)}<br><span class="xs muted">${esc(c.place || '')}</span></td>
          <td>${esc(i.ref || '')}<br><span class="xs muted">${esc((i.goods_description || '').slice(0, 40))}</span></td>
          <td class="r num">${c.estimated_amount != null ? esc(money2(c.estimated_amount, c.currency)) : '—'}</td>
          <td>${chip(c.status === 'settled' ? 'paid' : ['rejected','closed'].includes(c.status) ? 'neutral' : 'pending', CLS()[c.status] || c.status)}</td><td>${esc(ci.handler || '')}</td></tr>`);
        tr.addEventListener('click', () => openClaimAdmin(c.id)); tr.addEventListener('keydown', e => { if(e.key === 'Enter') openClaimAdmin(c.id); });
        wrap.querySelector('tbody').appendChild(tr);
      });
    };
    body.querySelectorAll('[data-cscope]').forEach(b => b.addEventListener('click', () => { clFilter.scope = b.dataset.cscope; paint(); }));
    $('#clQ', tb).addEventListener('input', e => { clFilter.q = e.target.value; paint(); });
    paint();
  }
  async function openClaimAdmin(id){
    const c = S.claims.find(x => x.id === id); if(!c) return;
    const back = FC.el('<div class="drawer-back"></div>');
    const dr = FC.el(`<aside class="drawer" role="dialog" aria-modal="true" aria-label="Claim ${esc(c.ref)}"><div class="dlg-head"><div><h2>${esc(c.ref)}</h2><div class="xs muted" id="cdSub"></div></div><button class="x" type="button" aria-label="Close" style="background:none;border:0;font-size:26px;cursor:pointer;color:var(--steel)">&times;</button></div><div class="drawer-body"></div></aside>`);
    const close = () => { back.remove(); dr.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = e => { if(e.key === 'Escape' && !document.querySelector('.dlg-back')) close(); };
    back.addEventListener('click', close); dr.querySelector('.x').addEventListener('click', close); document.addEventListener('keydown', onKey);
    document.body.appendChild(back); document.body.appendChild(dr);
    const body = dr.querySelector('.drawer-body');
    const paint = async () => {
      const cc = S.claims.find(x => x.id === id) || c, i = S.rows.find(x => x.id === cc.indication_id) || {}, p = S.profiles[cc.user_id] || {}, ci = S.claimInt[cc.id] || {};
      const ev = S.claimEvents[cc.id] || [], files = S.claimFiles[cc.id] || [];
      dr.querySelector('#cdSub').textContent = [p.company, p.full_name].filter(Boolean).join(', ');
      body.innerHTML = `
        <section><h3>Claim</h3><dl class="kv">
          <dt>Status</dt><dd>${chip(cc.status === 'settled' ? 'paid' : 'pending', CLS()[cc.status] || cc.status)}</dd>
          <dt>What happened</dt><dd>${esc((FC.LOSS && FC.LOSS[cc.loss_type] || {}).label || cc.loss_type)}${cc.transit_stage ? ', ' + esc(cc.transit_stage) : ''}</dd>
          <dt>When / where</dt><dd>${esc([cc.incident_date ? 'incident ' + FC.date(cc.incident_date) : '', cc.discovered_date ? 'discovered ' + FC.date(cc.discovered_date) : '', cc.place].filter(Boolean).join(' · ') || '—')}</dd>
          <dt>Description</dt><dd style="white-space:pre-wrap">${esc(cc.description)}</dd>
          <dt>Estimated loss</dt><dd>${cc.estimated_amount != null ? esc(money2(cc.estimated_amount, cc.currency)) : 'Not stated'}</dd>
          <dt>Goods are at</dt><dd>${esc(cc.goods_location || '—')}</dd>
          <dt>Carrier</dt><dd>${cc.carrier_notified ? 'Notified in writing' : '<b style="color:var(--danger)">Not notified yet</b>'} · ${cc.receipt_remarks ? 'remarks on receipt' : 'no remarks on receipt'}</dd>
          <dt>Contact</dt><dd>${esc([cc.contact_name, cc.contact_phone].filter(Boolean).join(', '))}${p.email ? ', <a href="mailto:' + esc(p.email) + '">' + esc(p.email) + '</a>' : ''}</dd>
          <dt>Shipment</dt><dd>${esc(i.ref || '')} · ${esc(i.goods_description || '')}<br><span class="xs muted">${esc(i.origin_country || '')} → ${esc(i.dest_country || '')}, sum insured ${i.sum_insured ? esc(money2(i.sum_insured, i.currency)) : '—'}${cc.cover_note_no ? ', cover note ' + esc(cc.cover_note_no) : ''}${i.vessel ? ', vessel ' + esc(i.vessel) : ''}</span>${i.id ? ' <button type="button" class="linkbtn" id="cdCase">Open case</button>' : ''}</dd></dl></section>
        <section><h3>Files (${files.length})</h3><div class="cl-thumbs" id="cdFiles">${files.length ? '' : '<p class="xs muted" style="margin:0">No files.</p>'}</div>
          <label class="btn btn-ghost btn-sm" style="cursor:pointer;margin-top:10px">${FC.icon.upload}Add file for the client<input type="file" id="cdUp" multiple hidden></label></section>
        <section><h3>Update</h3><div class="grid2">
            <div class="field"><label for="cdSt">Status</label><select id="cdSt">${Object.entries(CLS()).map(([k, v]) => `<option value="${k}" ${k === cc.status ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></div>
            <div class="field"><label for="cdIns">Insurer's claim number</label><input id="cdIns" maxlength="60" value="${esc(cc.insurer_claim_no || '')}"></div>
            <div class="field"><label for="cdSet">Settled amount (${esc(cc.currency || 'EUR')})</label><input id="cdSet" inputmode="decimal" value="${cc.settled_amount != null ? esc(cc.settled_amount) : ''}"></div>
            <div class="field"><label for="cdInsr">Insurer</label><select id="cdInsr"><option value="">—</option>${S.insurers.map(x => `<option value="${x.id}" ${String(ci.insurer_id) === String(x.id) ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div></div>
          <div class="field" style="margin-top:12px"><label for="cdMsg">Message to the client <span class="muted">(e-mailed and shown in the claim)</span></label><textarea id="cdMsg" rows="3" maxlength="4000" placeholder="e.g. Surveyor X will inspect on Thursday. Please send the commercial invoice and packing list."></textarea></div>
          <div class="qe-internal"><h4>Internal, never shown to the client</h4><div class="grid3">
            <div class="field"><label for="cdH">Handler</label><input id="cdH" maxlength="20" value="${esc(ci.handler || myInitials())}"></div>
            <div class="field"><label for="cdR">Reserve (${esc(cc.currency || 'EUR')})</label><input id="cdR" inputmode="decimal" value="${ci.reserve != null ? esc(ci.reserve) : ''}"></div>
            <div class="field"><label for="cdSv">Surveyor</label><input id="cdSv" maxlength="120" value="${esc(ci.surveyor || '')}"></div></div>
            <div class="field"><label for="cdN">Internal note</label><textarea id="cdN" rows="2" maxlength="4000">${esc(ci.internal_note || '')}</textarea></div></div>
          <div id="cdSave" style="margin-top:12px"></div></section>
        <section><h3>Messages &amp; timeline</h3><div class="chat">${ev.map(e => e.author_role === 'system' ? `<div class="sys">${esc(e.body || '')} · ${esc(FC.dateTime(e.created_at))}</div>`
          : `<div class="msg ${e.author_role === 'staff' ? 'me' : 'them'}">${e.status ? chip('pending', CLS()[e.status] || e.status) : ''}${e.body ? `<p>${esc(e.body)}</p>` : ''}<span class="xs">${esc(e.author_role === 'client' ? (p.full_name || 'Client') : (e.author_name || 'Staff'))} · ${esc(FC.dateTime(e.created_at))}</span></div>`).join('')}</div></section>`;
      const cb = body.querySelector('#cdCase'); if(cb) cb.addEventListener('click', () => { close(); openCase(i.id); });
      if(files.length){
        const sg = await sb.storage.from('claims').createSignedUrls(files.map(f => f.path), 600).catch(() => ({ data:[] }));
        files.forEach((f, k) => { const u = ((sg.data || [])[k] || {}).signedUrl, img = /^image\//.test(f.mime || '');
          body.querySelector('#cdFiles').appendChild(FC.el(`<a class="cl-thumb" target="_blank" rel="noopener" ${u ? `href="${esc(u)}"` : ''}>${img && u ? `<img alt="" src="${esc(u)}">` : `<span class="cl-doc">${esc((f.name.split('.').pop() || 'file').toUpperCase().slice(0, 4))}</span>`}<span class="cl-fn">${esc(f.name)}</span><span class="xs muted">${esc(f.uploaded_by === 'staff' ? 'staff · ' : '')}${esc(FC.date(f.created_at))}</span></a>`)); });
      }
      body.querySelector('#cdUp').addEventListener('change', async e => {
        const fs = Array.from(e.target.files); if(!fs.length) return;
        let n = 0;
        for(const f of fs){ const path = `${cc.user_id}/${cc.id}/${Date.now()}_staff_${f.name.replace(/[^\w.\-]+/g, '_').slice(-80)}`;
          const up = await sb.storage.from('claims').upload(path, f, { contentType: f.type || 'application/octet-stream' });
          if(!up.error && !(await sb.rpc('add_claim_file', { p_claim_id: cc.id, p_path: path, p_name: f.name, p_size: f.size, p_mime: f.type || '' })).error) n++; }
        toast(n + ' file(s) added.'); await loadAll(); paint();
      });
      body.querySelector('#cdSave').appendChild(btn('Save and notify', 'primary', async b => {
        const v = id => body.querySelector('#' + id).value.trim(), num = id => { const t = v(id); return t === '' ? '' : FC.parseNum(t); };
        const st = v('cdSt'), msg = v('cdMsg');
        if(st === 'settled' && num('cdSet') === ''){ toast('Enter the settled amount.', 'error'); return; }
        busy(b, true);
        const { error } = await sb.rpc('admin_update_claim', { p_claim_id: cc.id, p_status: st, p_message: msg, p_data: { insurer_claim_no: v('cdIns'), settled_amount: num('cdSet'),
          internal: { handler: v('cdH'), reserve: num('cdR'), insurer_id: v('cdInsr'), surveyor: v('cdSv'), internal_note: v('cdN') } } });
        busy(b, false);
        if(error){ toast('Could not save: ' + error.message, 'error'); return; }
        toast(st !== cc.status || msg ? 'Saved. The client is notified.' : 'Saved.'); await loadAll(); paint(); if(tab === 'claims') render();
      }));
      const chat = body.querySelector('.chat'); if(chat) chat.scrollTop = chat.scrollHeight;
    };
    paint();
  }

  // =================================================================== INSURERS
  function renderInsurers(body){
    const tb = FC.el('<div class="toolbar"><span style="flex:1"></span></div>'); body.appendChild(tb);
    tb.appendChild(btn('Add insurer', 'primary', () => editInsurer({ active:true })));
    const l = FC.el('<div class="list"></div>'); body.appendChild(l);
    if(!S.insurers.length) l.innerHTML = '<div class="empty card"><h3>No insurers yet</h3><p>Add the markets you place with. You pick them on each quotation, with their brokerage.</p></div>';
    S.insurers.forEach(i => {
      const it = FC.el(`<div class="item"><div><div class="t">${esc(i.name)} ${i.active ? '' : chip('neutral', 'Inactive')}</div><div class="meta">Brokerage ${esc(Number(i.brokerage_pct || 0))} %${[i.contact, i.email, i.phone].filter(Boolean).length ? ' · ' : ''}${esc([i.contact, i.email, i.phone].filter(Boolean).join(', '))}${i.notes ? '<br>' + esc(i.notes) : ''}</div></div><div class="acts"></div></div>`);
      it.querySelector('.acts').appendChild(btn('Edit', 'ghost', () => editInsurer(i)));
      l.appendChild(it);
    });
  }
  function editInsurer(i){
    const f = (id, l, v) => `<div class="field"><label for="${id}">${l}</label><input id="${id}" maxlength="200" value="${esc(v || '')}"></div>`;
    const body = FC.el(`<div><div class="grid2">${f('inN', 'Name', i.name)}${f('inB', 'Brokerage % (internal, default on quotations)', i.brokerage_pct != null ? String(i.brokerage_pct) : '0')}${f('inC', 'Contact person', i.contact)}${f('inE', 'E-mail', i.email)}${f('inP', 'Phone', i.phone)}</div>
      <div class="field" style="margin-top:12px"><label for="inNo">Notes (capacity, appetite, commission…)</label><textarea id="inNo" rows="3" maxlength="1000">${esc(i.notes || '')}</textarea></div>
      <label class="switch"><input type="checkbox" id="inA" ${i.active ? 'checked' : ''}><span><b>Active</b></span></label><div class="err-msg" id="inErr"></div></div>`);
    const acts = [{ label:'Cancel', kind:'ghost', value:null }];
    if(i.id) acts.push({ label:'Delete', kind:'danger', onClick: async () => { if(!(await FC.confirm('Delete insurer?', i.name, 'Delete', 'danger'))) return; const { error } = await sb.from('insurers').delete().eq('id', i.id); if(error) return toast(error.message, 'error'); await loadAll(); render(); return true; } });
    acts.push({ label:'Save', kind:'primary', onClick: async () => {
      const v = id => body.querySelector('#' + id).value.trim();
      if(!v('inN')){ body.querySelector('#inErr').textContent = 'Enter the name.'; return; }
      const bp = FC.parseNum(v('inB') || '0'); if(!(bp >= 0 && bp <= 50)){ body.querySelector('#inErr').textContent = 'Brokerage must be between 0 and 50 %.'; return; }
      const row = { name:v('inN'), brokerage_pct: bp, contact:v('inC') || null, email:v('inE') || null, phone:v('inP') || null, notes:v('inNo') || null, active: body.querySelector('#inA').checked };
      const { error } = i.id ? await sb.from('insurers').update(row).eq('id', i.id) : await sb.from('insurers').insert(row);
      if(error){ body.querySelector('#inErr').textContent = error.message; return; }
      await loadAll(); render(); return true;
    } });
    FC.dialog({ title: i.id ? i.name : 'Add insurer', body, actions: acts });
  }

  // =================================================================== FEEDBACK
  async function renderFeedback(body){
    const { data, error } = await sb.from('feedback').select('*').order('created_at', { ascending:false }).limit(300);
    if(error){ body.innerHTML = `<div class="empty">${esc(error.message)}</div>`; return; }
    const l = FC.el('<div class="list"></div>'); body.appendChild(l);
    if(!(data || []).length) l.innerHTML = '<div class="empty card"><h3>No feedback yet</h3></div>';
    (data || []).forEach(f => {
      const p = S.profiles[f.user_id] || {};
      const it = FC.el(`<div class="item${f.done ? '' : ' new'}"><div><div class="t">${esc(p.company || p.email || 'Unknown')} ${f.done ? chip('neutral', 'Done') : ''}</div><div class="meta">${esc(FC.dateTime(f.created_at))}${f.page ? ', page ' + esc(f.page) : ''}</div><p style="margin:8px 0 0;white-space:pre-wrap">${esc(f.message)}</p></div><div class="acts"></div></div>`);
      it.querySelector('.acts').appendChild(btn(f.done ? 'Reopen' : 'Mark done', 'ghost', async () => { await sb.from('feedback').update({ done: !f.done }).eq('id', f.id); render(); }));
      if(p.email) it.querySelector('.acts').appendChild(FC.el(`<a class="btn btn-ghost btn-sm" href="mailto:${esc(p.email)}?subject=${encodeURIComponent('Your feedback on ' + FC.brand)}">Reply</a>`));
      l.appendChild(it);
    });
  }

  // =================================================================== SETTINGS
  async function renderSettings(body){
    const flag = k => setting(k, false) === true;
    const sw = FC.el(`<div class="stats">
      <div class="stat${flag('maintenance') ? ' alert' : ''}"><b>${flag('maintenance') ? 'On' : 'Off'}</b><span>Maintenance mode</span><div data-k="maintenance" style="margin-top:8px"></div></div>
      <div class="stat"><b>${flag('telegram_enabled') ? 'On' : 'Off'}</b><span>Telegram alerts</span><div data-k="telegram_enabled" style="margin-top:8px"></div></div>
      <div class="stat"><b>${flag('email_enabled') ? 'On' : 'Off'}</b><span>E-mail alerts</span><div data-k="email_enabled" style="margin-top:8px"></div></div></div>`);
    body.appendChild(sw);
    sw.querySelectorAll('[data-k]').forEach(h => h.appendChild(btn(flag(h.dataset.k) ? 'Switch off' : 'Switch on', 'ghost', async b => {
      busy(b, true); const { error } = await sb.from('settings').update({ value: !flag(h.dataset.k), updated_at: new Date().toISOString() }).eq('key', h.dataset.k); busy(b, false);
      if(error) return toast(error.message, 'error'); await loadAll(); render();
    })));
    body.appendChild(FC.el('<h2 style="margin:6px 0 10px">All settings</h2>'));
    const wrap = FC.el('<div class="tbl-wrap"></div>'); body.appendChild(wrap);
    wrap.innerHTML = '<table class="tbl"><thead><tr><th>Key</th><th>Value</th><th>Meaning</th><th></th></tr></thead><tbody></tbody></table>';
    S.settingRows.forEach(s => {
      const isStr = typeof s.value === 'string', isArr = Array.isArray(s.value);
      const val = isStr ? s.value : isArr ? s.value.join('\n') : JSON.stringify(s.value);
      const tr = FC.el(`<tr><td><b>${esc(s.key)}</b></td><td><textarea rows="${isArr ? 4 : 1}" style="width:100%;min-width:260px;border:1px solid var(--line);border-radius:5px;padding:6px 8px;background:var(--paper)">${esc(val)}</textarea><span class="xs muted">${isArr ? 'one entry per line' : isStr ? 'text' : 'JSON'}</span></td><td class="xs muted">${esc(s.note || '')}</td><td></td></tr>`);
      tr.lastElementChild.appendChild(btn('Save', 'ghost', async b => {
        const raw = tr.querySelector('textarea').value; let v;
        if(isStr) v = raw.trim(); else if(isArr) v = raw.split('\n').map(x => x.trim()).filter(Boolean);
        else { try{ v = JSON.parse(raw); }catch(e){ return toast('That is not valid JSON.', 'error'); } }
        busy(b, true); const { error } = await sb.from('settings').update({ value: v, updated_at: new Date().toISOString() }).eq('key', s.key); busy(b, false);
        if(error) return toast(error.message, 'error'); toast('Saved.'); await loadAll();
      }));
      wrap.querySelector('tbody').appendChild(tr);
    });
    const testBar = FC.el('<div class="toolbar" style="margin-top:24px"></div>'); body.appendChild(testBar);
    testBar.appendChild(btn('Send test alert', 'ghost', async b => {
      busy(b, true); const { error } = await sb.from('outbox').insert({ kind:'test', payload:{ email: me().email } }); busy(b, false);
      if(error) return toast(error.message, 'error'); toast('Test alert queued. Check Telegram and your inbox, then refresh this page.');
    }));
    body.appendChild(FC.el('<h2 style="margin:12px 0 6px">Recent alerts</h2><p class="small muted" style="margin:0 0 10px">Each event the system sends via Telegram and e-mail. "Not sent" means the alert function has not run — check the webhook (see README).</p>'));
    const { data: ob } = await sb.from('outbox').select('*').order('id', { ascending:false }).limit(40);
    const ow = FC.el('<div class="tbl-wrap"></div>'); body.appendChild(ow);
    ow.innerHTML = `<table class="tbl"><thead><tr><th>When</th><th>Event</th><th>Details</th><th>Result</th></tr></thead><tbody>${(ob || []).map(o => `<tr><td class="xs">${esc(FC.dateTime(o.created_at))}</td><td>${esc(o.kind)}</td><td class="xs">${esc([o.payload.ref, o.payload.company, o.payload.email].filter(Boolean).join(', '))}</td><td class="xs">${o.processed_at ? esc(o.result || 'sent') : chip('pending', 'Not sent')}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No alerts yet.</td></tr>'}</tbody></table>`;
  }

  // poll for new work every 2 minutes while the page is open
  setInterval(async () => { if(document.hidden || !loaded) return; await loadAll(); if(root && !root.hidden && tab === 'requests' && !document.querySelector('.drawer, .dlg-back')) render(); }, 120000);
  // first badge paint even before the area is opened
  (async () => { try{ const { data } = await sb.rpc('admin_overview', { p_days: 1 }); const ib = document.getElementById('adminBadge'); const n = data ? data.open_requests + data.pending_users : 0; if(ib){ ib.hidden = !n; ib.textContent = n; } }catch(e){} })();
})();
