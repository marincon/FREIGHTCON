/* FREIGHTCON — internal area (admins only; the database enforces this, the UI only mirrors it) */
(function(){
  'use strict';
  const { $, $$, sb, esc, money2, busy, toast } = FC;
  const A = window.FCAdmin = {};
  let root = null, tab = 'requests', loaded = false;
  const S = { rows:[], profiles:{}, commodities:[], regions:[], countries:[], settings:{}, insurers:[], quotes:{}, coverNotes:{}, rateTables:[], rateCells:[], qint:{} };
  const cName = iso => (S.countries.find(c => c.iso2 === iso) || {}).name || iso || '';
  const me = () => FC.profile || {};
  const myInitials = () => FC.initials(me().full_name || me().email);
  const setting = (k, d) => (S.settings[k] !== undefined ? S.settings[k] : d);

  const TABS = [['requests','Requests'],['overview','Overview'],['customers','Customers'],['rates','Rates'],['insurers','Insurers'],['feedback','Feedback'],['settings','Settings']];

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
    const [ind, prof, com, reg, cty, set, ins, q, cn, rt, rc, qi] = await Promise.all([
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
      sb.from('quotation_internal').select('*')
    ]);
    const err = [ind, prof, com, reg, cty, set, ins, q, cn, rt, rc].find(r => r.error);
    S.qint = {}; (qi.data || []).forEach(x => S.qint[x.quotation_id] = x);
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
    const n = openRequests().length + acceptedNoCover().length, u = pendingUsers().length;
    const set = (k, v) => { const b = root && root.querySelector(`[data-abadge="${k}"]`); if(b){ b.hidden = !v; b.textContent = v; } };
    set('requests', n); set('customers', u);
    const ib = document.getElementById('adminBadge'); if(ib){ ib.hidden = !(n + u); ib.textContent = n + u; }
  }
  A.paintBadges = paintBadges;

  function render(){
    const body = $('#admBody', root); body.innerHTML = '';
    ({ requests: renderRequests, overview: renderOverview, customers: renderCustomers, rates: renderRates, insurers: renderInsurers, feedback: renderFeedback, settings: renderSettings })[tab](body);
  }
  const chip = (cls, t) => `<span class="chip ${esc(cls)}">${esc(t)}</span>`;
  const btn = (label, kind, fn) => { const b = FC.el(`<button type="button" class="btn btn-${kind} btn-sm"><span class="spin"></span>${esc(label)}</button>`); b.addEventListener('click', e => fn(b, e)); return b; };
  const addrOf = p => [p.address_line, [p.postcode, p.city].filter(Boolean).join(' '), p.country].filter(Boolean).join(', ');
  A.addrOf = addrOf;
  const who = r => { const p = S.profiles[r.user_id] || {}; return { name: p.full_name || p.email || '—', company: r.company || p.company || '', email: p.email || '', p }; };

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
          <td><b>${esc(r.ref || '—')}</b>${r.is_test ? ' ' + chip('neutral', 'Test') : ''}${bk === 'won' ? ' ' + chip('accepted', 'Won') : bk === 'lost' ? ' ' + chip('declined', 'Lost') : ''}</td>
          <td class="xs">${esc(FC.ago(r.quote_requested_at || r.created_at))}${r.quote_requested_at ? '' : '<br><span class="muted">no request</span>'}</td>
          <td>${esc(w.company)}<br><span class="xs muted">${esc(w.name)}</span></td>
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
      return [r.ref, w.company, w.name, w.email, r.goods_description, r.origin_country, r.dest_country, cName(r.origin_country), cName(r.dest_country), r.origin_place, r.dest_place].join(' ').toLowerCase().includes(s);
    }).sort((a, b) => new Date(b.quote_requested_at || b.created_at) - new Date(a.quote_requested_at || a.created_at));
  }
  function exportCsv(rows){
    const cell = v => { const s = String(v == null ? '' : v); return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const head = ['Reference','Created','Requested','Company','Name','E-mail','Goods','Commodity','Conveyance','Vessel','Incoterm','Insured party','From','From place','To','To place','Departure','Invoice value','Currency','Sum insured','Cover','War/strikes','Status','Rate %','Premium','Stage','Owner'];
    const lines = [head].concat(rows.map(r => { const w = who(r); return [r.ref, r.created_at, r.quote_requested_at, w.company, w.name, w.email, r.goods_description, r.commodity_id, r.conveyance, r.vessel, r.incoterm, r.insured_party, r.origin_country, r.origin_place, r.dest_country, r.dest_place, r.departure_date, r.invoice_value, r.currency, r.sum_insured, r.cover, r.war_strikes, r.status, r.rate_pct, r.premium, r.stage, r.owner]; }));
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
          ${r.calc_detail ? `<dt>Tariff</dt><dd>${esc(explain(r.calc_detail))}${r.on_deck ? ', on deck' : ''}${r.interest_only ? ', interest only' : ''}</dd>` : ''}
          ${(r.reasons || []).length ? `<dt>Reasons</dt><dd>${esc(r.reasons.join('; '))}</dd>` : ''}
          <dt>Goods</dt><dd>${esc(r.goods_description)}</dd>
          <dt>Cargo type</dt><dd>${esc((S.commodities.find(c => c.id === r.commodity_id) || {}).name || r.commodity_id)}</dd>
          <dt>Packaging</dt><dd>${esc(r.packaging || '—')}</dd>
          <dt>Route</dt><dd>${esc([r.origin_place, cName(r.origin_country)].filter(Boolean).join(', '))} → ${esc([r.dest_place, cName(r.dest_country)].filter(Boolean).join(', '))}</dd>
          <dt>Conveyance</dt><dd>${esc(conv.label || r.conveyance)}${r.departure_date ? ', departs ' + esc(FC.date(r.departure_date)) : ''}</dd>
          ${/^sea_/.test(r.conveyance) ? `<dt>Vessel</dt><dd>${esc(r.vessel || 'Not stated — ask the client')} <span class="xs muted">check age, class (IACS), flag, sanctions</span></dd>` : ''}
          ${r.incoterm ? `<dt>Incoterm</dt><dd>${esc(r.incoterm)} (${esc((FC.INCOTERMS[r.incoterm] || {}).name || '')}), client is the ${esc(r.insured_party || 'seller')}${FC.noRisk(r.incoterm, r.insured_party) ? ' <span class="chip pending">client carries no transit risk</span>' : ''}</dd>` : ''}
          <dt>Values</dt><dd>Invoice ${esc(money2(r.invoice_value, r.currency))} + ${esc(Number(r.uplift_pct))} % = ${esc(money2(r.sum_insured, r.currency))}</dd>
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
    const conds = (FC.COVER[r.cover] || {}).clause + (r.war_strikes ? (land ? ', Institute Strikes Clauses (Cargo)' : ', Institute War Clauses (Cargo), Institute Strikes Clauses (Cargo)') : '') + ', warehouse to warehouse';
    const d = Object.assign({
      client: w.company, clientAddress: addrOf(w.p), coAssured: [], goods: r.goods_description, packaging: r.packaging || '', conveyance: r.conveyance, vessel: r.vessel || '', incoterm: r.incoterm ? r.incoterm + ' ' + (r.origin_place || r.dest_place || '') : '',
      originCountry: r.origin_country, originPlace: r.origin_place || '', destCountry: r.dest_country, destPlace: r.dest_place || '',
      voyage: [r.origin_place, cName(r.origin_country)].filter(Boolean).join(', ') + ' to ' + [r.dest_place, cName(r.dest_country)].filter(Boolean).join(', '),
      period: r.departure_date ? 'Transit commencing on or about ' + FC.date(r.departure_date) : 'Single transit as per voyage',
      conditions: conds, insurer: setting('default_insurer', ''), deductible: ((S.commodities.find(c => c.id === r.commodity_id) || {}).deductible) || setting('deductible_text', ''), special: r.conditions || '',
      currency: r.currency, discountPct: Number(r.discount_pct || w.p.client_discount_pct || 0), taxPct: 0,
      minPremium: Number(sp.detail && sp.detail.mode === 'land' ? setting('land_min_premium', 75) : (((S.rateTables.find(t => sp.detail && t.id === sp.detail.table) || {}).min_premium) || (setting('min_premium', {}) || {})[r.currency] || 0)),
      lines: [{ key:'cargo', label:'Cargo, ' + ((FC.COVER[r.cover] || {}).clause || '') + (r.interest_only ? ", seller's / buyer's interest only" : '') + (r.on_deck ? ', on deck' : '') + (r.war_strikes ? (land ? ', incl. strikes' : ', incl. war & strikes') : ''), sum: Number(r.sum_insured), rate: sp.cargo }],
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
      <div class="field" style="margin-top:12px"><label>Special conditions</label><textarea id="qeSpec" rows="2" maxlength="1200">${esc(d.special)}</textarea></div>
      <h3 style="margin:18px 0 6px">Premium</h3>
      <div class="grid3">
        <div class="field"><label>Currency</label><select id="qeCur"><option ${d.currency === 'EUR' ? 'selected' : ''}>EUR</option><option ${d.currency === 'USD' ? 'selected' : ''}>USD</option></select></div>
        <div class="field"><label>Client discount %</label><input id="qeDisc" inputmode="decimal" value="${esc(d.discountPct || 0)}"></div>
        <div class="field"><label>Minimum premium</label><input id="qeMin" inputmode="decimal" value="${esc(d.minPremium || 0)}"></div>
      </div>
      <div class="tbl-wrap" style="margin-top:12px"><table class="tbl"><thead><tr><th>Cover line</th><th>Sum insured</th><th>Rate %</th><th class="r">Premium</th><th></th></tr></thead><tbody id="qeLines">${(d.lines || []).map(lineRow).join('')}</tbody></table></div>
      <div class="toolbar" style="margin-top:8px"><button type="button" class="btn btn-ghost btn-sm" id="qeAdd">Add line</button>
        <label class="switch" style="margin:0"><input type="checkbox" id="qeTaxOn" ${taxOn ? 'checked' : ''}><span><b>Add insurance tax</b></span></label>
        <div class="field" style="flex-direction:row;align-items:center;gap:8px;margin:0"><label for="qeTax" style="white-space:nowrap">Rate %</label><input id="qeTax" inputmode="decimal" value="${esc(Number(d.taxPct) > 0 ? d.taxPct : taxDefault)}" style="width:80px" ${taxOn ? '' : 'disabled'}></div></div>
      <p class="xs muted" style="margin:4px 0 0">German insurance tax applies to the net premium. International transports of goods are usually exempt; tick it for domestic transports or where the insurer requires it.</p>
      <table class="qtable" id="qeSum"></table>
      <div class="qe-internal"><h4>Internal, never shown to the client</h4>
        <div class="grid3"><div class="field"><label for="qeBrk">Brokerage % with this insurer</label><input id="qeBrk" inputmode="decimal" value="${esc(preBrk)}"></div>
        <div class="field"><label>Brokerage</label><div class="num" id="qeBrkAmt" style="padding-top:10px">—</div></div>
        <div class="field"><label>Net premium to insurer</label><div class="num" id="qeNetIns" style="padding-top:10px">—</div></div></div>
        <p class="xs muted" style="margin:0">Calculated on the premium after discount and minimum, before insurance tax. The default comes from the insurer (tab Insurers).</p></div>
      <div class="grid2" style="margin-top:6px">
        <div class="field"><label>Valid until (your local time)</label><input id="qeValid" type="datetime-local" value="${toLocal(new Date(Date.now() + 3 * 864e5))}"></div>
        <div class="field"><label>Handled by</label><input id="qeHandler" maxlength="100" value="${esc(me().full_name || '')}"></div>
      </div>
      <div class="field" style="margin-top:12px"><label>Subject to (one per line)</label><textarea id="qeSubj" rows="5" maxlength="3000">${esc((d.subjectivities || []).join('\n'))}</textarea></div>
      <div class="field"><label>Note for the client (optional)</label><textarea id="qeNote" rows="2" maxlength="800">${esc(d.note || '')}</textarea></div>
      <div class="field"><label>How to accept</label><textarea id="qeClose" rows="2" maxlength="1200">${esc(d.closing || '')}</textarea></div>
      <div class="err-msg" id="qeErr"></div></div>`);
    const $b = s => body.querySelector(s);
    const collect = () => {
      const lines = Array.from(body.querySelectorAll('#qeLines tr')).map(tr => {
        const sum = FC.parseNum(tr.querySelector('.ln-sum').value), rate = FC.parseNum(tr.querySelector('.ln-rate').value);
        return { label: tr.querySelector('.ln-label').value.trim(), sum, rate, premium: isFinite(sum) && isFinite(rate) ? Math.round(sum * rate) / 100 : NaN, tr };
      });
      return { lines, disc: FC.parseNum($b('#qeDisc').value) || 0, min: FC.parseNum($b('#qeMin').value) || 0, tax: $b('#qeTaxOn').checked ? (FC.parseNum($b('#qeTax').value) || 0) : 0, brk: FC.parseNum($b('#qeBrk').value) || 0, cur: $b('#qeCur').value };
    };
    const recalc = () => {
      const c = collect();
      c.lines.forEach(l => { l.tr.querySelector('.ln-prem').textContent = isFinite(l.premium) ? money2(l.premium, c.cur) : '—'; });
      const ok = c.lines.length && c.lines.every(l => isFinite(l.premium));
      if(!ok){ $b('#qeSum').innerHTML = '<tr><td class="muted">Enter sum insured and rate for each line.</td></tr>'; $b('#qeBrkAmt').textContent = $b('#qeNetIns').textContent = '—'; return; }
      const t = calcQuote(c.lines, c.disc, c.min, c.tax);
      const ba = Math.round(t.net * c.brk) / 100;
      $b('#qeBrkAmt').textContent = money2(ba, c.cur); $b('#qeNetIns').textContent = money2(Math.round((t.net - ba) * 100) / 100, c.cur);
      $b('#qeSum').innerHTML = `<tr><td>Premium</td><td class="r">${esc(money2(t.subtotal, c.cur))}</td></tr>
        ${c.disc ? `<tr><td>Client discount ${esc(c.disc)} %</td><td class="r">− ${esc(money2(t.discountAmount, c.cur))}</td></tr>` : ''}
        ${t.minApplied ? `<tr><td>Minimum premium applies</td><td class="r">${esc(money2(t.net, c.cur))}</td></tr>` : ''}
        ${c.tax ? `<tr><td>Insurance tax ${esc(c.tax)} %</td><td class="r">${esc(money2(t.tax, c.cur))}</td></tr>` : ''}
        <tr class="tot"><td>Total premium payable</td><td class="r">${esc(money2(t.total, c.cur))}</td></tr>`;
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
      const vu = new Date($b('#qeValid').value); if(isNaN(vu) || vu.getTime() < Date.now() + 60000) return err('The validity must lie in the future.');
      const t = calcQuote(c.lines, c.disc, c.min, c.tax); $b('#qeErr').textContent = '';
      const ip = insurerPick(), ba = Math.round(t.net * c.brk) / 100;
      return { validUntil: vu.toISOString(), internal: { insurer_id: ip.id, insurer_name: ip.name, brokerage_pct: c.brk, brokerage_amount: ba, net_to_insurer: Math.round((t.net - ba) * 100) / 100 }, data: {
        client: $b('#qeClient').value.trim(), clientAddress: $b('#qeAddr').value.trim(), incoterm: $b('#qeInco').value.trim(), coAssured: $b('#qeCo').value.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 6),
        goods: $b('#qeGoods').value.trim(), packaging: $b('#qePack').value.trim(), conveyance: $b('#qeConv').value, vessel: $b('#qeVessel').value.trim(),
        originCountry: $b('#qeOC').value.trim().toUpperCase(), originPlace: $b('#qeOP').value.trim(), destCountry: $b('#qeDC').value.trim().toUpperCase(), destPlace: $b('#qeDP').value.trim(),
        voyage: $b('#qeVoy').value.trim(), period: $b('#qePer').value.trim(), conditions: $b('#qeCond').value.trim(), insurer: insurerPick().name,
        deductible: $b('#qeDed').value.trim(), special: $b('#qeSpec').value.trim(), currency: c.cur, discountPct: c.disc, minPremium: c.min, taxPct: c.tax,
        lines: c.lines.map(l => ({ label:l.label, sum: Math.round(l.sum * 100) / 100, rate: l.rate, premium: l.premium })),
        subtotal: t.subtotal, discountAmount: t.discountAmount, net: t.net, minApplied: t.minApplied, tax: t.tax, total: t.total,
        sumInsured: Math.max(...c.lines.map(l => l.sum)),
        subjectivities: $b('#qeSubj').value.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 40), note: $b('#qeNote').value.trim(), closing: $b('#qeClose').value.trim(),
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
      client: qd.client || w.company, clientAddress: qd.clientAddress || addrOf(w.p), coAssured: qd.coAssured || [], insurer: qd.insurer || setting('default_insurer', ''), policyNo: '',
      goods: qd.goods || r.goods_description, packaging: qd.packaging || r.packaging || '', marks: '', conveyance: qd.conveyance || r.conveyance, vessel: qd.vessel || '',
      transportDoc: '', voyage: qd.voyage || '', departure: r.departure_date ? FC.date(r.departure_date) : '', period: qd.period || '',
      originCountry: qd.originCountry || r.origin_country, originPlace: qd.originPlace || r.origin_place || '', destCountry: qd.destCountry || r.dest_country, destPlace: qd.destPlace || r.dest_place || '',
      sumInsured: qd.sumInsured || Number(r.sum_insured), currency: qd.currency || r.currency, conditions: qd.conditions || '', deductible: qd.deductible || setting('deductible_text', ''),
      special: qd.special || '', total: qd.total != null ? qd.total : r.premium, claims: setting('claims_text', 'Notify us immediately of any loss or damage. Note exceptions on the delivery receipt, keep damaged goods and packing, and hold carriers liable in writing within the time limits. A surveyor will be appointed where needed.'), note: ''
    };
    const f = (id, label, val, o) => `<div class="field"${o && o.wide ? ' style="grid-column:1/-1"' : ''}><label for="${id}">${esc(label)}</label>${o && o.area ? `<textarea id="${id}" rows="${o.rows || 2}" maxlength="1500">${esc(val)}</textarea>` : `<input id="${id}" maxlength="300" value="${esc(val == null ? '' : val)}">`}</div>`;
    const body = FC.el(`<div><div class="grid2">
        ${f('cnClient', 'Assured', d.client)}${f('cnAddr', 'Assured address', d.clientAddress)}${f('cnCo', 'Co-assured (comma separated)', d.coAssured.join(', '))}
        ${f('cnIns', 'Insurer(s)', d.insurer)}${f('cnPol', 'Policy / certificate no.', d.policyNo)}
        ${f('cnGoods', 'Goods', d.goods)}${f('cnPack', 'Packaging', d.packaging)}
        ${f('cnMarks', 'Marks & numbers / container no.', d.marks)}${f('cnDoc', 'B/L, AWB or CMR no.', d.transportDoc)}
        ${f('cnVessel', 'Vessel / flight / truck', d.vessel)}${f('cnDep', 'Sailing / departure', d.departure)}
        ${f('cnVoy', 'Voyage', d.voyage, { wide:true })}${f('cnPer', 'Period', d.period, { wide:true })}
        ${f('cnSI', 'Sum insured', d.sumInsured)}<div class="field"><label for="cnCur">Currency</label><select id="cnCur"><option ${d.currency === 'EUR' ? 'selected' : ''}>EUR</option><option ${d.currency === 'USD' ? 'selected' : ''}>USD</option></select></div>
        ${f('cnCond', 'Conditions', d.conditions, { area:true, wide:true })}${f('cnDed', 'Deductible', d.deductible)}${f('cnTot', 'Premium (total)', d.total)}
        ${f('cnSpec', 'Special conditions', d.special, { area:true, wide:true })}${f('cnClaims', 'In case of loss or damage', d.claims, { area:true, wide:true, rows:3 })}
        ${f('cnNote', 'Additional note (optional)', d.note, { area:true, wide:true })}
      </div><div class="err-msg" id="cnErr"></div></div>`);
    const v = id => body.querySelector('#' + id).value.trim();
    const build = () => {
      const si = FC.parseNum(v('cnSI'));
      if(!v('cnClient') || !v('cnGoods') || !(si > 0)){ body.querySelector('#cnErr').textContent = 'Assured, goods and sum insured are required.'; return null; }
      return { client:v('cnClient'), clientAddress:v('cnAddr'), coAssured: v('cnCo').split(',').map(s => s.trim()).filter(Boolean), insurer:v('cnIns'), policyNo:v('cnPol'), goods:v('cnGoods'), packaging:v('cnPack'), marks:v('cnMarks'),
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
        <div class="field"><label for="ivCur">Currency</label><select id="ivCur"><option ${r.currency === 'EUR' ? 'selected' : ''}>EUR</option><option ${r.currency === 'USD' ? 'selected' : ''}>USD</option></select></div></div>
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

  // =================================================================== CUSTOMERS
  async function renderCustomers(body){
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
      const rows = Object.values(P).filter(p => !s || [p.company, p.full_name, p.email, p.country].join(' ').toLowerCase().includes(s));
      wrap.innerHTML = `<table class="tbl"><thead><tr><th>Company</th><th>Contact</th><th>Status</th><th class="r">Indications</th><th class="r">Requests</th><th class="r">Bound</th><th class="r">Discount</th><th>Registered</th></tr></thead><tbody></tbody></table>`;
      rows.forEach(p => {
        const c = count[p.id] || { i:0, q:0, b:0 };
        const st = p.rejected ? chip('rejected', 'Rejected') : p.approved ? chip('approved', p.is_admin ? 'Admin' : 'Active') : chip('pending', 'Waiting');
        const tr = FC.el(`<tr class="click" tabindex="0"><td><b>${esc(p.company || '—')}</b>${p.deletion_requested_at ? ' ' + chip('declined', 'Deletion requested') : ''}</td><td>${esc(p.full_name || '')}<br><span class="xs muted">${esc(p.email)}</span></td><td>${st}</td><td class="r">${c.i}</td><td class="r">${c.q}</td><td class="r">${c.b}</td><td class="r">${esc(Number(p.client_discount_pct))} %</td><td class="xs">${esc(FC.date(p.created_at))}</td></tr>`);
        tr.addEventListener('click', () => editCustomer(p)); tr.addEventListener('keydown', e => { if(e.key === 'Enter') editCustomer(p); });
        wrap.querySelector('tbody').appendChild(tr);
      });
    };
    tb.querySelector('input').addEventListener('input', paint); paint();
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
      <div class="field" style="margin-top:12px"><label for="ecNote">Internal note</label><textarea id="ecNote" rows="2" maxlength="1000">${esc(p.internal_note || '')}</textarea></div>
      <label class="switch"><input type="checkbox" id="ecAdmin" ${p.is_admin ? 'checked' : ''} ${p.id === me().id ? 'disabled' : ''}><span><b>Staff access (Internal area)</b><span>Sees all customers, rates and requests.</span></span></label>
      <div class="err-msg" id="ecErr"></div></div>`);
    FC.dialog({ title: p.company || p.email, body, actions:[{ label:'Cancel', kind:'ghost', value:null }, { label:'Save', kind:'primary', onClick: async () => {
      const disc = FC.parseNum(body.querySelector('#ecDisc').value);
      if(!(disc >= 0 && disc < 100)){ body.querySelector('#ecErr').textContent = 'The discount must be between 0 and 99.99 %.'; return; }
      const st = body.querySelector('#ecStatus').value;
      const fn = body.querySelector('#ecFirst').value.trim(), ln = body.querySelector('#ecLast').value.trim();
      const patch = { full_name: [fn, ln].filter(Boolean).join(' ') || null, first_name: fn || null, last_name: ln || null, address_line: body.querySelector('#ecAddr').value.trim() || null, postcode: body.querySelector('#ecZip').value.trim() || null, city: body.querySelector('#ecCity').value.trim() || null, company: body.querySelector('#ecCo').value.trim() || null, country: body.querySelector('#ecCountry').value.trim() || null,
        phone: body.querySelector('#ecPhone').value.trim() || null, client_discount_pct: disc, internal_note: body.querySelector('#ecNote').value.trim() || null,
        approved: st === 'active', rejected: st === 'rejected' };
      if(p.id !== me().id) patch.is_admin = body.querySelector('#ecAdmin').checked;
      return (await upd(p.id, patch)) ? true : undefined;
    } }] });
  }

  // =================================================================== RATES
  let rateTab = 'tables', curTable = null;
  // per mille fields: a comma is always the decimal separator here (3,575 = 3.575, never 3575)
  const ppm = v => { const t = String(v == null ? '' : v).trim().replace(/\s/g, '').replace(/\.(?=.*,)/g, '').replace(',', '.'); return t === '' ? NaN : Number(t); };
  const pm = v => v == null || v === '' || !isFinite(Number(v)) ? '' : Number(v).toLocaleString('de-DE', { minimumFractionDigits:2, maximumFractionDigits:4 });
  function renderRates(body){
    body.innerHTML = `<p class="small muted" style="margin:0 0 14px">Rate (‰ of the sum insured) = route base rate (sea / air zone matrix without war, road / rail by band) × cargo class factor × cover × conveyance × packing × on deck × theft loading (land) × extra loading; plus war &amp; strikes (strikes on land) and crisis surcharge; × interest factor for seller's / buyer's interest. Minimum premium per schedule (land: setting). Countries without a zone, local-insurance countries, sanctioned countries and amounts over the limit go on request.</p>
      <div class="tabs" role="tablist">${[['tables','Schedules (zone matrices)'],['commodities','Cargo types'],['countries','Countries & zones'],['factors','Factors & limits'],['test','Test a calculation']].map(([k, l]) => `<button role="tab" data-rtab="${k}" aria-selected="${k === rateTab}">${l}</button>`).join('')}</div><div id="rtBody"></div>`;
    $$('[data-rtab]', body).forEach(b => b.addEventListener('click', () => { rateTab = b.dataset.rtab; renderRates(body); }));
    const host = $('#rtBody', body);
    ({ tables: rtTables, commodities: rtCommodities, countries: rtCountries, factors: rtFactors, test: rtTest })[rateTab](host);
  }
  // generic editable table
  function editTable(host, o){
    const wrap = FC.el('<div></div>'); host.appendChild(wrap);
    const tbar = FC.el(`<div class="toolbar">${o.search ? '<input class="input" type="search" placeholder="Search" aria-label="Search">' : ''}<span class="spacer" style="flex:1"></span>${o.add ? '<button class="btn btn-ghost btn-sm" type="button" data-add>Add row</button>' : ''}<button class="btn btn-primary btn-sm" type="button" data-save disabled><span class="spin"></span>Save changes</button></div>`);
    wrap.appendChild(tbar);
    const tw = FC.el('<div class="tbl-wrap"></div>'); wrap.appendChild(tw);
    const dirty = new Map();
    const rows = o.rows.map(r => Object.assign({}, r));
    const cell = (r, c) => {
      const v = r[c.k];
      if(c.type === 'bool') return `<input type="checkbox" data-k="${c.k}" ${v ? 'checked' : ''} aria-label="${esc(c.l)}" style="width:auto;min-width:0">`;
      if(c.type === 'select') return `<select data-k="${c.k}" aria-label="${esc(c.l)}">${c.options.map(([ov, ol]) => `<option value="${esc(ov)}" ${String(ov) === String(v) ? 'selected' : ''}>${esc(ol)}</option>`).join('')}</select>`;
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
    if(tbar.querySelector('input[type=search]')) tbar.querySelector('input[type=search]').addEventListener('input', paint);
    if(o.add) tbar.querySelector('[data-add]').addEventListener('click', () => { const r = Object.assign({ __new:true }, o.add()); rows.unshift(r); paint(); });
    tbar.querySelector('[data-save]').addEventListener('click', async e => {
      const b = e.currentTarget; busy(b, true);
      const payload = Array.from(dirty.values()).map(r => { let x = {}; o.cols.forEach(c => { if(!c.virtual && r[c.k] !== undefined) x[c.k] = r[c.k]; }); x[o.key] = r[o.key]; if(o.clean) x = o.clean(x); return x; });
      if(payload.some(x => !x[o.key])){ busy(b, false); toast('Every row needs an ID.', 'error'); return; }
      const { error } = await sb.from(o.table).upsert(payload, { onConflict: o.key, defaultToNull: false });
      busy(b, false);
      if(error){ toast('Could not save: ' + error.message, 'error'); return; }
      dirty.clear(); toast('Saved ' + payload.length + ' row(s).'); await loadAll(); render();
    });
    paint();
  }
  // ---- schedules: one matrix per rate table, upper triangle editable, Excel import in the Bertling layout
  // the rate breakdown in words, used in the case and in the test tab
  function explain(d){
    if(!d) return '';
    const parts = [['class', d.f_class], ['cover', d.f_cover], ['conveyance', d.f_conveyance], ['packing', d.f_packing], ['on deck', d.f_deck], ['theft', d.f_theft], ['extra', d.f_loading]]
      .filter(([, v]) => v != null && Number(v) !== 1).map(([k, v]) => k + ' ' + pm(v));
    const route = d.mode === 'land' ? 'land ' + String(d.band || '').replace('_', '-') : 'zone ' + d.zone_from + ' → ' + d.zone_to;
    return `${d.table_name}, ${route}: base ${pm(d.base_permille)} ‰${parts.length ? ' × ' + parts.join(' × ') : ''} = ${pm(d.cargo_permille)} ‰ + ${d.mode === 'land' ? 'strikes' : 'war'} ${pm(d.war_permille)} ‰${Number(d.crisis_permille) ? ' + crisis ' + pm(d.crisis_permille) + ' ‰' : ''}${Number(d.f_interest) !== 1 ? ', × interest ' + pm(d.f_interest) : ''} = ${pm(d.rate_permille)} ‰`;
  }
  function rtTables(host){
    if(!S.rateTables.length){ host.innerHTML = '<div class="empty card"><h3>No schedules yet</h3><p>Run update_2026-10-20c.sql in Supabase.</p></div>'; return; }
    if(!curTable || !S.rateTables.find(t => t.id === curTable)) curTable = S.rateTables[0].id;
    const t = S.rateTables.find(x => x.id === curTable);
    const bar = FC.el(`<div class="toolbar"><select class="input" id="tbSel" aria-label="Schedule">${S.rateTables.map(x => `<option value="${esc(x.id)}" ${x.id === curTable ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
      <span style="flex:1"></span><label class="btn btn-ghost btn-sm" style="cursor:pointer">Import Excel sheet<input type="file" id="tbFile" accept=".xls,.xlsx" hidden></label><button class="btn btn-primary btn-sm" id="tbSave" disabled><span class="spin"></span>Save changes</button></div>`);
    host.appendChild(bar);
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
    const save = bar.querySelector('#tbSave');
    host.addEventListener('input', e => { if(e.target.matches('input')){ e.target.classList.add('dirty'); save.disabled = false; } });
    host.addEventListener('change', e => { if(e.target.type === 'checkbox'){ save.disabled = false; } });
    bar.querySelector('#tbSel').addEventListener('change', e => { curTable = e.target.value; host.innerHTML = ''; rtTables(host); });
    bar.querySelector('#tbFile').addEventListener('change', async e => {
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
      busy(save, true);
      const num = id => { const el = host.querySelector(id); if(!el) return undefined; const x = el.value.trim(); return x === '' ? null : ppm(x); };
      const meta = { min_premium: num('#tbMin') || 0, war_included_permille: num('#tbWar') || 0, deck_allowed: host.querySelector('#tbDeck').checked, contingency_allowed: host.querySelector('#tbCont').checked, updated_at: new Date().toISOString() };
      if(t.mode === 'air'){ meta.used_loading_pct = num('#tbUsed'); meta.cars_loading_pct = num('#tbCars'); meta.household_flat_permille = num('#tbHh'); }
      const up = [], del = [];
      tw.querySelectorAll('input.dirty').forEach(inp => { const v = inp.value.trim(), a = Number(inp.dataset.a), b = Number(inp.dataset.b); if(v === '') del.push([a, b]); else { const x = ppm(v); if(isFinite(x) && x >= 0) up.push({ table_id: t.id, zone_a: a, zone_b: b, permille: x }); } });
      const r1 = await sb.from('rate_tables').update(meta).eq('id', t.id);
      const r2 = up.length ? await sb.from('rate_cells').upsert(up, { onConflict: 'table_id,zone_a,zone_b' }) : { error: null };
      for(const [a, b] of del){ await sb.from('rate_cells').delete().eq('table_id', t.id).eq('zone_a', a).eq('zone_b', b); }
      busy(save, false);
      const er = r1.error || r2.error; if(er) return toast('Could not save: ' + er.message, 'error');
      toast('Saved: ' + up.length + ' rates' + (del.length ? ', ' + del.length + ' removed' : '') + '.'); await loadAll(); host.innerHTML = ''; rtTables(host);
    });
  }
  function rtCommodities(host){
    const tables = [['', '— not by sea —']].concat(S.rateTables.filter(t => t.mode === 'sea').map(t => [t.id, t.name]));
    editTable(host, { table:'commodities', key:'id', rows:S.commodities, search:true,
      add: () => ({ id:'', name:'', group_name:'General & industrial', class_factor:1, sea_table:'sea_new', air_class:'new', allowed_covers:['icc_a','icc_b','icc_c'], active:true, on_request:false, sort:200, loading_pct:0 }),
      cols:[ { k:'id', l:'ID', ro:true, w:110 }, { k:'group_name', l:'Group', w:150 }, { k:'name', l:'Name', w:200 },
        { k:'class_factor', l:'Class factor', type:'num' },
        { k:'allowed_covers', l:'Covers', type:'covers' },
        { k:'sea_table', l:'Sea base rates', type:'select', options: tables },
        { k:'air_class', l:'By air', type:'select', options:[['', 'no'], ['new', 'yes']] },
        { k:'theft_attractive', l:'Theft-attractive', type:'bool' }, { k:'temp_controlled', l:'Temp.-controlled', type:'bool' },
        { k:'loading_pct', l:'Extra loading %', type:'num' }, { k:'max_sum_insured', l:'Max. sum insured', type:'num' },
        { k:'on_request', l:'Always on request', type:'bool' }, { k:'active', l:'Active', type:'bool' }, { k:'sort', l:'Sort', type:'num' },
        { k:'deductible', l:'Deductible (shown to clients)', w:240 },
        { k:'description', l:'Description (shown to clients)', w:220 }, { k:'conditions', l:'Special conditions', w:280 } ],
      clean: r => { if(r.sea_table === '') r.sea_table = null; if(r.air_class === '') r.air_class = null; if(r.class_factor == null) r.class_factor = 1; if(r.loading_pct == null) r.loading_pct = 0; ['theft_attractive','temp_controlled','on_request','active'].forEach(k => { if(k in r && r[k] == null) r[k] = k === 'active'; }); return r; } });
  }
  function rtCountries(host){
    const zs = n => [['', '— none —']].concat(Array.from({ length:n }, (_, i) => [String(i + 1), String(i + 1)]));
    const sea = (S.rateTables.find(t => t.mode === 'sea') || {}).zones || 19, air = (S.rateTables.find(t => t.mode === 'air') || {}).zones || 12;
    editTable(host, { table:'countries', key:'iso2', rows:S.countries.map(c => Object.assign({}, c, { sea_zone: c.sea_zone == null ? '' : String(c.sea_zone), air_zone: c.air_zone == null ? '' : String(c.air_zone) })), search:true,
      cols:[ { k:'iso2', l:'ISO', ro:true }, { k:'name', l:'Name', w:170 },
        { k:'sea_zone', l:'Sea zone', type:'select', options: zs(sea) }, { k:'air_zone', l:'Air zone', type:'select', options: zs(air) },
        { k:'local_insurance', l:'Local insurance rules (*)', type:'bool' }, { k:'crisis_permille', l:'Crisis surcharge ‰', type:'num' },
        { k:'on_request', l:'On request', type:'bool' }, { k:'sanctioned', l:'Sanctioned', type:'bool' }, { k:'note', l:'Note', w:200 } ],
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
      const nums = Object.entries(vals).filter(([k]) => !['land_groups','deductible_text'].includes(k)).flatMap(([, v]) => typeof v === 'object' ? Object.values(v) : [v]);
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
        <div class="field"><label>Invoice value (EUR)</label><input id="ttI" value="100000" inputmode="decimal"></div>
        <div class="field"><label>Cover</label><select id="ttK"><option value="icc_a">ICC A</option><option value="icc_b">ICC B</option><option value="icc_c">ICC C</option></select></div>
        <div class="field"><label>Packaging</label><select id="ttP">${Object.keys(Object.assign({ '':1 }, setting('packing_factors', {}))).map(k => `<option value="${esc(k)}">${esc(k || 'Not stated')}</option>`).join('')}</select></div>
      </div><div class="small" style="margin-top:12px;display:flex;gap:18px;flex-wrap:wrap"><label><input type="checkbox" id="ttW" checked> War &amp; strikes</label><label><input type="checkbox" id="ttDk"> On deck</label><label><input type="checkbox" id="ttIn"> Interest only</label></div>
      <div id="ttRun" style="margin-top:12px"></div><div id="ttOut" style="margin-top:14px"></div></div>`);
    host.appendChild(body);
    body.querySelector('#ttRun').appendChild(btn('Calculate', 'primary', async b => {
      busy(b, true);
      const v = id => body.querySelector(id).value, c = id => body.querySelector(id).checked;
      const { data, error } = await sb.rpc('calc_indication', { p: { commodity_id:v('#ttC'), goods_description:'Rate test', conveyance:v('#ttV'), origin_country:v('#ttO'), dest_country:v('#ttD'), invoice_value:FC.parseNum(v('#ttI')), currency:'EUR', uplift_pct:10, cover:v('#ttK'), packaging:v('#ttP'), war_strikes:c('#ttW'), on_deck:c('#ttDk'), interest_only:c('#ttIn') } });
      busy(b, false);
      if(error){ body.querySelector('#ttOut').innerHTML = `<div class="notice danger" style="margin:0">${esc(error.message)}</div>`; return; }
      await sb.from('indications').update({ is_test:true, hidden_by_user:true }).eq('id', data.id);
      loadAll();
      const d = data.calc_detail || {};
      body.querySelector('#ttOut').innerHTML = data.status === 'quoted'
        ? `<div class="notice ok" style="margin:0"><b>${esc(money2(data.premium, 'EUR'))} at ${esc(pm(d.rate_permille))} ‰</b>${esc(explain(d))}. Sum insured ${esc(money2(data.sum_insured, 'EUR'))}${data.min_applied ? ', minimum premium applied' : ''}${Number(data.discount_pct) ? ', your own discount ' + esc(Number(data.discount_pct)) + ' % applied' : ''}. Deductible: ${esc(data.deductible_text || '')}.</div>`
        : `<div class="notice warn" style="margin:0"><b>${esc(FC.STATUS[data.status])}</b>${esc((data.reasons || []).join('; '))}</div>`;
    }));
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
