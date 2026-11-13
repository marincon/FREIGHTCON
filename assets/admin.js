/* FREIGHTCON - internal area (admins only; the database enforces this, the UI only mirrors it) */
(function(){
  'use strict';
  const { $, $$, sb, esc, money2, busy, toast } = FC;
  const A = window.FCAdmin = {};
  let root = null, tab = 'requests', loaded = false;
  const S = { customers:[], custClauses:[], scopeSettings:[], zoneMaps:[], cellCache:{}, certs:[], clauses:[], polClauses:[], warAreas:[], warEx:[], rows:[], profiles:{}, commodities:[], regions:[], countries:[], settings:{}, insurers:[], quotes:{}, coverNotes:{}, rateTables:[], rateCells:[], qint:{}, claims:[], claimEvents:{}, claimFiles:{}, claimInt:{}, groups:[], policies:[], offices:[], audit:[], categories:[], templates:[], textFmt:[], ipt:null, polYears:[], matrices:[], sendHist:[] };
  const cName = iso => (S.countries.find(c => c.iso2 === iso) || {}).name || iso || '';
  const me = () => FC.profile || {};
  const myInitials = () => FC.initials(me().full_name || me().email);
  const setting = (k, d) => (S.settings[k] !== undefined ? S.settings[k] : d);

  const TABS = [['newq','New quotation'],['requests','Requests'],['quotations','Quotations'],['certificates','Certificates'],['claims','Claims'],['overview','Overview'],['ledger','Ledger'],['customers','Customers'],['rates','Rates'],['clauses','Clauses'],['insurers','Insurers'],['feedback','Feedback'],['settings','Settings']];

  A.open = async (host) => {
    root = host;
    if(!loaded){
      root.innerHTML = `<div class="view-head"><div><h1>Internal</h1><p>Requests, quotations, cover and customers.</p></div>
          <div class="toolbar" style="margin:0"><button class="btn btn-ghost btn-sm" id="admRefresh" type="button"><span class="spin"></span>Refresh</button><button class="btn btn-primary btn-sm" id="admExternal" type="button">External view</button></div></div>
        <div class="tabs" role="tablist">${TABS.map(([k, l]) => `<button role="tab" data-atab="${k}" aria-selected="${k === tab}">${l}<span class="badge" data-abadge="${k}" hidden></span></button>`).join('')}</div>
        <div id="admBody"></div>`;
      $$('[data-atab]', root).forEach(b => b.addEventListener('click', () => { tab = b.dataset.atab; $$('[data-atab]', root).forEach(x => x.setAttribute('aria-selected', String(x === b))); render(); }));
      $('#admExternal', root).addEventListener('click', () => FC.go(FC.lastExternal || 'new'));
      $('#admRefresh', root).addEventListener('click', async e => { const b = e.currentTarget; busy(b, true); try{ await loadAll(); }finally{ busy(b, false); } render(); toast('Updated.'); });
      loaded = true;
      await loadAll();
      // Chinese wall between staff roles: only the tabs of the own roles
      const allowed = TABS.map(t => t[0]).filter(canTab);
      $$('[data-atab]', root).forEach(b => { b.hidden = !allowed.includes(b.dataset.atab); });
      if(!allowed.includes(tab)) tab = allowed[0] || 'overview';
      $$('[data-atab]', root).forEach(x => x.setAttribute('aria-selected', String(x.dataset.atab === tab)));
    }
    render();
  };
  // staff roles: admin (everything), placing (requests, quotations, clients, policies), claims (claims)
  const TAB_ROLES = { newq:['placing'], requests:['placing'], quotations:['placing'], certificates:['placing'], claims:['claims'], overview:['placing','claims'], ledger:['placing'], customers:['placing'], rates:['placing'], clauses:['placing'], insurers:['admin'], feedback:['admin'], settings:['admin'] };
  const roles = () => S.myRoles || [];
  const hasRole = r => roles().includes('admin') || roles().includes(r);
  const isStaffAdmin = () => roles().includes('admin');
  const canTab = k => isStaffAdmin() || (TAB_ROLES[k] || ['admin']).some(r => roles().includes(r));
  A.hasRole = hasRole;

  async function loadAll(){
    const [ind, prof, com, reg, cty, set, ins, q, cn, rt, rc, qi, cl, ce, cf, cin, grp, pol, ofc, iin, aud, wa, wx, cla, pcl, crt, cus, ccl, sst, zmp, myr, ugr, dep, prm, cats, tpls, tfm, ipt, pyr, mtx, qsh] = await Promise.all([
      sb.from('indications').select('*').order('created_at', { ascending:false }).limit(1500),
      sb.from('profiles').select('*').order('created_at', { ascending:false }),
      sb.from('commodities').select('*').order('sort'),
      sb.from('regions').select('*').order('sort'),
      sb.from('countries').select('*').order('name'),
      sb.from('settings').select('*').order('key'),
      sb.from('insurers').select('*').order('name'),
      sb.from('quotations').select('id,indication_id,version,status,valid_until,created_at,created_by,responded_at,response_note,data,send_status,sent_at,send_count,display_mode').order('version'),
      sb.from('cover_notes').select('*').order('issued_at'),
      sb.from('rate_tables').select('*').order('sort'),
      Promise.resolve({ data:[] }),
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
      sb.from('policy_clauses').select('*'),
      sb.from('certificates').select('*').order('id'),
      sb.from('customers').select('*').order('sort'),
      sb.from('customer_clauses').select('*'),
      sb.from('scope_settings').select('*'),
      sb.from('zone_maps').select('*'),
      sb.rpc('my_staff_roles'), sb.from('user_groups').select('*').order('sort'), sb.from('departments').select('*').order('sort'), sb.from('role_dashboard_permissions').select('*'),
      sb.from('clause_categories').select('*').order('sort'), sb.from('text_templates').select('*').order('id'), sb.from('text_formatting').select('*'), sb.from('german_ipt_settings').select('*'),
      sb.from('policy_years').select('*').order('starts_on'), sb.from('certificate_numbering_matrices').select('*').order('id'),
      sb.from('quotation_send_history').select('id,quotation_id,indication_id,version,sent_at,sent_by,sent_by_name,recipient_email,delivery_method,is_resend,note').order('sent_at')
    ]);
    S.categories = cats.data || []; setCats(S.categories); S.templates = tpls.data || []; S.textFmt = tfm.data || []; S.ipt = (ipt.data || [])[0] || null;
    S.polYears = pyr.data || []; S.matrices = mtx.data || []; S.sendHist = qsh.data || [];
    S.myRoles = (myr.data || []).length ? myr.data : ['admin','placing','claims']; S.userGroups = ugr.data || []; S.departments = dep.data || []; S.perms = prm.data || [];
    S.customers = cus.data || []; S.custClauses = ccl.data || []; S.scopeSettings = sst.data || []; S.zoneMaps = zmp.data || []; S.cellCache = {};
    S.certs = crt.data || [];
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
    S.rateTables = rt.data || [];
    S.rows = ind.data || []; S.commodities = com.data || []; S.regions = reg.data || []; S.countries = cty.data || []; S.insurers = ins.data || [];
    S.profiles = {}; (prof.data || []).forEach(p => S.profiles[p.id] = p);
    S.settingRows = set.data || []; S.settings = {}; S.settingRows.forEach(s => S.settings[s.key] = s.value); FC.setPartyRoles(S.settings.party_roles);
    S.quotes = {}; (q.data || []).forEach(x => (S.quotes[x.indication_id] = S.quotes[x.indication_id] || []).push(x));
    S.coverNotes = {}; (cn.data || []).forEach(x => (S.coverNotes[x.indication_id] = S.coverNotes[x.indication_id] || []).push(x));
    paintBadges();
  }
  const stg = r => FC.stageOf(r.stage);
  const openRequests = () => S.rows.filter(r => (r.quote_requested_at && ['request','working_on_it'].includes(stg(r)) && !(S.quotes[r.id] || []).some(q => q.status !== 'superseded'))
    || (S.quotes[r.id] || []).some(q => q.status === 'open' && q.send_status === 'saved'));
  const issuedOf = r => (S.coverNotes[r.id] || []).length + S.certs.filter(c => c.indication_id === r.id).length;
  const acceptedNoCover = () => S.rows.filter(r => stg(r) === 'certificate' && !issuedOf(r));
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
    ({ newq: renderNewQuote, quotations: renderQuotations, certificates: renderCertificates, requests: renderRequests, claims: renderClaimsAdmin, overview: renderOverview, ledger: renderLedger, customers: renderCustomers, rates: renderRates, clauses: renderClauses, insurers: renderInsurers, feedback: renderFeedback, settings: renderSettings })[tab](body);
  }
  const chip = (cls, t) => `<span class="chip ${esc(cls)}">${esc(t)}</span>`;
  const btn = (label, kind, fn) => { const b = FC.el(`<button type="button" class="btn btn-${kind} btn-sm"><span class="spin"></span>${esc(label)}</button>`); b.addEventListener('click', e => fn(b, e)); return b; };
  const addrOf = p => [p.address_line, [p.postcode, p.city].filter(Boolean).join(' '), p.country].filter(Boolean).join(', ');
  A.addrOf = addrOf;
  const who = r => { const p = S.profiles[r.user_id] || {}; return { name: p.full_name || p.email || '-', company: r.company || p.company || '', email: p.email || '', p }; };
  // open covers: office → policy → group
  const ofcOf = id => S.offices.find(o => o.id === id) || null;
  const polOf = id => S.policies.find(o => o.id === id) || null;
  const grpOf = id => S.groups.find(o => o.id === id) || null;
  const domainGroup = email => { const d = String(email || '').split('@')[1]; return d ? S.groups.slice().sort((a, b) => a.sort - b.sort || a.id - b.id).find(g => (g.email_domains || []).includes(d.toLowerCase())) || null : null; };
  const custOf = id => S.customers.find(c => c.id === Number(id)) || null;
  const domainCust = email => { const d = String(email || '').split('@')[1]; return d ? S.customers.slice().sort((a, b) => a.sort - b.sort || a.id - b.id).find(c => c.active && (c.email_domains || []).includes(d.toLowerCase())) || null : null; };
  // which customer a user belongs to: office → profile → e-mail domain (as user_customer_id in the database)
  const userCust = p => { const o = ofcOf(p.office_id); return (o && custOf(o.customer_id)) || custOf(p.customer_id) || domainCust(p.email); };
  const userGroup = p => { const c = userCust(p); return (c && grpOf(c.group_id)) || grpOf(p.group_id) || domainGroup(p.email); };
  const coverOfUser = p => p.cover_type || (userCust(p) || {}).cover_type || 'one_off';
  // discount of a user (as eff_discount() in the database): off, special, else the client's
  const effDisc = p => !p ? 0 : p.discount_mode === 'off' ? 0 : p.discount_mode === 'special' ? Number(p.special_discount_pct || 0) : Number((userCust(p) || {}).discount_pct || 0);
  const discLabel = p => p.discount_mode === 'off' ? 'off' : p.discount_mode === 'special' ? 'special' : 'as client';
  // discount mode selector (user add / edit)
  const discModeHtml = p => `<div class="field"><label for="dmMode">Discount</label><select id="dmMode"><option value="default_client" ${!p || !p.discount_mode || p.discount_mode === 'default_client' ? 'selected' : ''}>Default as per client</option><option value="off" ${p && p.discount_mode === 'off' ? 'selected' : ''}>Off (0 %)</option><option value="special" ${p && p.discount_mode === 'special' ? 'selected' : ''}>Special (this user only)</option></select><input id="dmPct" inputmode="decimal" placeholder="Special discount %" value="${esc(p && p.special_discount_pct != null ? Number(p.special_discount_pct) : '')}" ${p && p.discount_mode === 'special' ? '' : 'hidden'} style="margin-top:6px" aria-label="Special discount %"><span class="hint" id="dmHint"></span></div>`;
  const wireDiscMode = (box, custFn) => { const m = box.querySelector('#dmMode'), pc = box.querySelector('#dmPct'), h = box.querySelector('#dmHint');
    const paint = () => { pc.hidden = m.value !== 'special'; const c = custFn(); h.textContent = m.value === 'default_client' ? (c ? c.name + ': ' + Number(c.discount_pct || 0) + ' %' : 'No client: 0 %') : ''; };
    m.addEventListener('change', paint); paint(); return paint; };
  const readDiscMode = box => { const m = box.querySelector('#dmMode').value, v = FC.parseNum(box.querySelector('#dmPct').value);
    if(m === 'special' && !(v >= 0 && v < 100)) return { error: 'The special discount must be between 0 and 99.99 %.' };
    return { discount_mode: m, special_discount_pct: m === 'special' ? v : null }; };
  const orgOfCase = r => { const o = ofcOf(r.office_id), po = polOf(r.policy_id) || (o && polOf(o.policy_id)), cu = custOf(r.customer_id) || (po && custOf(po.customer_id)) || (o && custOf(o.customer_id));
    return { office:o, policy: r.is_out_of_cover ? null : po, declared: r.is_out_of_cover ? polOf(r.declared_policy_id) : null, customer: cu, group: cu ? grpOf(cu.group_id) : po ? grpOf(po.group_id) : null }; };
  // currencies: office → policy → customer → group → general pool (first non-empty list, as allowed_currencies())
  const CURS = ['USD', 'GBP', 'EUR', 'SGD'];
  const nz = a => (a && a.length) ? a : null;
  const allowedCurs = (oId, pId, cId) => { const o = ofcOf(oId), po = polOf(pId), cu = custOf(cId), g = cu && grpOf(cu.group_id);
    return nz(o && o.currencies) || nz(po && po.currencies) || nz(cu && cu.currencies) || nz(g && g.currencies) || nz(setting('currencies', null)) || ['EUR', 'USD']; };
  const COVER_T = { one_off:'One-off', open_cover:'Open cover', policy:'Policy' };
  const polLabel = po => po ? po.name + (po.policy_no ? ' · ' + po.policy_no : '') : '';
  const curBoxes = (id, list) => `<div class="cur-boxes" id="${id}">${CURS.map(c => `<label><input type="checkbox" value="${c}" ${(list || []).includes(c) ? 'checked' : ''}> ${c}</label>`).join('')}</div><span class="hint">None ticked = as the level above.</span>`;
  const readCurs = (box, id) => Array.from(box.querySelectorAll('#' + id + ' input:checked')).map(i => i.value);

  // ---------------- configuration scopes: general one-off pool, a customer, a policy ----------------
  const GEN = { t:'one_off_general', id:null };
  const scKey = sc => sc.t === 'one_off_general' ? 'g' : (sc.t === 'customer' ? 'c' : 'p') + sc.id;
  const scParse = k => !k || k === 'g' ? GEN : { t: k[0] === 'c' ? 'customer' : 'policy', id: Number(k.slice(1)) };
  const scCust = sc => sc.t === 'customer' ? custOf(sc.id) : sc.t === 'policy' ? custOf((polOf(sc.id) || {}).customer_id) : null;
  const scName = sc => sc.t === 'one_off_general' ? 'General one-off pool' : sc.t === 'customer' ? ((custOf(sc.id) || {}).name || 'Customer') + ' - customer defaults' : 'Policy ' + polLabel(polOf(sc.id)) + ' (' + ((scCust(sc) || {}).name || '') + ')';
  const inScope = (row, sc) => row.scope_type === sc.t && (row.scope_id == null ? null : Number(row.scope_id)) === sc.id;
  const scopeOptions = (sel, o) => `<option value="g" ${scKey(sel) === 'g' ? 'selected' : ''}>General · one-offs</option>` + S.customers.filter(c => !(o && o.coversOnly) || c.cover_type !== 'one_off').map(c =>
    `<optgroup label="${esc(c.name)}"><option value="c${c.id}" ${scKey(sel) === 'c' + c.id ? 'selected' : ''}>${esc(c.name)} - customer defaults</option>${S.policies.filter(po => po.customer_id === c.id).map(po => `<option value="p${po.id}" ${scKey(sel) === 'p' + po.id ? 'selected' : ''}>Policy ${esc(polLabel(po))}</option>`).join('')}</optgroup>`).join('');

  // ---------------- three-dots row menu ----------------
  let openKm = null;
  const closeMenu = () => { if(openKm){ openKm.remove(); openKm = null; } };
  document.addEventListener('click', closeMenu); document.addEventListener('keydown', e => { if(e.key === 'Escape') closeMenu(); });
  window.addEventListener('scroll', closeMenu, true);
  function openMenu(anchor, items){
    closeMenu();
    const list = items.filter(Boolean);
    const m = FC.el(`<div class="kmenu" role="menu">${list.map((it, i) => it === '-' ? '<hr>' : `<button type="button" role="menuitem" data-i="${i}" class="${it[2] === 'danger' ? 'danger' : ''}">${esc(it[0])}</button>`).join('')}</div>`);
    document.body.appendChild(m); openKm = m;
    const r = anchor.getBoundingClientRect(), w = m.offsetWidth, h = m.offsetHeight;
    m.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)) + 'px';
    m.style.top = (r.bottom + h + 8 > window.innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4) + 'px';
    m.addEventListener('click', e => { e.stopPropagation(); const b = e.target.closest('[data-i]'); if(!b) return; closeMenu(); list[+b.dataset.i][1](); });
    const first = m.querySelector('button'); if(first) first.focus();
    m.addEventListener('keydown', e => { const bs = Array.from(m.querySelectorAll('button')), i = bs.indexOf(document.activeElement);
      if(e.key === 'ArrowDown'){ e.preventDefault(); (bs[i + 1] || bs[0]).focus(); } if(e.key === 'ArrowUp'){ e.preventDefault(); (bs[i - 1] || bs[bs.length - 1]).focus(); } });
  }
  const kebab = items => { const b = FC.el('<button type="button" class="kebab" aria-label="Actions" aria-haspopup="menu" title="Actions">⋮</button>'); b.addEventListener('click', e => { e.stopPropagation(); openMenu(b, typeof items === 'function' ? items() : items); }); return b; };
  A.kebab = kebab;

  // ---------------- list with select-all, row checkboxes, ⋮ menu and a bulk toolbar ----------------
  // o: { host, rows, id(r), cols:[{ l, cls, html(r) }], menu(r) → items, bulk:[[label, fn(rows), kind]], empty, sel:Set, search(r) → text, toolbar(node) }
  function selList(o){
    const sel = o.sel || new Set(), id = o.id || (r => r.id);
    const wrap = FC.el(`<div class="sel-list"><div class="toolbar">${o.search ? '<input class="input" type="search" placeholder="' + esc(o.placeholder || 'Search') + '" aria-label="Search">' : ''}<span style="flex:1"></span></div>
      <div class="bulkbar" hidden><b class="bk-n"></b><span class="bk-acts"></span><button type="button" class="linkbtn bk-clear">Clear selection</button></div><div class="tbl-wrap"></div></div>`);
    o.host.appendChild(wrap);
    const tbar = wrap.querySelector('.toolbar'), bar = wrap.querySelector('.bulkbar'), tw = wrap.querySelector('.tbl-wrap'), q = tbar.querySelector('input');
    if(o.toolbar) o.toolbar(tbar);
    let shown = [];
    const paintBar = () => { const n = Array.from(sel).filter(k => o.rows.some(r => id(r) === k)).length; bar.hidden = !n; bar.querySelector('.bk-n').textContent = n + ' selected';
      const all = tw.querySelector('.sl-all'); if(all){ all.checked = shown.length && shown.every(r => sel.has(id(r))); all.indeterminate = !all.checked && shown.some(r => sel.has(id(r))); } };
    (o.bulk || []).forEach(([label, fn, kind]) => { const b = btn(label, kind || 'ghost', async bb => { const rows = o.rows.filter(r => sel.has(id(r))); if(!rows.length) return; busy(bb, true); try{ await fn(rows, sel); }finally{ if(bb.isConnected) busy(bb, false); } }); bar.querySelector('.bk-acts').appendChild(b); });
    bar.querySelector('.bk-clear').addEventListener('click', () => { sel.clear(); paint(); });
    const paint = () => {
      const s = q ? q.value.trim().toLowerCase() : '';
      shown = o.rows.filter(r => !s || (o.search(r) || '').toLowerCase().includes(s));
      if(!shown.length){ tw.innerHTML = `<div class="empty">${esc(o.rows.length ? 'No matches.' : (o.empty || 'Nothing here yet.'))}</div>`; paintBar(); return; }
      tw.innerHTML = `<table class="tbl sel-tbl"><thead><tr>${o.bulk ? '<th class="cb"><input type="checkbox" class="sl-all" aria-label="Select all"></th>' : ''}${o.cols.map(c => `<th class="${c.cls || ''}">${esc(c.l)}</th>`).join('')}${o.menu ? '<th class="km"></th>' : ''}</tr></thead><tbody></tbody></table>`;
      const tb = tw.querySelector('tbody');
      shown.slice(0, o.max || 500).forEach(r => {
        const tr = FC.el(`<tr>${o.bulk ? `<td class="cb"><input type="checkbox" class="sl-row" aria-label="Select" ${sel.has(id(r)) ? 'checked' : ''}></td>` : ''}${o.cols.map(c => `<td class="${c.cls || ''}">${c.html(r)}</td>`).join('')}${o.menu ? '<td class="km"></td>' : ''}</tr>`);
        if(o.menu) tr.querySelector('td.km').appendChild(kebab(() => o.menu(r)));
        const cb = tr.querySelector('.sl-row'); if(cb) cb.addEventListener('change', () => { cb.checked ? sel.add(id(r)) : sel.delete(id(r)); paintBar(); });
        if(o.onRow) o.onRow(tr, r);
        tb.appendChild(tr);
      });
      const all = tw.querySelector('.sl-all'); if(all) all.addEventListener('change', () => { shown.forEach(r => all.checked ? sel.add(id(r)) : sel.delete(id(r))); paint(); });
      paintBar();
    };
    if(q) q.addEventListener('input', paint);
    paint();
    return { paint, sel, wrap };
  }
  const csvSave = (name, head, rows) => { const cell = v => { const t = String(v == null ? '' : v); return /[",;\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
    FC.saveBlob('\ufeff' + [head].concat(rows).map(l => l.map(cell).join(';')).join('\n'), name + '_' + FC.today() + '.csv', 'text/csv;charset=utf-8'); };
  const amt = (v, c) => v == null || v === '' ? '-' : money2(v, c);
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
  const quoteExpired = r => { const l = liveQuotes(r).pop(); return stg(r) === 'quotation' && l && l.status === 'open' && new Date(l.valid_until) < Date.now(); };
  // Case outcome: open (requested, still in play), won (certificate / completed), lost (closed otherwise, quote expired)
  function bucket(r){
    const s2 = stg(r);
    if(s2 === 'certificate') return 'won';
    if(s2 === 'closed') return r.closure_reason === 'completed' || issuedOf(r) ? 'won' : 'lost';
    if(quoteExpired(r)) return 'lost';
    return r.quote_requested_at ? 'open' : 'calc';
  }
  // stage badge with its sub-badge and the time of the last change
  const STAGE_CLS = { request:'pending', working_on_it:'in_progress', quotation:'quoted', certificate:'accepted', closed:'neutral' };
  const unsent = r => (S.quotes[r.id] || []).some(q => q.status === 'open' && q.send_status === 'saved');
  const stageSub = r => { const s2 = stg(r);
    if(s2 === 'quotation') return quoteExpired(r) ? 'Quote expired' : unsent(r) ? 'Saved - not sent' : liveQuotes(r).some(q => q.send_status !== 'saved') ? 'Sent to client' : '';
    if(s2 === 'certificate') return issuedOf(r) ? 'Issued' : 'Accepted - to issue';
    if(s2 === 'closed') return FC.CLOSURE[r.closure_reason] || '';
    if(s2 === 'working_on_it') return r.status_note ? r.status_note.slice(0, 40) : '';
    return ''; };
  const stageChip = r => { const s2 = stg(r), sub = stageSub(r);
    return chip(STAGE_CLS[s2] || 'neutral', FC.STAGE[s2] || s2) + (sub ? ' ' + chip(sub === 'Saved - not sent' || sub === 'Accepted - to issue' ? 'pending' : sub === 'Quote expired' ? 'expired' : 'neutral', sub) : '')
      + (r.stage_changed_at ? `<br><span class="xs muted">since ${esc(FC.dateTime(r.stage_changed_at))}</span>` : ''); };
  A.stageChip = stageChip;
  // close a case with its reason
  async function closeCases(ids){
    const body = FC.el(`<div><div class="field"><label for="ccReason">Closure reason</label><select id="ccReason">${Object.entries(FC.CLOSURE).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select></div>
      <div class="field"><label for="ccNote">Internal note (optional)</label><input id="ccNote" maxlength="300"></div></div>`);
    const ok = await FC.dialog({ title: 'Close ' + (ids.length > 1 ? ids.length + ' cases' : 'case'), body, actions:[{ label:'Cancel', kind:'ghost', value:false }, { label:'Close', kind:'primary', onClick: async () => {
      const patch = { stage:'closed', closure_reason: body.querySelector('#ccReason').value }; const nt = body.querySelector('#ccNote').value.trim(); if(nt) patch.status_note = nt;
      const { error } = await sb.from('indications').update(patch).in('id', ids); if(error){ toast(error.message, 'error'); return; } return true; } }] });
    if(ok){ toast('Closed.'); await loadAll(); render(); }
    return ok;
  }
  const moveStage = async (ids, st, extra) => { const { error } = await sb.from('indications').update(Object.assign({ stage: st }, extra || {})).in('id', ids); if(error){ toast(error.message, 'error'); return false; } toast('Moved to ' + FC.STAGE[st] + '.'); await loadAll(); render(); return true; };
  A.bucket = bucket;
  const wonQuote = r => liveQuotes(r).filter(q => q.status === 'accepted').pop() || liveQuotes(r).pop();
  const brokerageOf = r => { const q = wonQuote(r), x = q && S.qint[q.id]; return x ? { amount: Number(x.brokerage_amount) || 0, pct: Number(x.brokerage_pct) || 0, insurer: x.insurer_name, currency: x.currency || r.currency } : null; };
  function renderRequests(body){
    const open = openRequests(), acc = acceptedNoCover(), real = S.rows.filter(r => !r.is_test);
    const n = k => real.filter(r => bucket(r) === k).length;
    const brk = {}; real.filter(r => bucket(r) === 'won').forEach(r => { const b = brokerageOf(r); if(b) brk[b.currency] = (brk[b.currency] || 0) + b.amount; });
    const brkTxt = Object.keys(brk).length ? Object.entries(brk).map(([c, v]) => money2(v, c)).join(' · ') : '-';
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
      <span style="flex:1"></span><button class="btn btn-ghost btn-sm" id="rqCsv" type="button">Export CSV</button><button class="btn btn-primary btn-sm" id="rqNew" type="button">+ New quotation</button></div>`);
    body.appendChild(tb);
    const stTabs = FC.el(`<div class="stage-tabs" role="tablist" aria-label="Stage">${[['', 'All stages']].concat(Object.entries(FC.STAGE)).map(([k, l]) => `<button type="button" role="tab" data-stg="${k}" aria-selected="${rqFilter.stage === k}">${esc(l)} <span class="n">${k ? S.rows.filter(r => r.quote_requested_at && stg(r) === k).length : ''}</span></button>`).join('')}</div>`);
    body.appendChild(stTabs);
    stTabs.addEventListener('click', e => { const b = e.target.closest('[data-stg]'); if(!b) return; rqFilter.stage = b.dataset.stg; if(rqFilter.stage && rqFilter.scope === 'open') rqFilter.scope = 'requests'; $('#rqScope', tb).value = rqFilter.scope; stTabs.querySelectorAll('[data-stg]').forEach(x => x.setAttribute('aria-selected', String(x === b))); paint(); });
    const bulk = FC.el(`<div class="bulkbar" hidden><b id="rqN"></b><span class="bk-acts"><button class="btn btn-ghost btn-sm" type="button" id="rqStageQ"><span class="spin"></span>Move to working on it</button><button class="btn btn-ghost btn-sm" type="button" id="rqClose"><span class="spin"></span>Close…</button><button class="btn btn-ghost btn-sm" type="button" id="rqMine"><span class="spin"></span>Assign to me</button><button class="btn btn-ghost btn-sm" type="button" id="rqCsvSel">Export selected</button><button class="btn btn-danger btn-sm" id="rqDel" type="button"><span class="spin"></span>Delete</button></span><button type="button" class="linkbtn" id="rqClr">Clear selection</button></div>`);
    body.appendChild(bulk);
    $('#rqNew', tb).addEventListener('click', () => { tab = 'newq'; $$('[data-atab]', root).forEach(x => x.setAttribute('aria-selected', String(x.dataset.atab === 'newq'))); render(); });
    $('#rqScope', tb).value = rqFilter.scope;
    const wrap = FC.el('<div class="tbl-wrap"></div>'); body.appendChild(wrap);
    const delBtn = $('#rqDel', bulk);
    const paintSel = () => { bulk.hidden = !selected.size; $('#rqN', bulk).textContent = selected.size + ' selected'; };
    $('#rqClr', bulk).addEventListener('click', () => { selected.clear(); paint(); });
    $('#rqCsvSel', bulk).addEventListener('click', () => exportCsv(S.rows.filter(r => selected.has(r.id))));
    const bulkUpd = async (b, patch, msg) => { busy(b, true); const { error } = await sb.from('indications').update(patch).in('id', Array.from(selected)); busy(b, false); if(error) return toast(error.message, 'error'); toast(msg); await loadAll(); render(); };
    $('#rqStageQ', bulk).addEventListener('click', e => bulkUpd(e.currentTarget, { stage:'working_on_it' }, 'Moved to working on it.'));
    $('#rqClose', bulk).addEventListener('click', () => closeCases(Array.from(selected)).then(ok => ok && selected.clear()));
    $('#rqMine', bulk).addEventListener('click', e => bulkUpd(e.currentTarget, { owner: myInitials() }, 'Assigned to you.'));
    const paint = () => {
      const rows = filteredRequests();
      const ids = new Set(rows.map(r => r.id)); Array.from(selected).forEach(id => { if(!ids.has(id)) selected.delete(id); }); paintSel();
      body.querySelectorAll('[data-scope]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.scope === rqFilter.scope)));
      if(!rows.length){ wrap.innerHTML = `<div class="empty"><h3>${rqFilter.scope === 'open' ? 'Nothing to do' : 'No matches'}</h3><p>${rqFilter.scope === 'open' ? 'New requests and accepted quotations appear here.' : 'Change the search or filters.'}</p></div>`; return; }
      const showBrk = rqFilter.scope === 'b_won';
      wrap.innerHTML = `<table class="tbl"><thead><tr><th style="width:28px"><input type="checkbox" id="rqAll" aria-label="Select all" style="width:auto;min-width:0"></th><th>Reference</th><th>Received</th><th>Customer</th><th>Route</th><th>Goods</th><th class="r">Sum insured</th><th>${showBrk ? 'Premium / brokerage' : 'Indication'}</th><th>Stage</th><th>Owner</th><th class="km"></th></tr></thead><tbody></tbody></table>`;
      const tbody = wrap.querySelector('tbody');
      rows.slice(0, 400).forEach(r => {
        const w = who(r), bk = bucket(r);
        const wq = wonQuote(r), b = brokerageOf(r);
        const third = showBrk ? `${wq ? '<span class="num">' + esc(money2(wq.data.total, wq.data.currency)) + '</span>' : '-'}${b ? '<br><span class="xs num muted">' + esc(money2(b.amount, b.currency)) + ' (' + esc(b.pct) + ' %)' + (b.insurer ? ', ' + esc(b.insurer) : '') + '</span>' : ''}`
          : `${chip(r.status, FC.STATUS[r.status])}${r.premium != null ? '<br><span class="xs num">' + esc(money2(r.premium, r.currency)) + '</span>' : ''}`;
        const tr = FC.el(`<tr>
          <td data-nosel><input type="checkbox" class="rqSel" aria-label="Select" ${selected.has(r.id) ? 'checked' : ''} style="width:auto;min-width:0"></td>
          <td><button type="button" class="linkbtn rq-open"><b>${esc(r.ref || '#' + r.id)}</b></button>${r.is_out_of_cover ? ' ' + chip('declined', 'Out of cover') : ''}${r.is_standalone_one_off ? ' ' + chip('neutral', 'Standalone one-off') : ''}${r.is_direct_certificate ? ' ' + chip('accepted', 'Direct certificate') : ''}${(r.alerts || []).length ? ' <span class="al-dots">' + alertDots(r) + '</span>' : ''}${r.is_test ? ' ' + chip('neutral', 'Test') : ''}${bk === 'won' ? ' ' + chip('accepted', 'Won') : bk === 'lost' ? ' ' + chip('declined', 'Lost') : ''}</td>
          <td class="xs">${esc(FC.ago(r.quote_requested_at || r.created_at))}${r.quote_requested_at ? '' : '<br><span class="muted">no request</span>'}</td>
          <td>${esc(w.company)}${r.policy_id ? ' ' + chip('neutral', 'Open cover') : ''}${r.intake ? ' ' + chip('pending', 'Intake') : ''}<br><span class="xs muted">${esc(r.insured_name ? 'for ' + r.insured_name : w.name)}</span></td>
          <td><b>${esc(r.origin_country)} → ${esc(r.dest_country)}</b><br><span class="xs muted">${esc((FC.CONVEYANCE[r.conveyance] || {}).short)}</span></td>
          <td>${esc(r.goods_description.slice(0, 60))}</td>
          <td class="r num">${esc(money2(r.sum_insured, r.currency))}</td>
          <td>${third}</td>
          <td>${stageChip(r)}</td><td>${esc(r.owner || '')}</td><td class="km"></td></tr>`);
        tr.querySelector('td.km').appendChild(kebab(() => requestMenu(r)));
        tr.querySelector('.rq-open').addEventListener('click', e => { e.stopPropagation(); openCase(r.id); });
        const cb = tr.querySelector('.rqSel');
        cb.addEventListener('click', e => e.stopPropagation());
        cb.addEventListener('change', () => { cb.checked ? selected.add(r.id) : selected.delete(r.id); paintSel(); });
        tr.querySelector('[data-nosel]').addEventListener('click', e => { if(e.target === e.currentTarget){ e.stopPropagation(); cb.click(); } });
        tbody.appendChild(tr);
      });
      const all = $('#rqAll', wrap);
      all.checked = rows.slice(0, 400).every(r => selected.has(r.id));
      all.addEventListener('change', () => { rows.slice(0, 400).forEach(r => all.checked ? selected.add(r.id) : selected.delete(r.id)); paint(); });
    };
    body.querySelectorAll('[data-scope]').forEach(b => b.addEventListener('click', () => { rqFilter.scope = b.dataset.scope; $('#rqScope', tb).value = rqFilter.scope; paint(); }));
    $('#rqQ', tb).addEventListener('input', e => { rqFilter.q = e.target.value; paint(); });
    $('#rqScope', tb).addEventListener('change', e => { rqFilter.scope = e.target.value; paint(); });
    $('#rqCsv', tb).addEventListener('click', () => exportCsv(filteredRequests()));
    delBtn.addEventListener('click', async () => {
      const ids = Array.from(selected); if(!ids.length) return;
      busy(delBtn, false);
      if(!(await FC.confirm('Delete ' + ids.length + ' case' + (ids.length > 1 ? 's' : '') + '?', 'Indications, quotations, cover notes, notes and invoice files are deleted for good. The clients no longer see them either.', 'Delete for good', 'danger'))) return;
      busy(delBtn, true);
      const ok = await deleteCases(ids);
      busy(delBtn, false);
      if(ok){ selected.clear(); await loadAll(); render(); toast(ids.length + ' deleted.'); }
    });
    paint();
  }
  // ⋮ menu of a request
  function requestMenu(r){
    const live = liveQuotes(r), last = live[live.length - 1];
    return [
      ['Open case', () => openCase(r.id)],
      [live.length ? (last.send_status === 'saved' && last.status === 'open' ? 'Edit saved quotation' : 'New quotation version') : 'Create quotation', async () => { if(stg(r) === 'request') await sb.from('indications').update({ stage:'working_on_it', owner: r.owner || myInitials() }).eq('id', r.id); quotationEditor(r, last && last.data, last && last.id, { draft: last && last.status === 'open' && last.send_status === 'saved' ? last : null }).then(async ok => { await loadAll(); render(); }); }],
      last && last.status === 'open' ? [last.send_status === 'saved' ? 'Send to client' : 'Resend to client', () => sendDialog(last, r)] : null,
      stg(r) === 'request' ? ['Move to working on it', () => moveStage([r.id], 'working_on_it', { owner: r.owner || myInitials() })] : null,
      stg(r) !== 'closed' ? ['Close case…', () => closeCases([r.id])] : ['Reopen (working on it)', () => moveStage([r.id], 'working_on_it')],
      S.certs.some(c => c.indication_id === r.id) ? ['Download certificate .fdf', () => fdfDownload(S.certs.filter(c => c.indication_id === r.id).pop())] : null,
      ['Text to insurer', () => insurerText(r)],
      ['Copy text for customer', async () => { const ok = await FC.copyRich(FC.emailHtml(indicationHtml(r)), FC.htmlText(indicationHtml(r))); toast(ok ? 'Copied.' : 'Copy failed.', ok ? undefined : 'error'); }],
      ['Indication PDF', async () => { try{ FC.saveBlob(await FCPDF.indication(indRow(r)), FCPDF.fileName('MARINCON_Indication', r.ref || r.id)); }catch(e){ console.error(e); toast('PDF failed.', 'error'); } }],
      ['Assign to me', async () => { await sb.from('indications').update({ owner: myInitials() }).eq('id', r.id); await loadAll(); render(); }],
      '-',
      ['Delete case', async () => { if(!(await FC.confirm('Delete this case?', 'The indication, its quotations, cover notes, notes and invoices are deleted for good.', 'Delete for good', 'danger'))) return; if(await deleteCases([r.id])){ await loadAll(); render(); toast('Deleted.'); } }, 'danger']
    ];
  }
  // an indication as the PDF / text builders expect it
  const indRow = r => Object.assign({}, r, { origin_name: r.origin_name || cName(r.origin_country), dest_name: r.dest_name || cName(r.dest_country), commodity_name: r.commodity_name || (S.commodities.find(c => c.id === r.commodity_id) || {}).name, deductible_text: r.deductible_text || setting('deductible_text', '') });
  // short text for the customer (e-mail / chat): route, goods, sum insured, rate and premium, conditions
  function indicationHtml(r, extra){
    const x = indRow(r), conv = FC.CONVEYANCE[x.conveyance] || {};
    const rows = [['Reference', x.ref || ''], ['Goods', x.goods_description], ['Cargo type', x.commodity_name], ['Voyage', [x.origin_place, x.origin_name].filter(Boolean).join(', ') + ' to ' + [x.dest_place, x.dest_name].filter(Boolean).join(', ') + ((x.transit_countries || []).length ? ' via ' + x.transit_countries.map(cName).join(', ') : '')],
      ['Conveyance', conv.label || x.conveyance], ['Departure date / ETA of loading', x.departure_date ? FC.date(x.departure_date) : 'tba'], ['Sum insured', money2(x.sum_insured, x.currency)],
      ['Cover', ((FC.COVER[x.cover] || {}).clause || '') + (x.war_strikes ? ', war & strikes included' : '')]];
    if(x.status === 'quoted') rows.push(['Rate', FC.pct(x.rate_pct)], ['Premium (excl. insurance tax)', money2(x.premium, x.currency) + (x.min_applied ? ' (minimum premium)' : '')]);
    else rows.push(['Premium', 'on request - we come back to you']);
    if(x.deductible_text) rows.push(['Deductible', x.deductible_text]);
    return `<h4>Marine cargo insurance - indication${x.ref ? ' ' + esc(x.ref) : ''}</h4>${rows.map(([k, v]) => `<p><b>${esc(k)}:</b> ${esc(v || '-')}</p>`).join('')}${x.conditions ? `<p><b>Special conditions:</b> ${esc(x.conditions)}</p>` : ''}${extra || ''}<p>This indication is non-binding and subject to underwriters' acceptance. Cover attaches only with our written confirmation.</p>`;
  }
  A.indicationHtml = indicationHtml;
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
      if(rqFilter.stage && stg(r) !== rqFilter.stage) return false;
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
          <dt>Packaging</dt><dd>${esc(r.packaging || '-')}</dd>
          <dt>Route</dt><dd>${esc([r.origin_place, cName(r.origin_country)].filter(Boolean).join(', '))} → ${esc([r.dest_place, cName(r.dest_country)].filter(Boolean).join(', '))}</dd>
          <dt>Conveyance</dt><dd>${esc(conv.label || r.conveyance)}${r.departure_date ? ', departs ' + esc(FC.date(r.departure_date)) : ''}</dd>
          ${/^sea_/.test(r.conveyance) ? `<dt>Vessel</dt><dd>${esc(r.vessel || 'Not stated - ask the client')} <span class="xs muted">check age, class (IACS), flag, sanctions</span></dd>` : ''}
          ${r.incoterm ? `<dt>Incoterm</dt><dd>${esc(r.incoterm)} (${esc((FC.INCOTERMS[r.incoterm] || {}).name || '')}), ${esc(FC.partyLabel(r.insured_party, r.party_role_other))}${FC.noRisk(r.incoterm, r.insured_party) ? ' <span class="chip pending">client carries no transit risk</span>' : ''}</dd>` : ''}
          <dt>Values</dt><dd>Invoice ${esc(money2(r.invoice_value, r.currency))}${Number(r.freight_value) > 0 ? ' + freight ' + esc(money2(r.freight_value, r.currency)) : ''} + ${esc(Number(r.uplift_pct))} % = ${esc(money2(r.sum_insured, r.currency))}${r.rate_pct != null && Number(r.rate_pct) < 100 ? `<br><span class="xs muted">CIF gross-up: ${esc(money2(Number(r.invoice_value) + Number(r.freight_value || 0), r.currency))} / (1 - ${esc(FC.pct(r.rate_pct))}) = ${esc(money2((Number(r.invoice_value) + Number(r.freight_value || 0)) / (1 - Number(r.rate_pct) / 100), r.currency))} · × 110 % = ${esc(money2((Number(r.invoice_value) + Number(r.freight_value || 0)) / (1 - Number(r.rate_pct) / 100) * 1.1, r.currency))}</span>` : ''}</dd>
          ${(r.transit_countries || []).length ? `<dt>Via</dt><dd>${esc(r.transit_countries.map(cName).join(', '))}</dd>` : ''}
          ${/^sea_/.test(r.conveyance) ? `<dt>Routing</dt><dd>${esc({ auto:'Suez / Red Sea not stated', yes:'Via Suez / Red Sea', no:'Not via Suez (e.g. the Cape)' }[r.red_sea || 'auto'])}</dd>` : ''}
          ${r.insured_country ? `<dt>Assured domicile</dt><dd>${esc(cName(r.insured_country))}${r.insured_country === 'AE' ? ' · FTZ: ' + (r.ftz == null ? 'not known' : r.ftz ? 'yes' : 'no, mainland') : ''}</dd>` : ''}
          ${Object.keys(r.details || {}).length ? `<dt>Details</dt><dd class="small">${[['equipment','Equipment'],['pieces','Pieces'],['weight_kg','Gross weight kg'],['dimensions','Dimensions'],['hs_code','HS code'],['vessel_year','Vessel built'],['storage','Storage']].filter(([k]) => r.details[k]).map(([k, l]) => esc(l) + ': <b>' + esc(k === 'storage' ? (r.details[k] === '30' ? '30-60 days' : 'over 60 days') : r.details[k]) + '</b>').join(' · ')}${r.details.parties ? '<br>Co-assureds / loss payees: ' + esc(r.details.parties).replace(/\n/g, '; ') : ''}</dd>` : ''}
          <dt>Cover</dt><dd>${esc((FC.COVER[r.cover] || {}).clause)}, war &amp; strikes ${r.war_strikes ? 'included' : 'not included'}</dd>
          ${r.customer_comment ? `<dt>Customer message</dt><dd>${esc(r.customer_comment)}</dd>` : ''}
        </dl></section>
        <section><h3>Customer</h3><dl class="kv">
          <dt>Company</dt><dd>${esc(w.company)}${addrOf(w.p) ? '<br><span class="xs muted">' + esc(addrOf(w.p)) + '</span>' : ''}</dd><dt>Contact</dt><dd>${esc(w.name)}, <a href="mailto:${esc(w.email)}">${esc(w.email)}</a>${w.p.phone ? ', ' + esc(w.p.phone) : ''}</dd>
          <dt>Discount</dt><dd>${esc(effDisc(w.p))} % <span class="xs muted">(${esc(discLabel(w.p))})</span></dd>
          ${w.p.internal_note ? `<dt>Internal note</dt><dd>${esc(w.p.internal_note)}</dd>` : ''}</dl></section>
        <section><h3>Handling</h3>
          <div class="grid3">
            <div class="field"><label for="csStage">Stage</label><select id="csStage">${Object.entries(FC.STAGE).map(([k, v]) => `<option value="${k}" ${k === stg(r) ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
            <div class="field"><label for="csOwner">Assigned broker</label><input id="csOwner" maxlength="20" value="${esc(r.owner || '')}" placeholder="${esc(myInitials())}"></div>
            <div class="field"><label for="csFollow">Follow up</label><input id="csFollow" type="date" value="${esc(r.follow_up || '')}"></div>
            <div class="field" id="csReasonF" ${stg(r) === 'closed' ? '' : 'hidden'}><label for="csReason">Closure reason</label><select id="csReason">${Object.entries(FC.CLOSURE).map(([k, l]) => `<option value="${k}" ${k === r.closure_reason ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
            <div class="field" style="grid-column:span 2"><label for="csStNote">Internal status note</label><input id="csStNote" maxlength="300" value="${esc(r.status_note || '')}" placeholder="e.g. awaiting market quotes, pending client clarification"></div>
          </div>
          <div class="stage-times">${[['Request', r.quote_requested_at || r.created_at], ['Working on it', r.working_at], ['Quotation', r.quotation_at], ['Certificate', r.certificate_at], ['Closed', r.closed_at]].map(([l, t]) => `<span class="${t ? 'on' : ''}"><b>${esc(l)}</b>${t ? esc(FC.dateTime(t)) : '-'}</span>`).join('')}</div>
          <label class="switch"><input type="checkbox" id="csTest" ${r.is_test ? 'checked' : ''}><span><b>Test case</b><span>Left out of statistics.</span></span></label>
          <div style="margin-top:12px" id="csSaveHost"></div></section>
        <section><h3>Quotations</h3><div id="csQuotes" class="list"></div><div class="toolbar" style="margin-top:10px" id="csQuoteActs"></div></section>
        <section><h3>Cover notes</h3><div id="csCovers" class="list"></div><div class="toolbar" style="margin-top:10px" id="csCoverActs"></div></section>
        <section><h3>Documents</h3><div id="csDocs" class="list"><p class="small muted" style="margin:0">Loading...</p></div><div class="toolbar" style="margin-top:10px" id="csDocActs"></div></section>
        ${certOn(r) ? `<section><h3>Certificates</h3><div id="csCerts" class="list"></div><div class="toolbar" style="margin-top:10px" id="csCertActs"></div></section>` : ''}
        <section><h3>Invoices</h3><div id="csInv" class="list"></div><div class="toolbar" style="margin-top:10px" id="csInvActs"></div></section>
        <section><h3>Notes</h3><div id="csNotes"></div>
          <div class="field" style="margin-top:8px"><label for="csNote">Add a note</label><textarea id="csNote" maxlength="2000" rows="2"></textarea></div><div id="csNoteHost" style="margin-top:8px"></div></section>
        <section><h3>Timeline</h3><ul class="timeline" id="csTl"></ul></section>
        <section><div class="toolbar" id="csMore"></div></section>`;
      // handling
      $('#csStage', body).addEventListener('change', e => { $('#csReasonF', body).hidden = e.target.value !== 'closed'; });
      // the case action bar: the next step one click away
      const top = FC.el('<div class="case-actions toolbar"></div>'); body.prepend(top);
      { const lq = (S.quotes[r.id] || []).filter(q => q.status !== 'superseded').pop(), cs0 = S.certs.filter(c => c.indication_id === r.id);
        if(!lq) top.appendChild(btn('Create quotation', 'primary', () => quotationEditor(r).then(ok => ok && refresh())));
        else if(lq.status === 'open') top.appendChild(btn(lq.send_status === 'saved' ? 'Send quotation to client' : 'Resend quotation', lq.send_status === 'saved' ? 'primary' : 'ghost', () => sendDialog(lq, r).then(ok => ok && refresh())));
        if(cs0.length) top.appendChild(btn('Download certificate .fdf', 'ok', () => fdfDownload(cs0[cs0.length - 1])));
        else if(certOn(r) && lq && lq.status === 'accepted') top.appendChild(btn('Issue certificate', 'primary', () => certificateDialog(r).then(ok => ok && refresh())));
        if(stg(r) !== 'closed') top.appendChild(btn('Close case…', 'ghost', () => closeCases([r.id]).then(ok => ok && refresh())));
        const pc = polCoverNote(r); if(pc) top.insertAdjacentHTML('beforeend', pc); }
      $('#csSaveHost', body).appendChild(btn('Save handling', 'primary', async b => {
        busy(b, true);
        const patch = { stage: $('#csStage', body).value, owner: $('#csOwner', body).value.trim() || null, follow_up: $('#csFollow', body).value || null, is_test: $('#csTest', body).checked, status_note: $('#csStNote', body).value.trim() || null };
        if(patch.stage === 'closed') patch.closure_reason = $('#csReason', body).value;
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
        const it = FC.el(`<div class="item"><div><div class="t">Version ${q.version} ${chip(st, st)} ${sendChip(q)}</div>
          <div class="meta">${esc(money2(q.data.total, q.data.currency))}${Number(q.data.taxPct) > 0 ? ' incl. ' + esc(Number(q.data.taxPct)) + ' % IPT' : ''}${q.data.insurer ? ', ' + esc(q.data.insurer) : ''} · client sees ${esc((FC.DISPLAY[q.display_mode || q.data.displayMode] || FC.DISPLAY.both).toLowerCase())}${S.qint[q.id] ? ' <span class="chip neutral">brokerage ' + esc(Number(S.qint[q.id].brokerage_pct)) + ' % = ' + esc(money2(S.qint[q.id].brokerage_amount, q.data.currency)) + '</span>' : ''}<br>${q.send_status === 'saved' ? 'saved ' + esc(FC.dateTime(q.created_at)) + ', not sent yet' : 'sent ' + esc(FC.dateTime(q.sent_at || q.created_at))}, valid until ${esc(FC.dateTime(q.valid_until))}${q.responded_at ? ', answered ' + esc(FC.dateTime(q.responded_at)) : ''}${q.response_note ? '<br>Client: ' + esc(q.response_note) : ''}</div></div><div class="acts"></div></div>`);
        const a = it.querySelector('.acts');
        if(q.status === 'open') a.appendChild(btn(q.send_status === 'saved' ? 'Send' : 'Resend', q.send_status === 'saved' ? 'primary' : 'ghost', () => sendDialog(q, r).then(ok => ok && refresh())));
        if(q.status === 'open' && q.send_status === 'saved') a.appendChild(btn('Edit', 'ghost', () => quotationEditor(r, q.data, q.id, { draft: q }).then(ok => ok && refresh())));
        if(S.sendHist.some(h => h.quotation_id === q.id)) a.appendChild(btn('History', 'ghost', () => historyDialog(r, q)));
        a.appendChild(btn('PDF', 'ghost', async b => { busy(b, true); try{ FC.saveBlob(await FCPDF.quotation(q, r), FCPDF.fileName('MARINCON_Quotation', r.ref, 'v' + q.version)); }catch(e){ console.error(e); toast('PDF failed.', 'error'); } busy(b, false); }));
        if(q.status === 'open') a.appendChild(btn('Withdraw', 'danger', async b => {
          if(!(await FC.confirm('Withdraw this quotation?', 'The client can no longer accept it.', 'Withdraw', 'danger'))) return;
          const { error } = await sb.rpc('admin_withdraw_quotation', { p_quotation_id: q.id }); if(error){ toast(error.message, 'error'); return; } refresh();
        }));
        if(st !== 'superseded') a.appendChild(btn('New version from this', 'ghost', () => quotationEditor(r, q.data, q.id).then(ok => ok && refresh())));
        qh.appendChild(it);
      });
      $('#csQuoteActs', body).appendChild(btn(qs.length ? 'New quotation' : 'Create quotation', qs.length ? 'ghost' : 'primary', () => quotationEditor(r).then(ok => ok && refresh())));
      $('#csQuoteActs', body).appendChild(btn('Indication PDF', 'ghost', async b => { busy(b, true); try{ FC.saveBlob(await FCPDF.indication(Object.assign({}, r, { origin_name:cName(r.origin_country), dest_name:cName(r.dest_country), commodity_name:(S.commodities.find(c => c.id === r.commodity_id) || {}).name, deductible_text: setting('deductible_text', '') })), FCPDF.fileName('MARINCON_Indication', r.ref || r.id)); }catch(e){ console.error(e); toast('PDF failed.', 'error'); } busy(b, false); }));
      $('#csQuoteActs', body).appendChild(btn('Text to insurer', 'ghost', () => insurerText(r)));
      // cover notes
      const ch = $('#csCovers', body);
      if(!cns.length) ch.innerHTML = '<p class="small muted" style="margin:0">No cover note yet.</p>';
      cns.forEach(cn => {
        const it = FC.el(`<div class="item"><div><div class="t">${esc(cn.number)}</div><div class="meta">Issued ${esc(FC.dateTime(cn.issued_at))}</div></div><div class="acts"></div></div>`);
        it.querySelector('.acts').appendChild(btn('PDF', 'ghost', async b => { busy(b, true); try{ FC.saveBlob(await FCPDF.coverNote(cn, r), FCPDF.fileName('MARINCON_CoverNote', cn.number)); }catch(e){ console.error(e); toast('PDF failed.', 'error'); } busy(b, false); }));
        ch.appendChild(it);
      });
      // documents attached by the client (or by staff on their behalf)
      const paintDocs = async () => {
        const host = $('#csDocs', body); if(!host) return;
        const { data: docs } = await sb.from('request_attachments').select('*').eq('indication_id', r.id).order('id');
        host.innerHTML = (docs || []).length ? '' : '<p class="small muted" style="margin:0">No documents attached.</p>';
        (docs || []).forEach(d => { const it = FC.el(`<div class="item"><div><div class="t">${esc(d.name)}</div><div class="meta">${esc(d.kind || 'Document')} · ${Math.max(1, Math.round((d.size || 0) / 1024))} KB · ${esc(FC.dateTime(d.created_at))}</div></div><div class="acts"></div></div>`);
          it.querySelector('.acts').appendChild(btn('Open', 'ghost', async () => { const { data: u, error } = await sb.storage.from('request-documents').createSignedUrl(d.path, 300); if(error || !u) return toast('Could not open: ' + (error ? error.message : ''), 'error'); window.open(u.signedUrl, '_blank', 'noopener'); }));
          it.querySelector('.acts').appendChild(btn('Remove', 'ghost', async () => { if(!(await FC.confirm('Remove ' + d.name + '?', 'The file is deleted from the request.', 'Remove', 'danger'))) return; await sb.storage.from('request-documents').remove([d.path]); await sb.from('request_attachments').delete().eq('id', d.id); paintDocs(); }));
          host.appendChild(it); });
      };
      paintDocs();
      $('#csDocActs', body).appendChild(btn('Attach documents', 'ghost', () => { const inp = document.createElement('input'); inp.type = 'file'; inp.multiple = true; inp.accept = '.pdf,.docx,.doc,.xlsx,.xls,.jpg,.jpeg,.png,.msg,.eml';
        inp.onchange = async () => { for(const fl of Array.from(inp.files)){ if(fl.size > 25 * 1048576){ toast(fl.name + ' is larger than 25 MB.', 'error'); continue; }
            const path = (r.user_id || me().id) + '/' + r.id + '/' + Date.now() + '_' + fl.name.replace(/[^\w.\-]+/g, '_').slice(-80);
            const up = await sb.storage.from('request-documents').upload(path, fl, { contentType: fl.type || 'application/octet-stream', upsert:false });
            if(up.error){ toast('Upload failed: ' + up.error.message, 'error'); continue; }
            await sb.from('request_attachments').insert({ indication_id: r.id, path, name: fl.name.slice(0, 200), size: fl.size, mime: fl.type || null, uploaded_by: me().id }); }
          paintDocs(); };
        inp.click(); }));
      const accepted = qs.filter(q => q.status === 'accepted').pop();
      if($('#csCerts', body)){
        const cs = S.certs.filter(c => c.indication_id === r.id);
        $('#csCerts', body).innerHTML = cs.length ? '' : '<p class="small muted" style="margin:0">No certificate yet.</p>';
        cs.forEach(c => { const it = FC.el(`<div class="item"><div><div class="t">Certificate ${esc(c.number)} ${chip('neutral', CERT_MODE[c.numbering_mode] || 'number')}</div><div class="meta">${esc(FC.dateTime(c.created_at))} · ${esc((c.data || {}).box === '6' ? 'Air (condition 6)' : 'Sea / road / rail (condition 5)')}${c.policy_year_id ? ' · policy year ' + esc((S.polYears.find(y => y.id === c.policy_year_id) || {}).label || '') : ''}</div></div><div class="acts"></div></div>`);
          it.querySelector('.acts').appendChild(btn('Download .fdf', 'ok', () => fdfDownload(c)));
          it.querySelector('.acts').appendChild(btn('Open', 'ghost', () => certificateDialog(r, c).then(ok => ok && refresh())));
          $('#csCerts', body).appendChild(it); });
        $('#csCertActs', body).appendChild(btn(cs.length ? 'New certificate' : 'Create certificate', cs.length ? 'ghost' : 'primary', () => certificateDialog(r).then(ok => ok && refresh())));
      }
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
      qs.forEach(q => { ev.push([q.created_at, 'Quotation version ' + q.version + ' saved']); if(q.responded_at) ev.push([q.responded_at, 'Client ' + q.status + ' version ' + q.version]); });
      S.sendHist.filter(h => h.indication_id === r.id).forEach(h => ev.push([h.sent_at, 'Quotation version ' + h.version + (h.is_resend ? ' resent' : ' sent') + ' to ' + (h.recipient_email || 'the client') + ' (' + (h.delivery_method === 'manual' ? 'manual dispatch' : 'portal + e-mail') + ', ' + (h.sent_by_name || '') + ')']));
      S.certs.filter(c => c.indication_id === r.id).forEach(c => ev.push([c.created_at, 'Certificate ' + c.number + ' issued']));
      if(r.closed_at && stg(r) === 'closed') ev.push([r.closed_at, 'Closed: ' + (FC.CLOSURE[r.closure_reason] || '')]);
      cns.forEach(c => ev.push([c.issued_at, 'Cover note ' + c.number + ' issued']));
      (notes || []).forEach(n => ev.push([n.created_at, 'Note by ' + n.author]));
      ev.sort((a, b) => new Date(a[0]) - new Date(b[0]));
      $('#csTl', body).innerHTML = ev.map(([t, l]) => `<li>${esc(l)}<span>${esc(FC.dateTime(t))}</span></li>`).join('');
      // danger zone
      $('#csMore', body).appendChild(btn('Delete case', 'danger', async () => {
        if(!(await FC.confirm('Delete this case?', 'The indication, its quotations, cover notes, notes and invoices are deleted for good. Prefer the stage "Closed" if you need the record.', 'Delete for good', 'danger'))) return;
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

  // ---------------- text templates, default formatting, merge fields ----------------
  const sameId = (a, b) => (a == null && b == null) || (a != null && b != null && Number(a) === Number(b));
  const tplRow = (kind, t, id) => S.templates.find(x => x.kind === kind && x.scope_type === t && sameId(x.scope_id, id));
  // policy -> client -> configuration (general)
  const tplFor = (kind, custId, polId) => { const f = (t, id) => { const x = tplRow(kind, t, id); return x && x.active ? x : null; }; return (polId && f('policy', polId)) || (custId && f('customer', custId)) || f('one_off_general', null) || null; };
  const fmtRow = (t, id) => S.textFmt.find(x => x.scope_type === t && sameId(x.scope_id, id));
  const fmtOut = x => ({ font_family: x.font_family, font_size_pt: Number(x.font_size_pt), line_height: Number(x.line_height), paragraph_spacing_pt: Number(x.paragraph_spacing_pt), text_color: x.text_color });
  const fmtFor = (custId, polId) => { const x = (polId && fmtRow('policy', polId)) || (custId && fmtRow('customer', custId)) || fmtRow('one_off_general', null); return x ? fmtOut(x) : Object.assign({}, FC.FMT); };
  const caseLevel = r => { const og = orgOfCase(r); return { custId: (og.customer || {}).id || r.customer_id || null, polId: !r.is_standalone_one_off && og.policy ? og.policy.id : null }; };
  A.tplFor = tplFor; A.fmtFor = fmtFor;
  // values for the {{merge_tags}} of a case (d = quotation data where there is one)
  function mergeCtx(r, d, extra){
    d = d || {}; r = r || {};
    const og = r.id ? orgOfCase(r) : {}, w = r.user_id ? who(r) : { company:'' }, cur = d.currency || r.currency;
    const m2 = v => v != null && v !== '' && isFinite(Number(v)) ? money2(Number(v), cur) : '';
    const ln = (d.lines || [])[0] || {};
    return Object.assign({
      client_name: w.company || d.client || '', assured_name: d.client || r.insured_name || w.company || '', policy_number: d.policyNo || (og.policy && og.policy.policy_no) || '',
      certificate_number: '', reference: r.ref || '', cargo_description: d.goods || r.goods_description || '',
      voyage_from: [d.originPlace || r.origin_place, cName(d.originCountry || r.origin_country)].filter(Boolean).join(', '),
      voyage_to: [d.destPlace || r.dest_place, cName(d.destCountry || r.dest_country)].filter(Boolean).join(', '),
      conveyance: (FC.CONVEYANCE[d.conveyance || r.conveyance] || {}).label || '', departure_date: (d.departureDate || r.departure_date) ? FC.date(d.departureDate || r.departure_date) : '',
      sum_insured: m2(d.sumInsured || ln.sum || r.sum_insured), currency: cur || '',
      rate_pct: isFinite(Number(ln.rate)) && ln.rate !== '' && ln.rate != null ? FC.pct(ln.rate) : r.rate_pct != null ? FC.pct(r.rate_pct) : '',
      premium_amount: m2(d.net != null ? d.net : r.premium), ipt_amount: m2(d.tax != null ? d.tax : r.ipt_amount),
      total_amount: m2(d.total != null ? d.total : (r.premium != null ? Number(r.premium) + Number(r.ipt_amount || 0) : null)),
      deductible: d.deductible || r.deductible_text || '', valid_until: d.validUntil ? FC.dateTime(d.validUntil) : '',
      handler_name: (d.handler && d.handler.name) || me().full_name || '', today: FC.date(FC.today())
    }, extra || {});
  }
  A.mergeCtx = mergeCtx;

  // ---------------- formatting toolbar (quotation wording and the template editor) ----------------
  const FONTS = ['Calibri','Arial','Helvetica','Cambria','Georgia','Times New Roman','Verdana','Tahoma'];
  const SIZES = [8, 9, 10, 11, 12, 14, 16, 18];
  const alIco = k => `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="${{ L:'M2 3h12M2 6.5h8M2 10h12M2 13.5h8', C:'M2 3h12M4 6.5h8M2 10h12M4 13.5h8', R:'M2 3h12M6 6.5h8M2 10h12M6 13.5h8', J:'M2 3h12M2 6.5h12M2 10h12M2 13.5h12' }[k]}" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>`;
  const rtBarHtml = o => { o = o || {};
    return `<div class="rt-bar" role="toolbar" aria-label="Formatting">
      <button type="button" data-rt="bold" title="Bold"><b>B</b></button><button type="button" data-rt="italic" title="Italic"><i>I</i></button><button type="button" data-rt="underline" title="Underline"><u>U</u></button>
      <select data-rt-font aria-label="Font family"><option value="">Font</option>${FONTS.map(f => `<option>${f}</option>`).join('')}</select>
      <select data-rt-size aria-label="Font size"><option value="">Size</option>${SIZES.map(z => `<option value="${z}">${z} pt</option>`).join('')}</select>
      <label class="rt-col" title="Text colour"><span>A</span><input type="color" data-rt-color value="#000000" aria-label="Text colour"></label>
      <label class="rt-col hl" title="Highlight"><span>H</span><input type="color" data-rt-hl value="#fff2a8" aria-label="Highlight colour"></label>
      <span class="rt-sep" aria-hidden="true"></span>
      <button type="button" data-rt="justifyLeft" title="Align left">${alIco('L')}</button><button type="button" data-rt="justifyCenter" title="Centre">${alIco('C')}</button><button type="button" data-rt="justifyRight" title="Align right">${alIco('R')}</button><button type="button" data-rt="justifyFull" title="Justify">${alIco('J')}</button>
      <button type="button" data-rt="insertUnorderedList" title="Bullet list">• List</button><button type="button" data-rt="insertOrderedList" title="Numbered list">1. List</button>
      <button type="button" data-rt="box" title="Outline / border box (subjectivities)">▢ Box</button><button type="button" data-rt="removeFormat" title="Clear formatting">Clear</button>
      ${o.fields ? `<select data-rt-field aria-label="Insert field"><option value="">Insert field</option>${FC.MERGE_TAGS.map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select>` : ''}
      ${o.blocks ? `<select data-rt-block aria-label="Insert clause, category or block"><option value="">Insert clause / block</option>${o.blocks}</select>` : ''}
      ${o.copy ? '<span style="flex:1"></span><button type="button" data-rt="copy" title="Copy for e-mail">Copy formatted text</button>' : ''}</div>`; };
  function wireRt(bar, ed, o){
    o = o || {};
    let saved = null;
    const keep = () => { const sel = getSelection(); if(sel.rangeCount && ed.contains(sel.anchorNode)) saved = sel.getRangeAt(0).cloneRange(); };
    ['keyup', 'mouseup', 'input', 'focus'].forEach(ev => ed.addEventListener(ev, keep));
    const restore = () => { ed.focus(); if(saved){ const sel = getSelection(); sel.removeAllRanges(); sel.addRange(saved); } };
    const cmd = (c, v) => { restore(); try{ document.execCommand('styleWithCSS', false, true); }catch(e){} document.execCommand(c, false, v); keep(); };
    const frag = () => { const sel = getSelection(); if(!sel.rangeCount || sel.isCollapsed || !ed.contains(sel.anchorNode)) return null; const t = document.createElement('div'); t.appendChild(sel.getRangeAt(0).cloneContents()); return t.innerHTML; };
    const wrapSel = (open, close) => { restore(); const h = frag(); if(h == null) return; document.execCommand('insertHTML', false, open + h + close); keep(); };
    const block = () => { restore(); let n = getSelection().anchorNode; if(!n || !ed.contains(n)) return null; while(n && n !== ed && !(n.nodeType === 1 && /^(P|DIV|LI)$/.test(n.tagName))) n = n.parentNode; return n && n !== ed ? n : null; };
    const insert = html => { restore(); document.execCommand('insertHTML', false, html); keep(); };
    // blocks ([[...]] tokens, clauses, boxes) always go in as paragraphs of their own, after the current one
    const insertBlock = html => { const t = document.createElement('div'); t.innerHTML = html; const cur = block(); let at = cur; while(at && at.parentNode !== ed) at = at.parentNode;
      const nodes = Array.from(t.childNodes); nodes.forEach(n => at ? ed.insertBefore(n, at.nextSibling) && (at = n) : ed.appendChild(n));
      const last = nodes[nodes.length - 1]; if(last){ const r = document.createRange(); r.selectNodeContents(last); r.collapse(false); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); keep(); } };
    bar.addEventListener('mousedown', e => { if(e.target.closest('button')) e.preventDefault(); });
    bar.addEventListener('click', e => {
      const b = e.target.closest('[data-rt]'); if(!b) return; const k = b.dataset.rt;
      if(k === 'copy'){ if(o.onCopy) o.onCopy(); return; }
      if(k === 'big') return wrapSel('<span class="big">', '</span>');
      if(k === 'mark') return wrapSel('<mark>', '</mark>');
      if(k === 'box'){ const n = block(); if(n) n.classList.toggle('box'); return; }
      cmd(k);
    });
    bar.addEventListener('change', e => {
      const t = e.target;
      if(t.matches('[data-rt-font]') && t.value){ cmd('fontName', t.value); t.value = ''; }
      else if(t.matches('[data-rt-size]') && t.value){ wrapSel('<span style="font-size:' + Number(t.value) + 'pt">', '</span>'); t.value = ''; }
      else if(t.matches('[data-rt-color]')) cmd('foreColor', t.value);
      else if(t.matches('[data-rt-hl]')) cmd('hiliteColor', t.value);
      else if(t.matches('[data-rt-field]') && t.value){ const tag = '{{' + t.value + '}}'; insert((o.ctx && FC.merge(tag, o.ctx())) || esc(tag)); t.value = ''; }
      else if(t.matches('[data-rt-block]') && t.value){ const v = t.value; t.value = ''; if(o.onBlock) o.onBlock(v, insertBlock); else insertBlock(v === 'free' ? '<p class="box">Free text</p>' : '<p>' + esc(v) + '</p>'); }
    });
    return { insert, insertBlock };
  }
  A.rtBarHtml = rtBarHtml; A.wireRt = wireRt;

  // ---------------- policy years: the hard expiry lock ----------------
  const d10 = v => v ? String(v).slice(0, 10) : '';
  const yEnd = y => d10(y.extended_to || y.ends_on);
  const polCover = (polId, date) => { const dt = d10(date) || FC.today(); return S.polYears.filter(y => y.policy_id === polId && ['active','extended'].includes(y.status) && d10(y.starts_on) <= dt && dt <= yEnd(y)).sort((a, b) => d10(b.starts_on).localeCompare(d10(a.starts_on)))[0] || null; };
  const ymd = v => { const t = d10(v); return t ? t.slice(8, 10) + '.' + t.slice(5, 7) + '.' + t.slice(0, 4) : ''; };
  // warning when a case falls under a policy without an active / extended policy year
  const polCoverNote = r => { if(!r || !r.policy_id || r.is_standalone_one_off) return ''; const po = polOf(r.policy_id); if(!po) return ''; const dt = d10(r.departure_date) || FC.today();
    return polCover(po.id, dt) ? '' : `<div class="notice warn pol-lock"><b>Policy ${esc(po.policy_no || po.name)} is expired for ${esc(ymd(dt))}</b>No active or extended policy year covers this date, so quotations and certificates under this policy are blocked. Extend the policy year or add a new policy year first (Customers, policy, Policy years).</div>`; };
  A.polCover = polCover;

  // ---------------- sending: save without sending, send / resend, history ----------------
  const sendChip = q => q.send_status === 'saved' ? chip('pending', 'Saved - not sent') : chip('approved', 'Sent' + (Number(q.send_count) > 1 ? ' ' + q.send_count + 'x' : ''));
  const METHOD = { portal_email:'Portal + e-mail', manual:'Manual dispatch' };
  const methodHtml = `<div class="field"><label>Delivery</label><div class="seg" id="sdMethod" role="radiogroup" aria-label="Delivery method"><button type="button" data-v="portal_email" aria-checked="true">Portal + e-mail</button><button type="button" data-v="manual" aria-checked="false">Manual dispatch</button></div><span class="hint" id="sdHint">The client sees it in the portal and gets an e-mail.</span></div>`;
  const wireMethod = box => { const seg = box.querySelector('#sdMethod'); seg.addEventListener('click', e => { const b = e.target.closest('button'); if(!b) return; seg.querySelectorAll('button').forEach(x => x.setAttribute('aria-checked', String(x === b))); box.querySelector('#sdHint').textContent = b.dataset.v === 'manual' ? 'Visible in the portal, no e-mail: you send it yourself. Logged as manual dispatch.' : 'The client sees it in the portal and gets an e-mail.'; });
    return () => (seg.querySelector('[aria-checked="true"]') || {}).dataset.v || 'portal_email'; };
  async function askMethod(title, text){
    const box = FC.el(`<div><p style="margin-top:0">${esc(text)}</p>${methodHtml}</div>`); const get = wireMethod(box);
    return FC.dialog({ title, body: box, actions:[{ label:'Cancel', kind:'ghost', value:null }, { label:'Save & send', kind:'primary', onClick: async () => get() }] });
  }
  async function sendDialog(q, r){
    const resend = q.send_status === 'sent';
    if(new Date(q.valid_until) < Date.now()){ toast('The validity has expired - edit the quotation and set a new date first.', 'error'); return false; }
    const w = who(r), d = q.data || {};
    const box = FC.el(`<div><p style="margin-top:0">${resend ? 'Send version ' + q.version + ' again' : 'Send version ' + q.version} of <b>${esc(r.ref || '')}</b> to <b>${esc(w.name)}</b> (${esc(w.email)}).<br><span class="small muted">${FC.showPremium(q.display_mode || d.displayMode) ? 'Total ' + esc(money2(d.total, d.currency)) : 'Rate only'} · valid until ${esc(FC.dateTime(q.valid_until))} · client sees ${esc((FC.DISPLAY[q.display_mode || d.displayMode] || FC.DISPLAY.both).toLowerCase())}</span></p>
      ${methodHtml}<div class="field"><label for="sdNote">Note for the sending log (optional)</label><input id="sdNote" maxlength="300"></div><div class="err-msg" id="sdErr"></div></div>`);
    const get = wireMethod(box);
    return FC.dialog({ title: resend ? 'Resend to client' : 'Send to client', body: box, actions:[{ label:'Cancel', kind:'ghost', value:false }, { label: resend ? 'Resend' : 'Send', kind:'primary', onClick: async () => {
      const { error } = await sb.rpc('admin_send_quotation', { p_quotation_id: q.id, p_method: get(), p_note: box.querySelector('#sdNote').value.trim() || null });
      if(error){ box.querySelector('#sdErr').textContent = error.message; return; }
      toast(resend ? 'Sent again - logged.' : 'Sent to the client - logged.'); await loadAll(); if(tab !== 'requests' || !document.querySelector('.drawer')) render(); return true; } }] });
  }
  A.sendDialog = sendDialog;
  function historyDialog(r, q){
    const hs = S.sendHist.filter(h => h.indication_id === r.id && (!q || h.quotation_id === q.id)).slice().reverse();
    const box = FC.el(`<div>${hs.length ? `<ul class="timeline send-log">${hs.map(h => `<li><b>${h.is_resend ? 'Resent' : 'Sent'} version ${esc(h.version)}</b> · ${esc(METHOD[h.delivery_method] || h.delivery_method)}<br><span class="small">to ${esc(h.recipient_email || 'the client')} by ${esc(h.sent_by_name || '-')}${h.note ? ' · ' + esc(h.note) : ''}</span><span>${esc(FC.dateTime(h.sent_at))}</span><button type="button" class="linkbtn" data-snap="${h.id}">Snapshot PDF</button></li>`).join('')}</ul>` : '<p class="muted">Not sent yet.</p>'}<p class="xs muted">The log is kept as sent and cannot be changed. Each entry keeps the quotation exactly as it went out.</p></div>`);
    box.addEventListener('click', async e => { const b = e.target.closest('[data-snap]'); if(!b) return;
      const { data, error } = await sb.from('quotation_send_history').select('version_snapshot,sent_at,version').eq('id', Number(b.dataset.snap)); if(error || !(data || []).length) return toast('Could not load the snapshot.', 'error');
      const sn = data[0].version_snapshot || {}; try{ FC.saveBlob(await FCPDF.quotation({ data: sn, valid_until: sn.valid_until, version: data[0].version, created_at: data[0].sent_at }, r), FCPDF.fileName('MARINCON_Quotation', r.ref, 'v' + data[0].version + '_sent')); }catch(x){ console.error(x); toast('PDF failed.', 'error'); } });
    return FC.dialog({ title:'Sending history · ' + (r.ref || '') + (q ? ' v' + q.version : ''), wide:true, body: box, actions:[{ label:'Close', kind:'primary', value:true }] });
  }

  // ---------------- certificates: one-click .fdf ----------------
  const CERT_MODE = { matrix:'matrix', manual:'manual no.', legacy:'running no.' };
  const fdfName = c => { const r = S.rows.find(x => x.id === c.indication_id) || {}; return 'Certificate_' + String(c.number).replace(/[^\w-]+/g, '_') + (r.ref ? '_' + r.ref : '') + '.fdf'; };
  function fdfDownload(c){
    if(!c) return;
    const x = Object.assign({}, c.data || {}, { no: c.number });
    FC.saveBlob(FCPDF.fdf('', FCPDF.certFields(x)), fdfName(c), 'application/vnd.fdf');
    FC.fdfHint();
  }
  A.fdfDownload = fdfDownload;

  // ---------------- quotation editor ----------------
  function quotationEditor(r, prev, prevId, opt){
    opt = opt || {};
    const w = who(r), sp = splitRate(r), land = sp.land, prevInt = prevId ? S.qint[prevId] : null;
    const og = orgOfCase(r), pp = S.profiles[r.user_id] || {};
    const ocDed = og.policy ? effDed(og.policy, og.office, pp) : null, ocMin = og.policy ? (sp.detail && sp.detail.min_premium != null ? Number(sp.detail.min_premium) : effMin(og.policy, og.office, pp)) : null;
    const conds = (FC.COVER[r.cover] || {}).clause + (r.war_strikes ? (land ? ', Institute Strikes Clauses (Cargo)' : ', Institute War Clauses (Cargo), Institute Strikes Clauses (Cargo)') : '') + ', warehouse to warehouse';
    const d = Object.assign({
      client: r.insured_name || w.company, clientAddress: r.insured_name ? (r.insured_address || '') : og.office ? [og.office.location, cName(og.office.country)].filter(Boolean).join(', ') : addrOf(w.p), policyholder: og.policy && og.policy.policyholder ? og.policy.policyholder : r.insured_name ? [w.company, addrOf(w.p)].filter(Boolean).join(', ') : '', policyNo: og.policy ? og.policy.policy_no || '' : '', customerRef: r.customer_ref || '', coAssured: String((r.details || {}).parties || '').split('\n').map(x => x.trim()).filter(Boolean).slice(0, 6), goods: r.goods_description, packaging: r.packaging || '', conveyance: r.conveyance, vessel: r.vessel || '', incoterm: r.incoterm ? r.incoterm + ' ' + (r.origin_place || r.dest_place || '') : '',
      originCountry: r.origin_country, originPlace: r.origin_place || '', destCountry: r.dest_country, destPlace: r.dest_place || '',
      voyage: [r.origin_place, cName(r.origin_country)].filter(Boolean).join(', ') + ' to ' + [r.dest_place, cName(r.dest_country)].filter(Boolean).join(', '),
      period: r.departure_date ? 'Transit commencing on or about ' + FC.date(r.departure_date) : 'Single transit as per voyage',
      conditions: conds, insurer: (og.policy && og.policy.placed_via) || setting('default_insurer', ''),
      deductible: ocDed != null ? og.policy.currency + ' ' + Number(ocDed).toLocaleString('en-GB', { minimumFractionDigits:2, maximumFractionDigits:2 }) + ' each and every loss' : ((S.commodities.find(c => c.id === r.commodity_id) || {}).deductible) || setting('deductible_text', ''), special: r.conditions || '',
      currency: r.currency, discountPct: Number(r.discount_pct || effDisc(w.p) || 0), taxPct: 0,
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
    // German IPT: the rules of the configuration (route and domicile), overridable per quotation
    const iptS = S.ipt || { default_rate: Number(setting('insurance_tax_pct', 19)), default_mode:'off' };
    const iptCtx = (() => { const cu = og.customer || custOf(r.customer_id) || {}, po = (!r.is_standalone_one_off && og.policy) || {}, of = og.office || {}; const holder = po.policyholder_country || cu.country || of.country || pp.country || ''; return { mode: r.ipt_mode || po.ipt_mode || cu.ipt_mode || null, holder, assured: r.insured_country || holder }; })();
    const iptAuto = (from, to) => FC.iptEval(iptS, iptCtx.mode, from, to, iptCtx.holder, iptCtx.assured);
    const ipt0 = iptAuto(d.originCountry, d.destCountry);
    const taxDefault = Number(iptS.default_rate);
    const taxOn = prev ? Number(d.taxPct) > 0 : ipt0.applied;
    // what the client sees: quotation -> case -> policy -> client -> configuration
    const dmCase = r.quote_display_mode || (!r.is_standalone_one_off && og.policy && og.policy.quote_display_mode) || (og.customer || custOf(r.customer_id) || {}).quote_display_mode || setting('quote_display_mode', 'both') || 'both';
    const dm0 = d.displayMode || dmCase;
    const lineRow = (l, i) => `<tr data-i="${i}"><td><input class="ln-label" value="${esc(l.label)}" maxlength="120"></td><td><input class="ln-sum" inputmode="decimal" value="${l.sum != null ? esc(l.sum) : ''}"></td><td><input class="ln-rate" inputmode="decimal" value="${l.rate != null ? esc(l.rate) : ''}"></td><td class="r num ln-prem">-</td><td><button type="button" class="linkbtn ln-del" aria-label="Remove line">Remove</button></td></tr>`;
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
      <div class="qe-case"><h4>Rating basis <span class="xs muted" style="font-weight:400">- change route, transit, cargo, conveyance, currency or value, then update the figures</span></h4>
        <div class="grid3">
          <div class="field"><label for="qeCom">Cargo type</label><select id="qeCom">${S.commodities.filter(c => c.active || c.id === r.commodity_id).map(c => `<option value="${esc(c.id)}" ${c.id === (d.commodityId || r.commodity_id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
          <div class="field"><label for="qeInv">Invoice value</label><input id="qeInv" inputmode="decimal" value="${esc(d.invoiceValue != null ? d.invoiceValue : r.invoice_value)}"></div>
          <div class="field"><label for="qeVia">Transit countries <span class="muted">(ISO, comma separated)</span></label><input id="qeVia" maxlength="40" value="${esc((d.transit || r.transit_countries || []).join(', '))}"></div>
          <div class="field"><label for="qeCov">Cover</label><select id="qeCov">${['icc_a','icc_b','icc_c'].map(k => `<option value="${k}" ${k === (d.cover || r.cover) ? 'selected' : ''}>${esc(FC.COVER[k].clause)}</option>`).join('')}</select></div>
          <div class="field"><label for="qeDep">Departure date / ETA of loading</label><input id="qeDep" type="date" value="${esc(d.departureDate || r.departure_date || '')}"></div>
          <div class="field"><label>&nbsp;</label><label class="small" style="display:flex;gap:6px;align-items:center;padding-top:8px"><input type="checkbox" id="qeWarOn" ${(d.warStrikes != null ? d.warStrikes : r.war_strikes) ? 'checked' : ''} style="width:auto;min-width:0"> War &amp; strikes</label></div>
        </div>
        <label class="small" style="display:flex;gap:6px;align-items:center;margin:2px 0 6px"><input type="checkbox" id="qeSA" ${r.is_standalone_one_off ? 'checked' : ''} style="width:auto;min-width:0"> Standalone one-off (unrelated to the client's policy / profile - general one-off pool)</label>
        <div class="toolbar" style="margin:4px 0 0"><button type="button" class="btn btn-ghost btn-sm" id="qeUpd"><span class="spin"></span>Update quotation</button><span class="xs muted" id="qeUpdMsg">Re-reads the rate tables, war extras and alerts of ${esc(og.policy ? 'policy ' + polLabel(og.policy) : 'the general one-off pool')}.</span></div>
        <div id="qeAlerts">${(r.alerts || []).length ? alertList(r) : ''}</div>${polCoverNote(r) || ''}</div>
      <div class="field" style="margin-top:12px"><label>Voyage</label><input id="qeVoy" maxlength="300" value="${esc(d.voyage)}"></div>
      <div class="field"><label>Period</label><input id="qePer" maxlength="200" value="${esc(d.period)}"></div>
      <div class="field"><label>Conditions</label><textarea id="qeCond" rows="2" maxlength="800">${esc(d.conditions)}</textarea></div>
      <div class="grid2" style="margin-top:12px">
        <div class="field"><label for="qeInsSel">Insurer</label><select id="qeInsSel">${insOpts}</select><input id="qeIns" maxlength="200" value="${esc(otherName)}" placeholder="Name of the insurer" style="margin-top:6px" ${preIns ? 'hidden' : ''}></div>
        <div class="field"><label>Deductible</label><input id="qeDed" maxlength="200" value="${esc(d.deductible)}"></div>
      </div>
      <h3 style="margin:18px 0 6px">Premium</h3>
      <div class="grid3">
        <div class="field"><label>Currency</label><select id="qeCur">${Array.from(new Set(allowedCurs(r.office_id, og.policy && og.policy.id, og.policy ? (og.customer || {}).id : null).concat([d.currency]))).map(c => `<option ${d.currency === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
        <div class="field"><label>Client discount %</label><input id="qeDisc" inputmode="decimal" value="${esc(d.discountPct || 0)}"></div>
        <div class="field"><label>Minimum premium</label><input id="qeMin" inputmode="decimal" value="${esc(d.minPremium || 0)}"></div>
        <div class="field"><label for="qeMode">Client sees</label><select id="qeMode">${Object.entries(FC.DISPLAY).map(([k, l]) => `<option value="${k}" ${k === dm0 ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select><span class="hint">Default for this case: ${esc(FC.DISPLAY[dmCase] || dmCase)}</span></div>
      </div>
      ${(() => { const W = d.warExcl || null, areas = W ? W.areas : ((r.war && r.war.areas) || []).map(a => a.name);
          if(!areas.length) return '';
          const all = W ? W.offerBuyback : ((r.war && r.war.areas) || []).every(a => a.net_permille != null);
          const bb = W ? W.buybackPct : ((r.war && r.war.areas) || []).reduce((t, a) => t + Number(a.net_permille || 0), 0) / 10;
          return `<div class="qe-war"><h4>War &amp; strikes excluded on this voyage</h4>
            <div class="grid2"><div class="field"><label for="qeWarAreas">Areas (one per line, shown to the client)</label><textarea id="qeWarAreas" rows="2">${esc(areas.join('\n'))}</textarea></div>
            <div class="field"><label for="qeBb">Buy-back loading, net % on the rate</label><input id="qeBb" inputmode="decimal" value="${esc(bb ? Math.round(bb * 10000) / 10000 : '')}" placeholder="e.g. 0.175"><span class="hint">Gross loading less no-claims bonus, e.g. 0.35 % - 50 % = 0.175 %.</span></div></div>
            <label class="switch" style="margin-top:4px"><input type="checkbox" id="qeBbOn" ${all ? 'checked' : ''}><span><b>Offer the buy-back</b><span>The quotation shows both rates next to the minimum premium.</span></span></label>
            <div id="qeWarRates" class="small" style="margin-top:8px"></div></div>`; })()}
      <div class="tbl-wrap" style="margin-top:12px"><table class="tbl"><thead><tr><th>Cover line</th><th>Sum insured</th><th>Rate %</th><th class="r">Premium</th><th></th></tr></thead><tbody id="qeLines">${(d.lines || []).map(lineRow).join('')}</tbody></table></div>
      <div class="toolbar" style="margin-top:8px"><button type="button" class="btn btn-ghost btn-sm" id="qeAdd">Add line</button>
        <label class="switch" style="margin:0"><input type="checkbox" id="qeTaxOn" ${taxOn ? 'checked' : ''}><span><b>Apply German IPT</b></span></label>
        <div class="field" style="flex-direction:row;align-items:center;gap:8px;margin:0"><label for="qeTax" style="white-space:nowrap">Rate %</label><input id="qeTax" inputmode="decimal" value="${esc(Number(d.taxPct) > 0 ? d.taxPct : taxDefault)}" style="width:80px" ${taxOn ? '' : 'disabled'}></div></div>
      <div class="ipt-badge" id="qeIptWhy" role="status"></div>
      <table class="qtable" id="qeSum"></table>
      <div class="qe-internal"><h4>Internal, never shown to the client</h4>
        <div class="grid3"><div class="field"><label for="qeBrk">Brokerage % with this insurer</label><input id="qeBrk" inputmode="decimal" value="${esc(preBrk)}"></div>
        <div class="field"><label>Brokerage</label><div class="num" id="qeBrkAmt" style="padding-top:10px">-</div></div>
        <div class="field"><label>Net premium to insurer</label><div class="num" id="qeNetIns" style="padding-top:10px">-</div></div>
        <div class="field"><label for="qeReb">Commission / rebate to the client, % of premium</label><input id="qeReb" inputmode="decimal" value="${esc(prevInt ? Number(prevInt.client_rebate_pct || 0) : 0)}"></div>
        <div class="field"><label>Rebate</label><div class="num" id="qeRebAmt" style="padding-top:10px">-</div></div>
        <div class="field"><label>Net retained brokerage</label><div class="num" id="qeKeep" style="padding-top:10px">-</div></div></div>
        <p class="xs muted" style="margin:0">Calculated on the premium after discount and minimum, before insurance tax. The default comes from the insurer (tab Insurers).</p></div>
      <div class="grid2" style="margin-top:6px">
        <div class="field"><label>Valid until (your local time)</label><input id="qeValid" type="datetime-local" value="${toLocal(new Date(Date.now() + 3 * 864e5))}"></div>
        <div class="field"><label>Handled by</label><input id="qeHandler" maxlength="100" value="${esc(me().full_name || '')}"></div>
      </div>
      <h3 style="margin:22px 0 6px">Quotation wording</h3>
      <p class="xs muted" style="margin:0 0 10px">Tick clauses from the library (defaults of ${og.policy ? esc(og.policy.name) : 'one-off quotations'}); every text stays editable in the document. The pricing block follows the figures above.</p>
      <div class="toolbar" style="margin:0 0 8px"><label class="xs" for="qeFill">Fast-fill from</label><select class="input" id="qeFill" style="max-width:320px"><option value="case">This case (${esc(og.policy ? 'policy ' + polLabel(og.policy) : 'one-off')})</option>${og.policy && og.customer ? `<option value="customer">Customer defaults · ${esc(og.customer.name)}</option>` : ''}<option value="general">General · one-off defaults</option></select><button type="button" class="btn btn-ghost btn-sm" id="qeFillGo">Fast-fill</button><span style="flex:1"></span><button type="button" class="btn btn-ghost btn-sm" id="qeLib">Open clauses library</button></div>
      <div class="qe-wording"><div class="qe-picks" id="qePicks"></div>
        <div class="qe-docwrap">${rtBarHtml({ copy:true, fields:true })}
          <div class="qe-doc" id="qeDoc" contenteditable="true" spellcheck="true"></div></div></div>
      <div class="field"><label>Note for the client (optional)</label><textarea id="qeNote" rows="2" maxlength="800">${esc(d.note || '')}</textarea></div>
      <div class="field"><label>How to accept</label><textarea id="qeClose" rows="2" maxlength="1200">${esc(d.closing || '')}</textarea></div>
      <div class="err-msg" id="qeErr"></div></div>`);
    const $b = s => body.querySelector(s);
    // ---------- wording: library clauses → one editable document ----------
    const isLand = /^(road|rail)$/.test(r.conveyance), polId = og.policy ? og.policy.id : null, custId = og.policy && og.customer ? og.customer.id : null;
    const fillIn = t => String(t || '').replace(/\{policy_no\}/g, (og.policy && og.policy.policy_no) || '-').replace(/\{assured\}/g, d.client || '').replace(/\{ref\}/g, r.ref || '').replace(/\{currency\}/g, d.currency || '');
    const isAir = /^air/.test(r.conveyance);
    const lib = clausesFor(custId, polId).filter(c => !((isLand || isAir) && c.maritime) && !(c.air_only && !isAir));
    // clauses suggested by the internal alerts of this shipment
    const alertTxt = (r.alerts || []).map(a => a.text).join(' ');
    const suggest = new Set([].concat(/Used goods/.test(alertTxt) ? ['Used machinery', 'Pre-shipment exception report'] : [], /warranty survey/.test(alertTxt) ? ['Marine warranty survey'] : [],
      r.on_deck ? ['On deck'] : [], /^unpacked/i.test(r.packaging || '') ? ['Unpacked goods'] : [], /Storage/.test(alertTxt) ? ['Storage'] : []));
    const docEl = $b('#qeDoc'), picks = $b('#qePicks');
    let building = false;
    const sectionFor = cat => {
      let sec = docEl.querySelector(`section[data-cat="${cat}"]`);
      if(!sec){
        sec = document.createElement('section'); sec.dataset.cat = cat; sec.innerHTML = DOC_HEAD[cat] ? `<p><b><u>${esc(DOC_HEAD[cat])}</u></b></p>` : '';
        const order = CL_CAT.map(x => x[0]), after = building ? null : Array.from(docEl.querySelectorAll('section[data-cat]')).find(x => order.indexOf(x.dataset.cat) > order.indexOf(cat));
        docEl.insertBefore(sec, after || null);
      }
      return sec;
    };
    const mctx = () => mergeCtx(r, Object.assign({}, d, { currency: ($b('#qeCur') || {}).value || d.currency }));
    const clauseHtml = c => { const b = FC.merge(esc(fillIn(c.body)), mctx()).replace(/\n/g, '<br>'); return CAT_TITLES.has(c.category) ? `<b><u>${esc(c.title.replace(/ \((Editor wording 1982|2009 Open Policy Wording)\)$/, ''))}</u></b><br>${b}` : b; };
    const addClause = c => { if(docEl.querySelector(`[data-cid="${c.id}"]`)) return; const p = document.createElement('p'); p.dataset.cid = c.id; p.innerHTML = clauseHtml(c); sectionFor(c.category).appendChild(p); };
    const dropClause = id => { const p = docEl.querySelector(`[data-cid="${id}"]`); if(!p) return; const sec = p.closest('section'); p.remove(); if(sec && sec.dataset.cat !== 'pricing' && !Array.from(sec.children).some(x => x.dataset.cid || (x.textContent.trim() && x.textContent.trim() !== (DOC_HEAD[sec.dataset.cat] || '')))) sec.remove(); };
    picks.innerHTML = CL_CAT.filter(([cat]) => lib.some(c => c.category === cat)).map(([cat, label]) => `<div class="qe-pick" data-pcat="${cat}"><b>${esc(label)}</b>${lib.filter(c => c.category === cat).map(c => `<label><input type="checkbox" data-cid="${c.id}"> ${esc(c.title)}${suggest.has(c.title) ? ' <span class="chip pending">suggested</span>' : ''}</label>`).join('')}</div>`).join('');
    if(d.doc){
      docEl.innerHTML = FC.cleanHtml(d.doc);
      // the clean-up drops the markers; re-attach them by text so the tick boxes match
      lib.forEach(c => { const t = fillIn(c.body).replace(/\s+/g, ' ').trim().slice(0, 80); const p = Array.from(docEl.querySelectorAll('p')).find(x => !x.dataset.cid && x.textContent.replace(/\s+/g, ' ').includes(t)); if(p) p.dataset.cid = c.id; });
    }else{
      const defaults = () => {
        lib.filter(c => c.category !== 'pricing' && (clauseOn(c, polId, custId) || (suggest.has(c.title) && !(c.category === 'special' && r.conditions)))).forEach(addClause);
        if(r.conditions){ const p = document.createElement('p'); p.textContent = r.conditions; const sec = sectionFor('special'); sec.insertBefore(p, sec.children[1] || null); }
      };
      // the quotation template of the level (policy -> client -> general); [[clauses]] alone = the default document
      const tpl = tplFor('quotation', custId, polId), tb = tpl ? String(tpl.body || '') : '';
      if(!tb || tb.replace(/<[^>]+>|\s|&nbsp;/g, '') === '[[clauses]]') defaults();
      else{
        building = true;
        const tmp = document.createElement('div'); tmp.innerHTML = FC.cleanHtml(FC.merge(tb, mctx()));
        let textSec = null;
        Array.from(tmp.childNodes).forEach(n => {
          const t = (n.textContent || '').trim(), m = /^\[\[([a-z_]+)(?::([\w-]+))?\]\]$/.exec(t);
          if(m){ textSec = null;
            if(m[1] === 'clauses') defaults();
            else if(m[1] === 'category'){ if(m[2] === 'pricing') sectionFor('pricing'); else lib.filter(c => c.category === m[2] && clauseOn(c, polId, custId)).forEach(addClause); }
            else if(m[1] === 'clause'){ const c = S.clauses.find(x => x.id === Number(m[2])); if(c){ if(!lib.includes(c)) lib.push(c); if(c.category === 'pricing') sectionFor('pricing'); else addClause(c); } }
            else if(m[1] === 'pricing') sectionFor('pricing');
            return; }
          if(n.nodeType === 3 && !t) return;
          if(!textSec){ textSec = document.createElement('section'); textSec.dataset.cat = 'text'; docEl.appendChild(textSec); }
          if(n.nodeType === 3){ const p = document.createElement('p'); p.textContent = n.textContent; textSec.appendChild(p); } else textSec.appendChild(n);
        });
        building = false;
      }
    }
    // the default typography of the level, applied on screen, in the PDF and when copying
    const fmt = d.fmt || fmtFor(custId, polId);
    docEl.style.cssText = FC.fmtCss(fmt); docEl.style.setProperty('--para', Number(fmt.paragraph_spacing_pt) + 'pt');
    lib.forEach(c => { const cb = picks.querySelector(`[data-cid="${c.id}"]`); if(cb) cb.checked = c.category === 'pricing' ? (d.doc ? docEl.textContent.includes(fillIn(c.body).trim()) : clauseOn(c, polId, custId)) : !!docEl.querySelector(`[data-cid="${c.id}"]`); });
    picks.addEventListener('change', e => { const cb = e.target.closest('[data-cid]'); if(!cb) return; const c = lib.find(x => String(x.id) === cb.dataset.cid); if(c.category === 'pricing'){ recalc(); return; } cb.checked ? addClause(c) : dropClause(c.id); });
    // fast-fill: the default clauses of the case, of the customer or of the general one-off pool
    $b('#qeFillGo').addEventListener('click', () => {
      const src = $b('#qeFill').value, fp = src === 'case' ? polId : null, fc = src === 'general' ? null : custId;
      lib.forEach(c => { const cb = picks.querySelector(`[data-cid="${c.id}"]`); if(!cb) return; const on = src === 'general' ? (c.scope_type === 'one_off_general' && !!c.oneoff_list && !!c.default_spot) : clauseOn(c, fp, fc);
        cb.checked = on; if(c.category !== 'pricing') on ? addClause(c) : dropClause(c.id); });
      recalc(); toast('Clauses filled in from ' + $b('#qeFill').selectedOptions[0].textContent + '.');
    });
    // the master clauses library, live while quoting: insert any clause into this quotation (optionally into the defaults too)
    $b('#qeLib').addEventListener('click', () => {
      const pool = S.clauses.filter(c => c.active && (c.scope_type === 'one_off_general' || (custId && c.scope_type === 'customer' && Number(c.scope_id) === custId) || (polId && c.scope_type === 'policy' && Number(c.scope_id) === polId)));
      const box = FC.el(`<div><div class="toolbar" style="margin-top:0"><input class="input" type="search" id="qlQ" placeholder="Search title or wording" aria-label="Search"><select class="input" id="qlCat" aria-label="Category"><option value="">All categories</option>${CL_CAT.map(([k]) => `<option value="${k}">${esc(catLabel(k))}</option>`).join('')}</select></div>
        ${custId ? `<label class="small" style="display:flex;gap:6px;align-items:center;margin:0 0 8px"><input type="checkbox" id="qlSave" style="width:auto;min-width:0"> Also add to the defaults of ${esc(polId ? 'policy ' + polLabel(og.policy) : og.customer.name)} (active)</label>` : ''}
        <div class="cl-lib" id="qlList" style="max-height:55vh"></div></div>`);
      const paintQl = () => { const q = box.querySelector('#qlQ').value.trim().toLowerCase(), cat = box.querySelector('#qlCat').value;
        const list = pool.filter(c => (!cat || c.category === cat) && (!q || (c.title + ' ' + c.body).toLowerCase().includes(q))).sort((a, b) => catOrder(a.category) - catOrder(b.category) || (a.sort || 0) - (b.sort || 0));
        box.querySelector('#qlList').innerHTML = list.slice(0, 300).map(c => { const there = !!docEl.querySelector(`[data-cid="${c.id}"]`); return `<div class="cl-libitem${there ? ' in' : ''}"><div><b>${esc(c.title)}</b><span class="xs muted">${esc(catLabel(c.category))} - ${esc(c.body.slice(0, 140))}${c.body.length > 140 ? '…' : ''}</span></div><button type="button" class="btn btn-ghost btn-sm" data-ins="${c.id}" ${there ? 'disabled' : ''}>${there ? 'In quotation' : 'Insert'}</button></div>`; }).join('') || '<p class="xs muted">No match.</p>'; };
      box.addEventListener('input', paintQl); box.addEventListener('change', e => { if(e.target.id === 'qlCat') paintQl(); });
      box.addEventListener('click', async e => { const bb = e.target.closest('[data-ins]'); if(!bb) return; const c = pool.find(x => x.id === Number(bb.dataset.ins)); if(!c) return;
        if(!lib.includes(c)){ lib.push(c); let grp = picks.querySelector(`[data-pcat="${c.category}"]`); if(!grp){ grp = FC.el(`<div class="qe-pick" data-pcat="${c.category}"><b>${esc((CL_CAT.find(x => x[0] === c.category) || [0, c.category])[1])}</b></div>`); picks.appendChild(grp); } grp.appendChild(FC.el(`<label><input type="checkbox" data-cid="${c.id}"> ${esc(c.title)}</label>`)); }
        const cb = picks.querySelector(`[data-cid="${c.id}"]`); cb.checked = true; if(c.category === 'pricing') recalc(); else addClause(c);
        if(box.querySelector('#qlSave') && box.querySelector('#qlSave').checked){ const lvl = polId ? { t:'policy', id: polId } : { t:'customer', id: custId }; const tbl = lvl.t === 'customer' ? 'customer_clauses' : 'policy_clauses', col = lvl.t === 'customer' ? 'customer_id' : 'policy_id';
          const { error } = await sb.from(tbl).upsert({ [col]: lvl.id, clause_id: c.id, enabled: true, sort: 900 }, { onConflict: col + ',clause_id' }); if(error) toast(error.message, 'error'); else { if(lvl.t === 'customer') S.custClauses.push({ customer_id: lvl.id, clause_id: c.id, enabled: true }); else S.polClauses.push({ policy_id: lvl.id, clause_id: c.id, enabled: true }); } }
        toast(c.title + ' inserted.'); paintQl(); });
      paintQl();
      FC.dialog({ title:'Master clauses library', wide:true, body: box, actions:[{ label:'Done', kind:'primary', value:true }] });
    });
    // update quotation: rate the changed shipment again (same customer / office / policy, nothing saved)
    let rated = null;
    const viaList = () => $b('#qeVia').value.split(/[,;\s]+/).map(x => x.trim().toUpperCase()).filter(Boolean);
    $b('#qeUpd').addEventListener('click', async e => {
      const bb = e.currentTarget, inv = FC.parseNum($b('#qeInv').value);
      if(!(inv > 0)) return toast('Enter the invoice value.', 'error');
      const p = { commodity_id: $b('#qeCom').value, goods_description: $b('#qeGoods').value.trim() || r.goods_description, packaging: $b('#qePack').value.trim(), conveyance: $b('#qeConv').value,
        origin_country: $b('#qeOC').value.trim().toUpperCase(), origin_place: $b('#qeOP').value.trim(), dest_country: $b('#qeDC').value.trim().toUpperCase(), dest_place: $b('#qeDP').value.trim(),
        transit_countries: viaList(), invoice_value: inv, freight_value: r.freight_value || 0, currency: $b('#qeCur').value, uplift_pct: r.uplift_pct, cover: $b('#qeCov').value, war_strikes: $b('#qeWarOn').checked,
        on_deck: r.on_deck, interest_only: r.interest_only, ext_hssc: r.ext_hssc, ext_liw: r.ext_liw, incoterm: r.incoterm, insured_party: r.insured_party, vessel: $b('#qeVessel').value.trim(),
        departure_date: $b('#qeDep').value && $b('#qeDep').value >= FC.today() ? $b('#qeDep').value : null, red_sea: r.red_sea || 'auto', details: r.details || {}, insured_country: r.insured_country, ftz: r.ftz };
      busy(bb, true);
      const sa = $b('#qeSA').checked;
      const { data, error } = await sb.rpc('admin_indicate', { p, p_customer: r.customer_id || null, p_office: r.office_id || null, p_policy: og.policy && !sa ? og.policy.id : null, p_one_off: !og.policy && !r.customer_id, p_standalone: sa, p_save: false });
      busy(bb, false);
      if(error){ $b('#qeUpdMsg').textContent = 'Could not rate: ' + error.message; return; }
      const x = data.one_off || data.result, n = x.n || {};
      rated = { p, x, sa };
      const first = body.querySelector('#qeLines tr');
      if(first){ first.querySelector('.ln-sum').value = n.sum_insured; first.querySelector('.ln-rate').value = x.status === 'quoted' ? x.rate : ''; }
      if(x.min != null) $b('#qeMin').value = x.min;
      if(x.deductible) $b('#qeDed').value = x.deductible;
      $b('#qeVoy').value = [p.origin_place, cName(p.origin_country)].filter(Boolean).join(', ') + ' to ' + [p.dest_place, cName(p.dest_country)].filter(Boolean).join(', ') + (p.transit_countries.length ? ' via ' + p.transit_countries.map(cName).join(', ') : '');
      if(p.departure_date) $b('#qePer').value = 'Transit commencing on or about ' + FC.date(p.departure_date);
      $b('#qeAlerts').innerHTML = alertList({ alerts: (data.result.out_of_cover ? [{ level:'red', text:'Out of cover - rated with the general one-off pool' }] : []).concat(x.alerts || []) }) +
        (x.status !== 'quoted' ? `<div class="al-row al-orange"><i></i>${esc(FC.STATUS[x.status] || x.status)}: ${esc((x.reasons || []).join('; '))} - enter the rate by hand.</div>` : '');
      if($b('#qeWarAreas') && x.war){ $b('#qeWarAreas').value = (x.war.areas || []).map(a => a.name).join('\n'); const net = (x.war.areas || []).reduce((t, a) => t + Number(a.net_permille || 0), 0) / 10; $b('#qeBb').value = net ? Math.round(net * 10000) / 10000 : ''; }
      $b('#qeUpdMsg').textContent = x.status === 'quoted' ? 'Updated: ' + FC.pct(x.rate) + ' on ' + money2(n.sum_insured, p.currency) + ' = ' + money2(x.net, p.currency) + (x.min_hit ? ' (minimum)' : '') + '.' : 'Updated - no automatic rate.';
      recalc();
    });
    // the pricing block is rebuilt from the figures; brokers cannot edit numbers by accident
    const paintPricing = (c, t, wx) => {
      const sec = sectionFor('pricing'); sec.setAttribute('contenteditable', 'false');
      const ln = c.lines[0] || {}, notes = lib.filter(x => x.category === 'pricing' && picks.querySelector(`[data-cid="${x.id}"]`) && picks.querySelector(`[data-cid="${x.id}"]`).checked);
      // Editor.pdf format: bold labels, amounts as "USD 100.00"
      const am = n => isFinite(Number(n)) && n !== '' && n != null ? c.cur + ' ' + Number(n).toLocaleString('en-GB', { minimumFractionDigits:2, maximumFractionDigits:2 }) : '-';
      const basis = (100 + Number(r.uplift_pct || 0)) + '% ' + (r.incoterm && !/^(EXW|FCA|FAS|FOB)$/.test(r.incoterm) ? r.incoterm : 'CIF') + ' value';
      const sR = FC.showRate(c.mode), sP = FC.showPremium(c.mode);
      sec.innerHTML = `${sR ? `<p><b>Premium Rate:</b> ${esc(isFinite(ln.rate) ? FC.pct(ln.rate) : '-')} on ${esc(basis)}${og.policy || !sP ? '' : ' (sum insured ' + esc(am(ln.sum)) + ', premium ' + esc(am(t ? t.net : NaN)) + ')'}</p>` : ''}
        ${sP && !sR ? `<p><b>Premium:</b> ${esc(am(t ? t.net : NaN))} (sum insured ${esc(am(ln.sum))})</p>` : ''}
        <p><b>Minimum Premium:</b> ${esc(am(c.min))}${wx && wx.offerBuyback && sR ? `<br>Rate with War &amp; Strikes excluded for ${esc(wx.areas.join(', '))}: <b>${esc(FC.pct(wx.rateExcl))}</b><br>Rate with War &amp; Strikes re-included: <b>${esc(FC.pct(wx.rateIncl))}</b>` : ''}${wx && wx.offerBuyback && !sR ? `<br>Premium with War &amp; Strikes excluded for ${esc(wx.areas.join(', '))}: <b>${esc(am(wx.totalExcl))}</b><br>Premium with War &amp; Strikes re-included: <b>${esc(am(wx.totalIncl))}</b>` : ''}</p>
        ${wx ? `<p>War &amp; Strikes excluded for: ${esc(wx.areas.join(', '))}; remaining in force for the rest of the voyage.</p>` : ''}
        <p><b>Deductible:</b> ${esc($b('#qeDed').value.trim() || '-')}</p>
        ${c.tax && sP ? `<p><b>Net Premium:</b> ${esc(am(t ? t.net : NaN))}<br><b>German IPT (${esc(c.tax)}%):</b> ${esc(am(t ? t.tax : NaN))}<br><b>Gross Total incl. IPT:</b> ${esc(am(t ? t.total : NaN))}</p>` : c.tax ? `<p>German IPT (${esc(c.tax)}%) is added to the premium.</p>` : ''}
        ${notes.map(x => `<p data-cid="${x.id}">${esc(fillIn(x.body))}</p>`).join('')}`;
    };
    const docHtml = () => FC.cleanHtml(docEl.innerHTML);
    const docTexts = cat => Array.from(docEl.querySelectorAll(`section[data-cat="${cat}"] p, section[data-cat="${cat}"] li, section[data-cat="${cat}"] div`)).map(x => x.textContent.trim()).filter(Boolean);
    // formatting toolbar
    wireRt($b('.rt-bar'), docEl, { ctx: mctx, onCopy: async () => { recalc(); const ok = await FC.copyRich(FC.emailHtml(docHtml(), fmt), FC.htmlText(docHtml())); toast(ok ? 'Copied - paste it into your e-mail.' : 'Copy failed; select the text and copy it manually.', ok ? undefined : 'error'); } });
    const collect = () => {
      const lines = Array.from(body.querySelectorAll('#qeLines tr')).map(tr => {
        const sum = FC.parseNum(tr.querySelector('.ln-sum').value), rate = FC.parseNum(tr.querySelector('.ln-rate').value);
        return { label: tr.querySelector('.ln-label').value.trim(), sum, rate, premium: isFinite(sum) && isFinite(rate) ? Math.round(sum * rate) / 100 : NaN, tr };
      });
      return { lines, disc: FC.parseNum($b('#qeDisc').value) || 0, min: FC.parseNum($b('#qeMin').value) || 0, tax: $b('#qeTaxOn').checked ? (FC.parseNum($b('#qeTax').value) || 0) : 0, brk: FC.parseNum($b('#qeBrk').value) || 0, reb: FC.parseNum($b('#qeReb').value) || 0, cur: $b('#qeCur').value, mode: $b('#qeMode').value };
    };
    const recalc = () => {
      const c = collect();
      c.lines.forEach(l => { l.tr.querySelector('.ln-prem').textContent = isFinite(l.premium) ? money2(l.premium, c.cur) : '-'; });
      const ok = c.lines.length && c.lines.every(l => isFinite(l.premium));
      if(!ok){ $b('#qeSum').innerHTML = '<tr><td class="muted">Enter sum insured and rate for each line.</td></tr>'; $b('#qeBrkAmt').textContent = $b('#qeNetIns').textContent = '-'; return; }
      const t = calcQuote(c.lines, c.disc, c.min, c.tax);
      const ba = Math.round(t.net * c.brk) / 100;
      $b('#qeBrkAmt').textContent = money2(ba, c.cur); $b('#qeNetIns').textContent = money2(Math.round((t.net - ba) * 100) / 100, c.cur);
      const ra = Math.round(t.net * c.reb) / 100; $b('#qeRebAmt').textContent = money2(ra, c.cur); $b('#qeKeep').textContent = money2(Math.round((ba - ra) * 100) / 100, c.cur);
      $b('#qeKeep').style.color = ba - ra < 0 ? 'var(--danger)' : '';
      $b('#qeSum').innerHTML = `<tr><td>Premium</td><td class="r">${esc(money2(t.subtotal, c.cur))}</td></tr>
        ${c.disc ? `<tr><td>Client discount ${esc(c.disc)} %</td><td class="r">- ${esc(money2(t.discountAmount, c.cur))}</td></tr>` : ''}
        ${t.minApplied ? `<tr><td>Minimum premium applies</td><td class="r">${esc(money2(t.net, c.cur))}</td></tr>` : ''}
        ${c.tax ? `<tr><td>Net premium</td><td class="r">${esc(money2(t.net, c.cur))}</td></tr><tr><td>German IPT (${esc(c.tax)}%)</td><td class="r">${esc(money2(t.tax, c.cur))}</td></tr>` : ''}
        <tr class="tot"><td>${c.tax ? 'Gross total incl. IPT' : 'Total premium payable'}</td><td class="r">${esc(money2(t.total, c.cur))}</td></tr>`;
      paintIpt();
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
    // IPT: the rules decide until the broker switches it by hand
    let iptManual = !!(prev && d.iptManual);
    const paintIpt = () => { const a = iptAuto($b('#qeOC').value.trim().toUpperCase(), $b('#qeDC').value.trim().toUpperCase()), on = $b('#qeTaxOn').checked;
      $b('#qeIptWhy').className = 'ipt-badge' + (on ? ' on' : '');
      $b('#qeIptWhy').textContent = iptManual && on !== a.applied ? (on ? 'German IPT applied by hand' : 'German IPT switched off by hand') + ' (rules: ' + a.reason + ')' : on ? a.reason.replace(/^No German IPT: .*/, 'German IPT applied') : a.reason; };
    $b('#qeTaxOn').addEventListener('change', () => { iptManual = true; $b('#qeTax').disabled = !$b('#qeTaxOn').checked; recalc(); });
    ['#qeOC', '#qeDC'].forEach(id => $b(id).addEventListener('change', () => { if(iptManual) return; const a = iptAuto($b('#qeOC').value.trim().toUpperCase(), $b('#qeDC').value.trim().toUpperCase()); $b('#qeTaxOn').checked = a.applied; $b('#qeTax').disabled = !a.applied; recalc(); }));
    $b('#qeMode').addEventListener('change', recalc);
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
        displayMode: c.mode, iptApplied: c.tax > 0, iptRate: c.tax || null, iptManual, iptReason: c.tax > 0 ? $b('#qeIptWhy').textContent : '', fmt,
        lines: c.lines.map(l => ({ label:l.label, sum: Math.round(l.sum * 100) / 100, rate: l.rate, premium: l.premium })),
        subtotal: t.subtotal, discountAmount: t.discountAmount, net: t.net, minApplied: t.minApplied, tax: t.tax, total: t.total, warExcl: warBlock(c),
        sumInsured: Math.max(...c.lines.map(l => l.sum)),
        subjectivities: docTexts('subjectivity').slice(0, 40), note: $b('#qeNote').value.trim(), closing: $b('#qeClose').value.trim(),
        handler: { name: $b('#qeHandler').value.trim(), email: me().email, initials: myInitials() }, issuedAt: new Date().toISOString(),
        commodityId: $b('#qeCom').value, invoiceValue: FC.parseNum($b('#qeInv').value), transit: viaList(), cover: $b('#qeCov').value, warStrikes: $b('#qeWarOn').checked, departureDate: $b('#qeDep').value || null
      } };
    };
    return FC.dialog({ title: 'Quotation for ' + (r.ref || 'indication #' + r.id), wide:true, body, onOpen: () => recalc(),
      actions: [
        { label:'Cancel', kind:'ghost', value:false },
        { label:'Preview PDF', kind:'ghost', onClick: async () => { const b = build(); if(!b) return; FC.saveBlob(await FCPDF.quotation({ data:b.data, valid_until:b.validUntil, version:1, created_at:new Date().toISOString() }, r), FCPDF.fileName('PREVIEW_Quotation', r.ref)); } },
        { label: opt.draft ? 'Save changes' : 'Save quotation', kind:'ghost', onClick: async () => persist(false) },
        { label:'Save & send to client', kind:'primary', onClick: async () => persist(true) }
      ] });
    async function persist(send){
          const b = build(); if(!b) return;
          let method = 'portal_email';
          if(send){ method = await askMethod('Send this quotation?', (FC.showPremium(b.data.displayMode) ? 'Total ' + money2(b.data.total, b.data.currency) : 'Rate only, no premium figure') + ', valid until ' + FC.dateTime(b.validUntil) + '.'); if(!method) return; }
          // the case follows an updated rating basis
          if(rated){ const n = rated.x.n || {}; const { error: ue } = await sb.from('indications').update({ commodity_id: rated.p.commodity_id, conveyance: rated.p.conveyance, origin_country: rated.p.origin_country, origin_place: rated.p.origin_place || null,
              dest_country: rated.p.dest_country, dest_place: rated.p.dest_place || null, transit_countries: rated.p.transit_countries, invoice_value: rated.p.invoice_value, currency: rated.p.currency, sum_insured: n.sum_insured,
              cover: rated.p.cover, war_strikes: !!n.war_strikes, departure_date: rated.p.departure_date, is_standalone_one_off: !!rated.sa, policy_id: rated.sa ? null : r.policy_id, goods_description: rated.p.goods_description, packaging: rated.p.packaging || null, vessel: rated.p.vessel || null }).eq('id', r.id);
            if(ue){ $b('#qeErr').textContent = 'Could not update the case: ' + ue.message; return; } }
          const { error } = await sb.rpc('admin_save_quotation', { p_indication_id: r.id, p_data: b.data, p_valid_until: b.validUntil, p_internal: b.internal, p_send: send, p_method: method, p_quotation_id: opt.draft ? opt.draft.id : null });
          if(error){ $b('#qeErr').textContent = (send ? 'Could not send: ' : 'Could not save: ') + error.message; return; }
          toast(send ? (method === 'manual' ? 'Quotation saved and released - send it yourself (manual dispatch).' : 'Quotation sent to the client.') : 'Quotation saved. It is not visible to the client until you send it.'); return true;
    }
  }

  // ---------------- certificate (AKM / MARINCON form): data → editable form → .fdf or filled PDF ----------------
  const CERT_PATH = 'certificate.pdf';
  // certificates: per client switch (or a policy that issues certificates)
  const certOn = r => { const og = orgOfCase(r), cu = og.customer || custOf(r.customer_id); return !!((cu && cu.fdf_certificate_enabled) || (og.policy && og.policy.certificate) || r.is_direct_certificate); };
  async function certificateDialog(r, existing, opt){
    opt = opt || {};
    const qs = (S.quotes[r.id] || []).filter(q => q.status !== 'superseded'), q = qs.filter(x => x.status === 'accepted').pop() || qs.slice(-1)[0];
    if(!q && !existing && !opt.direct && !r.is_direct_certificate){ toast('Create a quotation first - the certificate takes its terms from it.', 'error'); return false; }
    const d = (q && q.data) || {}, og = orgOfCase(r), cf = setting('certificate_form', {}) || {}, det = r.details || {}, cu = og.customer || custOf(r.customer_id) || {};
    const air = /^air/.test(r.conveyance);
    // number: from the policy year's numbering matrix (or the running number), manual where allowed; expired policies are blocked
    const pv = existing ? null : ((await sb.rpc('admin_cert_number_preview', { p_indication: r.id })).data || { mode:'legacy', number:'' });
    if(pv && pv.blocked){ await FC.dialog({ title:'Certificate blocked', body:`<div class="notice warn pol-lock" style="margin:0"><b>Policy expired</b>${esc(pv.message)}</div>`, actions:[{ label:'OK', kind:'primary', value:true }] }); return false; }
    const lvl = caseLevel(r), ta = tplFor('certificate_agreements', lvl.custId, lvl.polId), taTxt = ta && String(ta.body || '').trim() ? FC.htmlText(FC.merge(ta.body, mergeCtx(r, d))) : '';
    const two = n => String(n).padStart(2, '0'), today = new Date(), dmy = two(today.getDate()) + '.' + two(today.getMonth() + 1) + '.' + today.getFullYear();
    const fmt = n => Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits:2, maximumFractionDigits:2 });
    const goods = [d.goods || r.goods_description, d.packaging || r.packaging ? 'Packing: ' + (d.packaging || r.packaging) : '', det.equipment ? 'Equipment: ' + det.equipment : '',
      [det.pieces ? det.pieces + ' piece(s)' : '', det.weight_kg ? Number(det.weight_kg).toLocaleString('en-GB') + ' kg gross' : '', det.dimensions || ''].filter(Boolean).join(', '), det.hs_code ? 'HS code ' + det.hs_code : ''].filter(Boolean).join('\n');
    const special = d.special || r.conditions || '';
    const war = d.warExcl ? 'War & strikes excluded for: ' + d.warExcl.areas.join(', ') + '.' : (r.war_excluded || []).length ? 'War & strikes excluded for: ' + r.war_excluded.join(', ') + '.' : '';
    const agreements = [taTxt, special, war, (d.coAssured || []).length ? 'Co-assured / loss payee: ' + d.coAssured.join('; ') : '', d.deductible ? 'Deductible: ' + d.deductible : ''].filter(Boolean).join('\n');
    const inc = (r.incoterm || '').toUpperCase();
    const def = existing ? existing.data : {
      no: pv ? pv.number : '', polNo: cu.cert_open_policy || cf.open_policy || '3441', doc: 'Original', docNo: '1.', originals: '1',
      curr: d.currency || r.currency, sum: fmt(d.sumInsured || r.sum_insured), perc: String(100 + Number(r.uplift_pct || 0)), valueType: ['CIF','CIP'].includes(inc) ? 'CIF Value' : 'Invoice Value',
      date: dmy, ref: [r.ref, r.customer_ref].filter(Boolean).join(' / '), holder: cu.cert_holder || [d.client || r.insured_name || who(r).company, d.clientAddress].filter(Boolean).join(', '),
      goods, from: [d.originPlace || r.origin_place, cName(d.originCountry || r.origin_country)].filter(Boolean).join(', '), to: [d.destPlace || r.dest_place, cName(d.destCountry || r.dest_country)].filter(Boolean).join(', '),
      conveyance: [(FC.CONVEYANCE[r.conveyance] || {}).label, d.vessel || r.vessel].filter(Boolean).join(' - '), box: air ? '6' : '5', agreements, claims: cu.cert_claims_contact || cf.claims_contact || 'www.vht-network.de' };
    const f = (id, label, val, o) => `<div class="field" ${o && o.span ? 'style="grid-column:1/-1"' : ''}><label for="${id}">${label}${o && o.req ? ' <span class="req">*</span>' : ''}</label>${o && o.rows ? `<textarea id="${id}" rows="${o.rows}">${esc(val || '')}</textarea>` : o && o.opts ? `<select id="${id}">${o.opts.map(x => `<option ${x === val ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>` : `<input id="${id}" value="${esc(val || '')}">`}</div>`;
    const accepted = q && q.status === 'accepted';
    const body = FC.el(`<div>
      ${!accepted && q ? `<label class="switch" style="margin-top:0"><input type="checkbox" id="ceAccept"><span><b>Client accepted outside the portal</b><span>Marks quotation version ${q.version} as accepted before the certificate is issued.</span></span></label>` : ''}
      ${existing ? '' : `<div class="field"><label>Certificate number</label><div class="seg" id="ceNumMode" role="radiogroup" aria-label="Certificate number"><button type="button" data-v="auto" aria-checked="true">${pv.mode === 'matrix' ? 'Auto from matrix ' + esc(pv.matrix || '') : 'Auto (running number)'}</button><button type="button" data-v="manual" aria-checked="false" ${pv.mode === 'matrix' && pv.allow_manual === false ? 'disabled title="Manual numbers are switched off for this matrix"' : ''}>Manual number</button></div><span class="hint" id="ceNumHint">Next number: <b>${esc(pv.number)}</b> (assigned when the certificate is saved)</span></div>`}
      <div class="grid3" style="margin-top:6px">
        ${f('ceNo', 'Certificate no.', def.no, { req:true })}${f('cePol', 'Open policy no. (form)', def.polNo)}${f('ceRef', 'Order / ref. no.', def.ref)}
        ${f('ceCurr', 'Currency', def.curr, { req:true, opts:['USD','EUR','GBP','SGD'] })}${f('ceSum', 'Sum insured', def.sum, { req:true })}${f('ceDate', 'Date of issue', def.date, { req:true })}
        ${f('cePerc', '% of', def.perc)}${f('ceVal', 'Type of value', def.valueType, { opts:['CIF Value','Invoice Value'] })}${f('ceOri', 'Originals', def.originals)}
        ${f('ceDoc', 'Document', def.doc, { opts:['Original','Copy'] })}${f('ceDocNo', 'Document no.', def.docNo, { opts:['1.','2.','3.'] })}
        <div class="field"><label>Conditions overleaf (box between 4 and 7)</label><div class="seg" id="ceBox"><button type="button" data-v="5" aria-checked="${def.box === '5'}">5 · sea / road / rail</button><button type="button" data-v="6" aria-checked="${def.box === '6'}">6 · air</button></div></div>
        ${f('ceHolder', 'Insurance granted under the open policy to', def.holder, { req:true, span:true })}
        ${f('ceGoods', 'Goods (description, packing, marks)', def.goods, { req:true, span:true, rows:5 })}
        ${f('ceFrom', 'Voyage from', def.from, { req:true })}${f('ceTo', 'to', def.to, { req:true })}${f('ceConv', 'per (conveyance / vessel)', def.conveyance, { req:true })}
        ${f('ceAgr', 'Letter of credit / additional agreements', def.agreements, { span:true, rows:5 })}
        ${f('ceClaims', 'In case of loss or damage immediately contact', def.claims, { span:true, rows:2 })}
      </div>
      <div class="notice info fdf-help"><b>Using the .fdf</b>${esc(FC.FDF_HINT)} The file names no PDF, so it works with any copy or renamed master form. Sum insured goes into the form as 33562.80 (Acrobat shows 33,562.80), date as 06.10.2026, condition 5 for sea / road / rail and 6 for air.</div>
      <div class="err-msg" id="ceErr"></div></div>`);
    body.querySelector('#ceBox').addEventListener('click', e => { const b = e.target.closest('button'); if(b) body.querySelectorAll('#ceBox button').forEach(x => x.setAttribute('aria-checked', String(x === b))); });
    const numManual = () => !!body.querySelector('#ceNumMode [data-v="manual"][aria-checked="true"]');
    if(!existing){ const noIn = body.querySelector('#ceNo'); noIn.readOnly = true;
      body.querySelector('#ceNumMode').addEventListener('click', e => { const b = e.target.closest('button'); if(!b || b.disabled) return; body.querySelectorAll('#ceNumMode button').forEach(x => x.setAttribute('aria-checked', String(x === b)));
        const man = b.dataset.v === 'manual'; noIn.readOnly = !man; if(man){ noIn.value = ''; noIn.focus(); } else noIn.value = pv.number;
        body.querySelector('#ceNumHint').innerHTML = man ? 'Type the exact certificate number.' : 'Next number: <b>' + esc(pv.number) + '</b> (assigned when the certificate is saved)'; }); }
    const v = id => body.querySelector(id).value.trim();
    const collect = () => {
      const err = t => { body.querySelector('#ceErr').textContent = t; return null; };
      const data = { no: v('#ceNo'), polNo: v('#cePol'), ref: v('#ceRef'), curr: v('#ceCurr'), sum: v('#ceSum'), date: v('#ceDate'), perc: v('#cePerc'), valueType: v('#ceVal'), originals: v('#ceOri'),
        doc: v('#ceDoc'), docNo: v('#ceDocNo'), box: (body.querySelector('#ceBox [aria-checked="true"]') || {}).dataset.v || '5', holder: v('#ceHolder'), goods: v('#ceGoods'),
        from: v('#ceFrom'), to: v('#ceTo'), conveyance: v('#ceConv'), agreements: v('#ceAgr'), claims: v('#ceClaims') };
      const miss = [existing || numManual() ? ['no','Certificate no.'] : null,['curr','Currency'],['sum','Sum insured'],['date','Date of issue'],['holder','Holder'],['goods','Goods'],['from','Voyage from'],['to','Voyage to'],['conveyance','Conveyance']].filter(Boolean).filter(([k]) => !data[k]).map(([, l]) => l);
      if(miss.length) return err('Please fill in: ' + miss.join(', ') + '.');
      if(!/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(data.date)) return err('Date of issue as DD.MM.YYYY.');
      if(!(FC.parseNum(data.sum) > 0)) return err('The sum insured must be a number.');
      data.sum = fmt(FC.parseNum(data.sum));                                   // always 33,562.80
      data.date = data.date.split('.').map((x, i) => i < 2 ? x.padStart(2, '0') : x).join('.');   // always 06.10.2026
      data.perc = String(data.perc || '').replace(/[^\d.,]/g, '');
      const clash = (existing || numManual()) && S.certs.find(c => c.number === data.no && (!existing || c.id !== existing.id));
      if(clash) return err('Certificate no. ' + data.no + ' is already used.');
      body.querySelector('#ceErr').textContent = ''; return data;
    };
    // exact AcroForm field names of the form
    const formFields = x => FCPDF.certFields(x);
    const store = async x => {
      if(body.querySelector('#ceAccept') && body.querySelector('#ceAccept').checked){
        const now = new Date().toISOString();
        let e1 = (await sb.from('quotations').update({ status:'accepted', responded_at: now, response_note: 'Accepted outside the portal (recorded by ' + myInitials() + ')' }).eq('id', q.id)).error;
        if(!e1) e1 = (await sb.from('indications').update({ stage:'certificate' }).eq('id', r.id)).error;
        if(e1){ toast('Could not mark the quotation as accepted: ' + e1.message, 'error'); return false; }
      }
      if(existing){
        const res = await sb.from('certificates').update({ indication_id: r.id, quotation_id: q ? q.id : existing.quotation_id || null, number: x.no, data: x }).eq('id', existing.id);
        if(res.error){ toast('Could not save the certificate: ' + res.error.message, 'error'); return false; }
        return true;
      }
      const { data: out, error } = await sb.rpc('admin_issue_certificate', { p_indication: r.id, p_quotation: q ? q.id : null, p_data: x, p_number: numManual() ? x.no : null });
      if(error){ body.querySelector('#ceErr').textContent = 'Could not issue the certificate: ' + error.message; return false; }
      x.no = out.number; body.querySelector('#ceNo').value = out.number;
      return true;
    };
    const fileBase = x => 'Certificate_' + String(x.no).replace(/[^\w-]+/g, '_') + (r.ref ? '_' + r.ref : '');
    return FC.dialog({ title: (existing ? 'Certificate ' + existing.number : 'New certificate') + ' · ' + (og.policy ? og.policy.name : ''), wide:true, body, actions:[
      { label:'Cancel', kind:'ghost', value:null },
      { label:'Upload blank form', kind:'ghost', onClick: async () => {
          const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/pdf';
          inp.onchange = async () => { const fl = inp.files[0]; if(!fl) return; const { error } = await sb.storage.from('forms').upload(CERT_PATH, fl, { upsert:true, contentType:'application/pdf' }); toast(error ? 'Upload failed: ' + error.message : 'Blank form stored.', error ? 'error' : undefined); };
          inp.click();
        } },
      { label:'Download .fdf', kind:'ghost', onClick: async () => {
          const x = collect(); if(!x) return; if(!(await store(x))) return;
          FC.saveBlob(FCPDF.fdf('', formFields(x)), fileBase(x) + '.fdf', 'application/vnd.fdf');
          FC.toast('Certificate ' + x.no + ' saved - .fdf downloaded. ' + FC.FDF_HINT, 'info', 10000); return true;
        } },
      { label:'Download filled PDF', kind:'primary', onClick: async () => {
          const x = collect(); if(!x) return;
          const { data: blob, error } = await sb.storage.from('forms').download(CERT_PATH);
          if(error || !blob){ body.querySelector('#ceErr').textContent = 'The blank form is not stored yet - click “Upload blank form” once, or use the .fdf.'; return; }
          try{
            const bytes = await blob.arrayBuffer();
            await FCPDF.fillForm(bytes.slice(0), formFields(x));      // the form can be filled at all
            if(!(await store(x))) return;                              // then the number is final
            const out = await FCPDF.fillForm(bytes, formFields(x));
            if(out.missing.length) console.warn('form fields not found', out.missing);
            FC.saveBlob(out.bytes, fileBase(x) + '.pdf', 'application/pdf');
            toast('Certificate ' + x.no + ' saved - PDF downloaded.'); return true;
          }catch(e){
            if(/encrypt/i.test(e.message || '')){ body.querySelector('#ceErr').textContent = 'The stored form is protected against changes (Acrobat security), so the browser cannot fill it. Use “Download .fdf” - Acrobat fills the protected form - or upload a copy of the form saved without the change password.'; return; }
            console.error(e); body.querySelector('#ceErr').textContent = 'The form could not be filled: ' + e.message; }
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
  // "Text to Insurer": a structured placing enquiry for underwriters (editable, copied as rich text + plain text)
  async function insurerText(r){
    const x = indRow(r), det = r.details || {}, w = who(r), conv = (FC.CONVEYANCE[r.conveyance] || {}).label || r.conveyance, sea = /^sea/.test(r.conveyance);
    let files = [];
    if(r.id){ const { data } = await sb.from('request_attachments').select('name,kind').eq('indication_id', r.id).order('id'); files = data || []; }
    const build = disclose => {
      const L = [];
      const sec = (h, rows) => { const rr = rows.filter(z => z && z[1] !== '' && z[1] != null); if(rr.length) L.push({ h, rows: rr }); };
      sec('Assured', [['Assured', disclose ? (r.insured_name || w.company) : 'For account of whom it may concern / our client'], ['Role / capacity', r.insured_party ? FC.partyLabel(r.insured_party, r.party_role_other) : '']]);
      sec('Subject-matter', [['Cargo type', x.commodity_name], ['Description of goods', r.goods_description], ['Condition', det.condition || (/used/i.test(x.commodity_name || '') ? 'Used' : '')],
        ['Packing / equipment', [r.packaging, det.equipment].filter(Boolean).join(', ')], ['Pieces', det.pieces], ['Gross weight', det.weight_kg ? Number(det.weight_kg).toLocaleString('en-GB') + ' kg' : ''],
        ['Dimensions (L x W x H)', det.dimensions], ['HS code', det.hs_code]]);
      sec('Conveyance', [['Conveyance', conv], ['Vessel', r.vessel], ['IMO / year built / flag / class', [det.imo ? 'IMO ' + det.imo : '', det.year_built, det.flag, det.class].filter(Boolean).join(' / ')],
        ['Stowage', sea ? (r.on_deck ? 'On deck' : 'Under deck') : '']]);
      sec('Voyage', [['From', [r.origin_place, cName(r.origin_country)].filter(Boolean).join(', ')], ['Via / transhipment', (r.transit_countries || []).map(cName).join(', ')],
        ['Seas / canals', r.red_sea === 'yes' ? 'Via Suez Canal / Red Sea' : r.red_sea === 'no' ? 'Not via Suez / Red Sea (e.g. via the Cape)' : ''], ['To', [r.dest_place, cName(r.dest_country)].filter(Boolean).join(', ')],
        ['Departure date / ETA of loading', r.departure_date ? FC.date(r.departure_date) : 'tba'], ['Storage (pre / post transit)', det.storage]]);
      sec('Values', [['Valuation basis / Incoterm', [r.incoterm ? r.incoterm + ' (' + ((FC.INCOTERMS[r.incoterm] || {}).name || '') + ')' : '', 'invoice value + ' + Number(r.uplift_pct || 0) + ' %'].filter(Boolean).join(', ')],
        ['Currency', r.currency], ['Invoice value', money2(r.invoice_value, r.currency)], ['Freight', Number(r.freight_value) ? money2(r.freight_value, r.currency) : ''], ['Uplift', Number(r.uplift_pct || 0) + ' %'], ['Total sum insured', money2(r.sum_insured, r.currency)]]);
      sec('Cover required', [['Conditions', ((FC.COVER[r.cover] || {}).clause || '') + (r.war_strikes ? (/^(road|rail)$/.test(r.conveyance) ? ', incl. strikes' : ', incl. war and strikes') : ', excl. war and strikes')],
        ['Extensions', [r.ext_hssc ? 'HSSC' : '', r.ext_liw ? 'Loss in weight / difference in weight' : '', r.interest_only ? "Seller's / buyer's interest only" : ''].filter(Boolean).join(', ')],
        ['Special clauses', r.conditions], ['Deductible expectation', x.deductible_text]]);
      sec('Documents available for review', files.length ? files.map(f => ['', f.name + (f.kind ? ' (' + f.kind + ')' : '')]) : [['', 'none attached']]);
      if(r.customer_comment) sec('Remarks', [['', r.customer_comment]]);
      const details = L.map(s2 => `<p><b><u>${esc(s2.h)}</u></b><br>${s2.rows.map(([k, v]) => (k ? esc(k) + ': ' : '') + esc(v)).join('<br>')}</p>`).join('');
      const html = `<p>Dear colleagues,</p><p>we would be grateful for your quotation on the following risk:</p>` + details + `<p>Kind regards<br>${esc(me().full_name || '')}<br>MARINCON GmbH &amp; Co. KG</p>`;
      // the template of the level (configuration -> client -> policy); [[shipment_details]] alone = the standard text
      const lv = r.id ? caseLevel(r) : { custId: r.customer_id || null, polId: null }, t = tplFor('insurer_text', lv.custId, lv.polId), tb = t ? String(t.body || '') : '';
      if(!tb.trim() || tb.replace(/<[^>]+>|\s|&nbsp;/g, '') === '[[shipment_details]]') return html;
      const ctx = mergeCtx(r, {}); if(!disclose){ ctx.client_name = ''; ctx.assured_name = 'our client'; }
      const merged = FC.merge(tb, ctx);
      return /\[\[shipment_details\]\]/.test(merged) ? merged.replace(/<p>\s*\[\[shipment_details\]\]\s*<\/p>|\[\[shipment_details\]\]/, details) : merged + details;
    };
    const box = FC.el(`<div><label class="switch" style="margin-top:0"><input type="checkbox" id="itDisc" checked><span><b>Disclose the assured</b><span>Off: “For account of whom it may concern / our client”.</span></span></label>
      <div class="it-edit" id="itTxt" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Text to insurer"></div><p class="xs muted">You can edit the text before copying.</p></div>`);
    const ed = box.querySelector('#itTxt'); ed.innerHTML = build(true);
    box.querySelector('#itDisc').addEventListener('change', e => { ed.innerHTML = build(e.target.checked); });
    FC.dialog({ title:'Text to insurer' + (r.ref ? ' · ' + r.ref : ''), wide:true, body: box, actions:[{ label:'Close', kind:'ghost', value:null },
      { label:'Copy text to insurer', kind:'primary', onClick: async () => { const h = FC.cleanHtml(ed.innerHTML), lv = r.id ? caseLevel(r) : {}; const ok = await FC.copyRich(FC.emailHtml(h, fmtFor(lv.custId, lv.polId)), FC.htmlText(h)); toast(ok ? 'Copied - paste it into your e-mail to the underwriters.' : 'Copy failed.', ok ? undefined : 'error'); } }] });
  }
  A.insurerText = insurerText;

  // =================================================================== OVERVIEW
  async function renderOverview(body){
    body.innerHTML = `<div class="toolbar"><select class="input" id="ovDays" aria-label="Period"><option value="7">Last 7 days</option><option value="30" selected>Last 30 days</option><option value="90">Last 90 days</option><option value="365">Last 12 months</option></select></div><div id="ovBody"><div class="empty">Loading…</div></div>`;
    const paint = async () => {
      const { data, error } = await sb.rpc('admin_overview', { p_days: Number($('#ovDays', body).value) });
      const host = $('#ovBody', body);
      if(error){ host.innerHTML = `<div class="empty">Could not load: ${esc(error.message)}</div>`; return; }
      const conv = (data.requests && data.indications) ? Math.round(100 * data.requests / data.indications) : 0;
      const prem = Object.entries(data.premium_bound || {}).map(([c, v]) => money2(v, c)).join(' + ') || '-';
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
    body.innerHTML = `<p class="small muted" style="margin:0 0 14px">Accepted quotations. <b>Gross premium</b> = premium after discount and minimum, before insurance tax. <b>UW commission</b> = brokerage received from the insurer; <b>rebate</b> = commission passed to the client; <b>net retained</b> = what stays with you. The bordereau for underwriters contains technical risk data only - no commissions, no co-insurer shares.</p>
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
  let custTab = 'tree';
  function renderCustomers(body){
    body.innerHTML = `<div class="tabs" role="tablist">${[['tree','Customers, offices & users'],['users','All users'],['groups','Company groups']].concat(isStaffAdmin() ? [['access','User groups, departments & access']] : []).map(([k, l]) => `<button role="tab" data-ctab="${k}" aria-selected="${k === custTab}">${l}</button>`).join('')}</div><div id="ctBody"></div>`;
    $$('[data-ctab]', body).forEach(b => b.addEventListener('click', () => { custTab = b.dataset.ctab; renderCustomers(body); }));
    const host = $('#ctBody', body);
    const V = { tree: renderTree, users: renderUsers, groups: renderGroups, access: renderAccess };
    (V[custTab] || renderTree)(host);
  }
  const liveUsers = () => Object.values(S.profiles).filter(p => !p.deleted_at);
  const userStatus = p => p.rejected ? chip('rejected', 'Rejected') : p.is_active === false ? chip('declined', 'Disabled') : p.approved ? chip('approved', p.is_admin ? 'Staff' : 'Active') : chip('pending', 'Waiting');
  const goScope = (t, sc) => { tab = t; if(t === 'rates') rScope = sc; else clScope = sc; $$('[data-atab]', root).forEach(x => x.setAttribute('aria-selected', String(x.dataset.atab === t))); render(); };

  // ---------- waiting registrations and referrals (top of the tree) ----------
  async function renderPending(body){
    const { data: refs } = await sb.from('referrals').select('*').order('created_at', { ascending:false });
    const pend = pendingUsers(), P = S.profiles;
    if(pend.length){
      body.appendChild(FC.el('<h2 style="margin-bottom:10px">Waiting for activation</h2>'));
      const l = FC.el('<div class="list" style="margin-bottom:24px"></div>');
      pend.forEach(p => {
        const ref = p.referred_by && P[p.referred_by], dc = domainCust(p.email);
        const it = FC.el(`<div class="item new"><div><div class="t">${esc(p.company || '-')}</div><div class="meta">${esc(p.full_name || '')}, ${esc(p.email)}${p.phone ? ', ' + esc(p.phone) : ''}${addrOf(p) ? '<br>' + esc(addrOf(p)) : ''}<br>Registered ${esc(FC.dateTime(p.created_at))}${ref ? ', invited by ' + esc(ref.company || ref.email) : ''}${dc ? '<br>E-mail domain matches customer <b>' + esc(dc.name) + '</b>' : ''}</div></div><div class="acts"></div></div>`);
        it.querySelector('.acts').appendChild(btn('Reject', 'danger', async () => { if(!(await FC.confirm('Reject this account?', 'The user cannot log in.', 'Reject', 'danger'))) return; await upd(p.id, { rejected:true }); }));
        it.querySelector('.acts').appendChild(btn('Approve & set up…', 'ok', () => approveDialog(p)));
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
  }

  // ---------- customers → policies, offices, users ----------
  const openCust = new Set();
  let treeQ = '';
  const treeSel = new Set();
  async function renderTree(body){
    await renderPending(body);
    const users = liveUsers();
    const usersOfCust = c => users.filter(p => (userCust(p) || {}).id === c.id);
    const loose = users.filter(p => !userCust(p) && !p.is_admin && p.approved);
    const bar = FC.el(`<div class="toolbar"><input class="input" type="search" placeholder="Search customers, offices, users" value="${esc(treeQ)}" aria-label="Search"><span style="flex:1"></span>
      <button class="btn btn-ghost btn-sm" type="button" data-x="exp">Expand all</button><button class="btn btn-ghost btn-sm" type="button" data-x="col">Collapse all</button>
      <button class="btn btn-ghost btn-sm" type="button" data-x="user">+ Add user</button><button class="btn btn-primary btn-sm" type="button" data-x="cust">+ Add customer</button></div>`);
    body.appendChild(bar);
    const bulk = FC.el(`<div class="bulkbar" hidden><b></b><span class="bk-acts"></span><button type="button" class="linkbtn">Clear selection</button></div>`); body.appendChild(bulk);
    const list = FC.el('<div class="ctree"></div>'); body.appendChild(list);
    bar.querySelector('[data-x=cust]').addEventListener('click', () => customerDialog(null));
    bar.querySelector('[data-x=user]').addEventListener('click', () => addUserDialog({}));
    bar.querySelector('[data-x=exp]').addEventListener('click', () => { S.customers.forEach(c => openCust.add(c.id)); openCust.add(0); paint(); });
    bar.querySelector('[data-x=col]').addEventListener('click', () => { openCust.clear(); paint(); });
    bulk.querySelector('.linkbtn').addEventListener('click', () => { treeSel.clear(); paint(); });
    [['Activate', true], ['Deactivate', false]].forEach(([l, on]) => bulk.querySelector('.bk-acts').appendChild(btn(l, 'ghost', async b => {
      busy(b, true); const { error } = await sb.from('customers').update({ active: on }).in('id', Array.from(treeSel)); busy(b, false);
      if(error) return toast(error.message, 'error'); toast(treeSel.size + ' customer(s) ' + (on ? 'activated' : 'deactivated') + '.'); await loadAll(); render(); })));
    bulk.querySelector('.bk-acts').appendChild(btn('Copy configuration to…', 'ghost', () => { const ids = Array.from(treeSel); if(ids.length !== 1) return toast('Select exactly one customer as the source.', 'error'); copyDialog(['schedules','cargo','zones','factors','map','war','clauses'], { t:'customer', id: ids[0] }); }));
    bulk.querySelector('.bk-acts').appendChild(btn('Export CSV', 'ghost', () => csvSave('FREIGHTCON_customers', ['Customer','Group','Cover type','Currencies','Policies','Offices','Users','Active'],
      S.customers.filter(c => treeSel.has(c.id)).map(c => [c.name, (grpOf(c.group_id) || {}).name, COVER_T[c.cover_type], (c.currencies || []).join(' '), S.policies.filter(x => x.customer_id === c.id).length, S.offices.filter(x => x.customer_id === c.id).length, usersOfCust(c).length, c.active ? 'yes' : 'no']))));
    bulk.querySelector('.bk-acts').appendChild(btn('Delete', 'danger', async () => {
      const ids = Array.from(treeSel);
      const imps = (await Promise.all(ids.map(i => impactText('company', i)))).join('; ');
      if(!(await seriousConfirm('Delete ' + ids.length + ' customer(s)?', 'Affected: ' + esc(imps) + '. Policies, offices and own configuration are deleted.', [['Delete for good', true]]))) return;
      const { error } = await sb.from('customers').delete().in('id', ids); if(error) return toast(error.message, 'error');
      treeSel.clear(); toast('Deleted.'); await loadAll(); render(); }));
    const paintBulk = () => { bulk.hidden = !treeSel.size; bulk.querySelector('b').textContent = treeSel.size + ' selected'; };
    const userRow = (p, loose) => { const o = ofcOf(p.office_id);
      return `<tr data-u="${esc(p.id)}"><td><b>${esc(p.full_name || '-')}</b><br><span class="xs muted">${esc(p.email)}</span></td><td>${loose ? esc(p.company || '-') : o ? esc(o.name) + (o.location ? '<br><span class="xs muted">' + esc(o.location) + '</span>' : '') : '<span class="muted">-</span>'}</td>
        <td>${p.is_admin ? 'Staff' : 'Client'}${p.cover_type ? '<br><span class="xs muted">' + esc(COVER_T[p.cover_type]) + '</span>' : ''}</td><td>${userStatus(p)}</td><td class="xs">${p.last_login_at ? esc(FC.ago(p.last_login_at)) : '<span class="muted">never</span>'}</td><td class="km"></td></tr>`; };
    const paint = () => {
      const q = treeQ.trim().toLowerCase();
      list.innerHTML = '';
      const match = c => !q || [c.name, (grpOf(c.group_id) || {}).name].concat(S.offices.filter(o => o.customer_id === c.id).map(o => [o.name, o.location, cName(o.country)].join(' ')), S.policies.filter(x => x.customer_id === c.id).map(polLabel), usersOfCust(c).map(p => [p.full_name, p.email].join(' '))).join(' ').toLowerCase().includes(q);
      const custs = S.customers.filter(match);
      if(!custs.length && !loose.length){ list.innerHTML = '<div class="empty card"><h3>No customers yet</h3><p>Add a customer, or approve a registration.</p></div>'; paintBulk(); return; }
      custs.forEach(c => {
        const pols = S.policies.filter(x => x.customer_id === c.id), offs = S.offices.filter(x => x.customer_id === c.id), us = usersOfCust(c), g = grpOf(c.group_id), open = openCust.has(c.id) || (q && q.length > 1);
        const node = FC.el(`<section class="card cnode${open ? ' open' : ''}${c.active ? '' : ' inactive'}"><div class="cnode-head">
            <input type="checkbox" class="cn-sel" aria-label="Select ${esc(c.name)}" ${treeSel.has(c.id) ? 'checked' : ''}>
            <button type="button" class="cn-tog" aria-expanded="${open}"><span class="caret">▸</span><b>${esc(c.name)}</b></button>
            <span class="cn-tags">${chip(c.cover_type === 'one_off' ? 'neutral' : 'accepted', COVER_T[c.cover_type])}${g ? ' <span class="xs muted">' + esc(g.name) + '</span>' : ''} <span class="xs muted">${esc(allowedCurs(null, null, c.id).join(' · '))}</span>${c.active ? '' : ' ' + chip('declined', 'Inactive')}</span>
            <span class="cn-count xs muted">${pols.length} polic${pols.length === 1 ? 'y' : 'ies'} · ${offs.length} office${offs.length === 1 ? '' : 's'} · ${us.length} user${us.length === 1 ? '' : 's'}</span><span class="km"></span></div><div class="cnode-body"></div></section>`);
        node.querySelector('.km').appendChild(kebab(() => customerMenu(c)));
        node.querySelector('.cn-sel').addEventListener('change', e => { e.target.checked ? treeSel.add(c.id) : treeSel.delete(c.id); paintBulk(); });
        node.querySelector('.cn-tog').addEventListener('click', () => { openCust.has(c.id) ? openCust.delete(c.id) : openCust.add(c.id); paint(); });
        if(open){
          const b = node.querySelector('.cnode-body');
          // policies
          const ps = FC.el(`<div class="cn-sec"><div class="cn-sec-h"><h3>Policies</h3><span class="acts"></span></div>${pols.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Policy</th><th>Type</th><th>Currencies</th><th class="r">Min. premium</th><th class="r">Deductible</th><th>Rating</th><th class="km"></th></tr></thead><tbody>${pols.map(po => `<tr data-p="${po.id}"><td><b>${esc(po.name)}</b> <span class="muted">${esc(po.policy_no || '')}</span>${po.active ? '' : ' ' + chip('declined', 'Inactive')}${(() => { const y = polCover(po.id, FC.today()); return y ? ' <span class="xs muted">' + esc(y.label) + (y.status === 'extended' ? ', extended' : '') + '</span>' : ' ' + chip('declined', 'Expired'); })()}</td><td>${esc(COVER_T[po.cover_type] || po.cover_type)}</td><td class="xs">${esc(allowedCurs(null, po.id, c.id).join(' · '))}</td><td class="r num">${esc(amt(po.min_premium, po.currency))}</td><td class="r num">${esc(amt(po.deductible, po.currency))}</td><td class="xs">${po.rating === 'schedule' ? 'Policy schedules' : 'Standard'}${S.rateTables.some(t => t.scope_type === 'policy' && t.scope_id === po.id) ? '<br><span class="muted">own schedules</span>' : ''}</td><td class="km"></td></tr>`).join('')}</tbody></table></div>` : `<p class="small muted" style="margin:0">${c.cover_type === 'one_off' ? 'One-off customer: no policy needed - rated from the general one-off pool.' : 'No policy yet.'}</p>`}</div>`);
          ps.querySelector('.acts').appendChild(btn('+ Add policy', 'ghost', () => policyDialog(null, c.id)));
          ps.querySelectorAll('tr[data-p]').forEach(tr => { const po = polOf(Number(tr.dataset.p)); tr.querySelector('.km').appendChild(kebab(() => policyMenu(po))); });
          b.appendChild(ps);
          // offices
          const os = FC.el(`<div class="cn-sec"><div class="cn-sec-h"><h3>Offices</h3><span class="acts"></span></div>${offs.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Office / entity</th><th>Location</th><th>Policy</th><th>Currencies</th><th class="r">Min. premium</th><th class="r">Deductible</th><th class="r">Users</th><th class="km"></th></tr></thead><tbody>${offs.map(o => { const po = polOf(o.policy_id), cur = po ? po.currency : allowedCurs(o.id, null, c.id)[0];
              return `<tr data-o="${o.id}"><td><b>${esc(o.name)}</b>${o.subcategory ? ' ' + chip('neutral', o.subcategory) : ''}${o.active ? '' : ' ' + chip('declined', 'Inactive')}<br><span class="xs muted">${esc(KIND[o.kind] || o.kind)}</span></td><td>${esc(o.location || '')}<br><span class="xs muted">${esc(cName(o.country))}</span></td><td class="xs">${po ? esc(polLabel(po)) : '<span class="muted">-</span>'}</td><td class="xs">${(o.currencies || []).length ? '<b>' + esc(o.currencies.join(' · ')) + '</b>' : '<span class="muted">' + esc(allowedCurs(o.id, o.policy_id, c.id).join(' · ')) + '</span>'}</td>
                <td class="r num">${o.min_premium != null ? '<b>' + esc(amt(o.min_premium, cur)) + '</b>' : '<span class="muted">' + esc(po ? amt(po.min_premium, cur) : '-') + '</span>'}</td><td class="r num">${o.deductible != null ? '<b>' + esc(amt(o.deductible, cur)) + '</b>' : '<span class="muted">' + esc(po ? amt(po.deductible, cur) : '-') + '</span>'}</td><td class="r">${users.filter(p => p.office_id === o.id).length}</td><td class="km"></td></tr>`; }).join('')}</tbody></table></div>` : '<p class="small muted" style="margin:0">No offices.</p>'}</div>`);
          os.querySelector('.acts').appendChild(btn('+ Add office', 'ghost', () => officeDialog(null, null, c.id)));
          os.querySelectorAll('tr[data-o]').forEach(tr => { const o = ofcOf(Number(tr.dataset.o)); tr.querySelector('.km').appendChild(kebab(() => [
            ['Edit office', () => officeDialog(o, o.policy_id, c.id)], ['+ Add user to this office', () => addUserDialog({ customer_id: c.id, office_id: o.id })],
            [o.active ? 'Deactivate' : 'Activate', async () => { await sb.from('offices').update({ active: !o.active }).eq('id', o.id); await loadAll(); render(); }], '-',
            ['Remove office', () => delRow('offices', o.id, 'Remove ' + o.name + '?', 'Users of this office must choose a new one. Past shipments keep their figures.'), 'danger']])); });
          b.appendChild(os);
          // users
          const uw = FC.el(`<div class="cn-sec"><div class="cn-sec-h"><h3>Users</h3><span class="acts"></span></div>${us.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>User</th><th>Office</th><th>Role</th><th>Status</th><th>Last login</th><th class="km"></th></tr></thead><tbody>${us.map(userRow).join('')}</tbody></table></div>` : '<p class="small muted" style="margin:0">No users yet.</p>'}</div>`);
          uw.querySelector('.acts').appendChild(btn('+ Add user', 'ghost', () => addUserDialog({ customer_id: c.id })));
          uw.querySelectorAll('tr[data-u]').forEach(tr => { const p = S.profiles[tr.dataset.u]; tr.querySelector('.km').appendChild(kebab(() => userMenu(p))); });
          b.appendChild(uw);
        }
        list.appendChild(node);
      });
      if(loose.length && (!q || loose.some(p => [p.full_name, p.email, p.company].join(' ').toLowerCase().includes(q)))){
        const open = openCust.has(0);
        const node = FC.el(`<section class="card cnode${open ? ' open' : ''}"><div class="cnode-head"><span style="width:18px"></span><button type="button" class="cn-tog" aria-expanded="${open}"><span class="caret">▸</span><b>One-off clients without a customer</b></button><span class="cn-tags">${chip('neutral', 'One-off')} <span class="xs muted">general one-off pool</span></span><span class="cn-count xs muted">${loose.length} user${loose.length === 1 ? '' : 's'}</span><span class="km"></span></div><div class="cnode-body"></div></section>`);
        node.querySelector('.cn-tog').addEventListener('click', () => { openCust.has(0) ? openCust.delete(0) : openCust.add(0); paint(); });
        if(open){ const ws = loose.filter(p => !q || [p.full_name, p.email, p.company].join(' ').toLowerCase().includes(q));
          const uw = FC.el(`<div class="cn-sec"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>User</th><th>Company</th><th>Role</th><th>Status</th><th>Last login</th><th class="km"></th></tr></thead><tbody>${ws.map(p => userRow(p, true)).join('')}</tbody></table></div></div>`);
          uw.querySelectorAll('tr[data-u]').forEach(tr => { const p = S.profiles[tr.dataset.u]; tr.querySelector('.km').appendChild(kebab(() => userMenu(p))); });
          node.querySelector('.cnode-body').appendChild(uw); }
        list.appendChild(node);
      }
      paintBulk();
    };
    bar.querySelector('input').addEventListener('input', e => { treeQ = e.target.value; paint(); });
    paint();
  }
  function customerMenu(c){
    return [
      ['Edit customer', () => customerDialog(c)], ['+ Add policy', () => policyDialog(null, c.id)], ['+ Add office', () => officeDialog(null, null, c.id)], ['+ Add user', () => addUserDialog({ customer_id: c.id })],
      '-', ['Rates of this customer', () => goScope('rates', { t:'customer', id: c.id })], ['Default clauses', () => goScope('clauses', { t:'customer', id: c.id })],
      ['Copy configuration to…', () => copyDialog(['schedules','cargo','zones','factors','map','war','clauses'], { t:'customer', id: c.id })],
      [c.active ? 'Deactivate' : 'Activate', async () => { await sb.from('customers').update({ active: !c.active }).eq('id', c.id); await loadAll(); render(); }],
      '-', ['Delete customer', () => delRow('customers', c.id, 'Delete ' + c.name + '?', 'Its policies, offices and own configuration are deleted. Users keep their login but lose the assignment; past shipments keep their figures.'), 'danger']];
  }
  function policyMenu(po){
    return [
      ['Edit policy', () => policyDialog(po, po.customer_id)], ['Policy years & certificate numbering', () => { const host = FC.el('<div></div>'); paintPolicyYears(host, po); FC.dialog({ title:'Policy years · ' + polLabel(po), wide:true, body: host, actions:[{ label:'Close', kind:'primary', value:true }] }).then(async () => { await loadAll(); render(); }); }],
      ['+ Add office', () => officeDialog(null, po.id, po.customer_id)],
      ['Rates of this policy', () => goScope('rates', { t:'policy', id: po.id })], ['Default clauses', () => goScope('clauses', { t:'policy', id: po.id })],
      ['Copy terms to…', () => copyDialog(['schedules','cargo','zones','factors','map','war','clauses'], { t:'policy', id: po.id })],
      ['Copy terms from…', () => copyTermsDialog(po)], '-',
      ['Delete policy', () => delRow('policies', po.id, 'Delete ' + po.name + '?', 'Its own configuration is deleted; offices keep the customer. Past shipments keep their figures.'), 'danger']];
  }
  function userMenu(p){
    if(!p) return [];
    const self = p.id === me().id;
    return [
      ['Edit user', () => editCustomer(p)],
      !p.approved && !p.rejected ? ['Approve & set up…', () => approveDialog(p)] : null,
      self ? null : p.is_active === false ? ['Enable user', () => manageUser('enable', p)] : ['Disable user', () => manageUser('disable', p)],
      ['Send password link', async () => { const { error } = await sb.auth.resetPasswordForEmail(p.email, { redirectTo: location.origin + location.pathname.replace(/[^/]*$/, '') + 'index.html' }); toast(error ? error.message : 'Password link sent to ' + p.email + '.', error ? 'error' : undefined); }],
      self ? null : '-', self ? null : ['Delete user…', () => manageUser('delete', p), 'danger']];
  }
  // Edge Function call with its own error text (supabase-js only says "non-2xx" otherwise)
  async function invokeFn(name, body){
    try{
      const { data, error } = await sb.functions.invoke(name, { body });
      if(error){ let msg = error.message; try{ const j = error.context && error.context.json ? await error.context.json() : null; if(j && j.error) msg = j.error; }catch(e){} return { error: msg }; }
      if(data && data.error) return { error: data.error };
      return { data };
    }catch(e){ return { error: String(e.message || e) }; }
  }
  // disable / enable / delete through the Edge Function admin-manage-user (service role stays on the server)
  async function manageUser(action, p, quiet){
    if(action === 'delete' && !quiet){
      const ok = await FC.dialog({ title:'Delete ' + (p.full_name || p.email) + '?', body:`<p style="margin-top:0">The login is removed and the personal data is anonymised. Shipments, quotations and the change log stay for the record. You receive a confirmation e-mail at <b>${esc(me().email)}</b>.</p><div class="field"><label for="duTxt">Type DELETE to confirm</label><input id="duTxt" autocomplete="off"></div><div class="err-msg" id="duErr"></div>`,
        actions:[{ label:'Cancel', kind:'ghost', value:false }, { label:'Delete user', kind:'danger', onClick: async (c, box) => box.querySelector('#duTxt').value.trim().toUpperCase() === 'DELETE' ? true : void (box.querySelector('#duErr').textContent = 'Please type DELETE.') }] });
      if(!ok) return false;
    }
    if(action === 'disable' && !quiet && !(await FC.confirm('Disable ' + (p.full_name || p.email) + '?', 'The user can no longer log in. History and settings stay; you can enable the user again at any time.', 'Disable', 'danger'))) return false;
    const { error: msg } = await invokeFn('admin-manage-user', { action, user_id: p.id });
    if(msg){ toast('Could not ' + action + ': ' + msg + (/not found|Failed to send|fetch/i.test(msg) ? ' - is the Edge Function admin-manage-user deployed?' : ''), 'error'); return false; }
    if(!quiet){ toast(action === 'delete' ? 'User deleted. A confirmation was sent to ' + me().email + '.' : action === 'disable' ? 'User disabled.' : 'User enabled.'); await loadAll(); render(); }
    return true;
  }
  // + Add user: created confirmed and active at once, assigned to customer / office, cover type and role
  function addUserDialog(pre){
    const body = FC.el(`<div><div class="grid2">
        <div class="field"><label for="auMail">E-mail</label><input id="auMail" type="email" maxlength="200" autocomplete="off"></div>
        <div class="field"><label for="auName">Full name</label><input id="auName" maxlength="150"></div>
        <div class="field"><label for="auCo">Company</label><input id="auCo" maxlength="150"></div>
        <div class="field"><label for="auPhone">Phone</label><input id="auPhone" maxlength="40"></div>
        <div class="field"><label for="auCust">Customer</label><select id="auCust"><option value="">- none (one-off client) -</option>${S.customers.map(c => `<option value="${c.id}" ${pre.customer_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
        <div class="field"><label for="auOff">Office</label><select id="auOff"></select></div>
        <div class="field"><label for="auCover">Cover type</label><select id="auCover"><option value="">As the customer</option>${Object.entries(COVER_T).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div>
        ${discModeHtml(null)}

        <div class="field"><label for="auPw">Password <span class="muted">(optional)</span></label><input id="auPw" type="text" maxlength="72" autocomplete="off" placeholder="empty = the user sets it via link"></div></div>
      ${accessHtml(null)}
      <label class="switch"><input type="checkbox" id="auLink" checked><span><b>Send a “set your password” e-mail</b><span>The account is confirmed and active at once - no verification e-mail.</span></span></label>
      <div class="err-msg" id="auErr"></div></div>`);
    const cs = body.querySelector('#auCust'), os = body.querySelector('#auOff');
    const paintOff = () => { const cid = Number(cs.value) || null; os.innerHTML = '<option value="">- no office -</option>' + S.offices.filter(o => o.customer_id === cid && o.active).map(o => `<option value="${o.id}" ${pre.office_id === o.id ? 'selected' : ''}>${esc(o.name)}${o.location ? ' - ' + esc(o.location) : ''}</option>`).join('');
      if(!body.querySelector('#auCo').value && cid) body.querySelector('#auCo').value = custOf(cid).name; };
    cs.addEventListener('change', paintOff); paintOff();
    const repaintDisc = wireDiscMode(body, () => custOf(Number(cs.value))); cs.addEventListener('change', repaintDisc);
    wireAccess(body);
    spotClient(cs, () => body.querySelector('#auCo').value.trim(), (id, off) => { pre.office_id = off; paintOff(); });
    FC.dialog({ title:'Add user', wide:true, body, actions:[{ label:'Cancel', kind:'ghost', value:null }, { label:'Create user', kind:'primary', onClick: async () => {
      const v = id => body.querySelector(id).value.trim(), err = t => { body.querySelector('#auErr').textContent = t; };
      if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v('#auMail'))) return err('Please enter a valid e-mail address.');
      if(v('#auName').length < 2) return err("Please enter the user's name.");
      if(v('#auPw') && v('#auPw').length < 10) return err('The password needs at least 10 characters.');
      const dm = readDiscMode(body); if(dm.error) return err(dm.error);
      const ac = readAccess(body); if(ac.error) return err(ac.error);
      const payload = { action:'create', email: v('#auMail'), full_name: v('#auName'), company: v('#auCo'), phone: v('#auPhone'), customer_id: Number(v('#auCust')) || null, office_id: Number(v('#auOff')) || null,
        cover_type: v('#auCover') || null, is_admin: ac.is_admin, user_group_id: ac.user_group_id, staff_roles: ac.staff_roles, department_id: ac.department_id, insurer_id: ac.insurer_id, discount_mode: dm.discount_mode, special_discount_pct: dm.special_discount_pct, password: v('#auPw') || undefined, send_link: body.querySelector('#auLink').checked };
      const { error: msg } = await invokeFn('admin-manage-user', payload);
      if(msg) return err('Could not create the user: ' + msg + (/Failed to send|fetch|not found/i.test(msg) ? ' - is the Edge Function admin-manage-user deployed?' : ''));
      toast('User created and active' + (payload.send_link ? ' - password link sent.' : '.')); await loadAll(); render(); return true;
    } }] });
  }
  // approve a registration and set it up in one step: customer (existing or new), office, cover type, currencies, rate profile, clauses
  // user group -> (staff roles | insurer) -> department
  const accessHtml = p => { const ug = S.userGroups.find(g => g.id === (p && p.user_group_id)) || S.userGroups.find(g => g.code === (p && p.is_admin ? 'staff' : 'clients')) || {};
    return `<div class="grid2 acc-blk"><div class="field"><label for="acUG">User group</label><select id="acUG" ${isStaffAdmin() ? '' : 'disabled'}>${S.userGroups.filter(g => g.active || g.id === ug.id).map(g => `<option value="${g.id}" data-kind="${g.kind}" ${g.id === ug.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></div>
      <div class="field"><label for="acDep">Department</label><select id="acDep"><option value="">-</option>${S.departments.filter(d => d.active || (p && d.id === p.department_id)).map(d => `<option value="${d.id}" ${p && p.department_id === d.id ? 'selected' : ''}>${esc(d.name)}${d.customer_id ? ' (' + esc((custOf(d.customer_id) || {}).name || '') + ')' : ''}</option>`).join('')}</select></div>
      <div class="field" id="acRolesF"><label>Staff roles</label><div class="cur-boxes" id="acRoles">${[['admin','Admins'],['placing','Placing'],['claims','Claims']].map(([k, l]) => `<label><input type="checkbox" value="${k}" ${(p && (p.staff_roles || []).includes(k)) || (!p || !(p.staff_roles || []).length) ? 'checked' : ''} ${isStaffAdmin() ? '' : 'disabled'}> ${l}</label>`).join('')}</div><span class="hint">Admins: configuration, users, rates, zones, clauses. Placing: requests, quotations, clients, policies. Claims: claims.</span></div>
      <div class="field" id="acInsF"><label for="acIns">Insurer</label><select id="acIns"><option value="">-</option>${S.insurers.map(i => `<option value="${i.id}" ${p && p.insurer_id === i.id ? 'selected' : ''}>${esc(i.name)}</option>`).join('')}</select><span class="hint">The insurer dashboard shows only cases placed with this insurer.</span></div></div>`; };
  const wireAccess = box => { const u = box.querySelector('#acUG'); const paint = () => { const k = (u.selectedOptions[0] || {}).dataset ? u.selectedOptions[0].dataset.kind : 'client'; box.querySelector('#acRolesF').hidden = k !== 'staff'; box.querySelector('#acInsF').hidden = k !== 'insurer'; }; u.addEventListener('change', paint); paint(); };
  const readAccess = box => { const u = box.querySelector('#acUG'), k = u.selectedOptions[0] ? u.selectedOptions[0].dataset.kind : 'client';
    const rolesSel = Array.from(box.querySelectorAll('#acRoles input:checked')).map(i => i.value);
    if(k === 'staff' && !rolesSel.length) return { error:'Tick at least one staff role.' };
    if(k === 'insurer' && !box.querySelector('#acIns').value) return { error:'Choose the insurer of this user.' };
    return { user_group_id: Number(u.value) || null, is_admin: k === 'staff', staff_roles: k === 'staff' ? rolesSel : [], department_id: Number(box.querySelector('#acDep').value) || null, insurer_id: k === 'insurer' ? Number(box.querySelector('#acIns').value) : null }; };
  // + Add new client on the spot: opens the client form, then selects the new client in the calling form
  const spotClient = (sel, nameFn, onDone) => {
    const b = FC.el('<button type="button" class="linkbtn spot-add">+ Add new client on the spot</button>');
    b.addEventListener('click', () => customerDialog(null, null, { name: nameFn ? nameFn() : '', onSaved: (id, off) => {
      const c = custOf(id), o = document.createElement('option'); o.value = id; o.textContent = c ? c.name : 'New client'; sel.appendChild(o);
      sel.value = String(id); sel.dispatchEvent(new Event('change')); if(onDone) onDone(id, off); } }));
    sel.insertAdjacentElement('afterend', b); return b;
  };
  // approve a registration: the company was typed freely by the user (no list of clients is ever shown to them);
  // staff attach it to an existing client or create the client on the spot
  function approveDialog(p){
    const typed = p.requested_company_name || p.company || '', dc = domainCust(p.email);
    const guess = dc || S.customers.find(c => typed && c.name.toLowerCase() === typed.trim().toLowerCase()) || null;
    const body = FC.el(`<div><div class="notice" style="margin:0 0 12px"><b>Company typed at registration</b>${esc(typed || '(none)')}<br><span class="xs muted">${esc(p.full_name || '')}, ${esc(p.email)}${dc ? ' - e-mail domain matches ' + esc(dc.name) : ''}</span></div><div class="grid2">
        <div class="field"><label for="apCust">Client</label><select id="apCust"><option value="">One-off client without a client file (general one-off pool)</option>${S.customers.map(c => `<option value="${c.id}" ${guess && guess.id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
        <div class="field"><label for="apOff">Office</label><select id="apOff"></select></div>
        <div class="field"><label for="apCover">Cover type</label><select id="apCover">${Object.entries(COVER_T).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div>
        ${discModeHtml(null)}</div>
      <div class="err-msg" id="apErr"></div></div>`);
    const cs = body.querySelector('#apCust'), os = body.querySelector('#apOff'), cv = body.querySelector('#apCover');
    let pickOff = null;
    const paint = () => { const c = custOf(Number(cs.value));
      os.innerHTML = '<option value="">- no office -</option>' + (c ? S.offices.filter(o => o.customer_id === c.id && o.active).map(o => `<option value="${o.id}" ${o.id === pickOff ? 'selected' : ''}>${esc(o.name)}${o.location ? ' - ' + esc(o.location) : ''}</option>`).join('') : '');
      os.disabled = !c; cv.value = c ? c.cover_type : 'one_off'; };
    cs.addEventListener('change', paint); paint();
    const repaintDisc = wireDiscMode(body, () => custOf(Number(cs.value))); cs.addEventListener('change', repaintDisc);
    spotClient(cs, () => typed, (id, off) => { pickOff = off; paint(); });
    FC.dialog({ title:'Approve and set up', wide:true, body, actions:[{ label:'Cancel', kind:'ghost', value:null }, { label:'Approve', kind:'ok', onClick: async () => {
      const dm = readDiscMode(body); if(dm.error) return void (body.querySelector('#apErr').textContent = dm.error);
      const cid = Number(cs.value) || null, c = custOf(cid);
      const ok = await upd(p.id, Object.assign({ approved:true, rejected:false, is_active:true, customer_id: cid, group_id: c ? c.group_id : null, company: c ? c.name : p.company, office_id: Number(os.value) || null, cover_type: c && cv.value === c.cover_type ? null : cv.value }, dm));
      return ok ? true : undefined;
    } }] });
  }
  async function renderUsers(body){
    await renderPending(body);
    const P = S.profiles, count = {}; S.rows.forEach(r => { const c = count[r.user_id] = count[r.user_id] || { i:0, q:0, b:0 }; c.i++; if(r.quote_requested_at) c.q++; if(stg(r) === 'certificate') c.b++; });
    const rows = liveUsers();
    const L = selList({ host: body, rows, id: p => p.id, search: p => [p.company, p.full_name, p.email, p.country, (userCust(p) || {}).name, (ofcOf(p.office_id) || {}).name].join(' '), placeholder:'Search company, name, e-mail, customer',
      toolbar: tb => tb.appendChild(btn('+ Add user', 'primary', () => addUserDialog({}))),
      cols:[ { l:'User', html: p => `<b>${esc(p.full_name || '-')}</b>${p.deletion_requested_at ? ' ' + chip('declined', 'Deletion requested') : ''}<br><span class="xs muted">${esc(p.email)}</span>` },
        { l:'Customer / office', html: p => { const c = userCust(p), o = ofcOf(p.office_id); return c ? esc(c.name) + (o ? '<br><span class="xs muted">' + esc(o.name) + '</span>' : '') : '<span class="muted">' + esc(p.company || '-') + '</span>'; } },
        { l:'Cover', html: p => esc(COVER_T[coverOfUser(p)]) + (p.cover_type ? '' : '<br><span class="xs muted">as customer</span>') },
        { l:'Role', html: p => p.is_admin ? 'Staff' : 'Client' }, { l:'Status', html: userStatus },
        { l:'Last login', cls:'xs', html: p => p.last_login_at ? esc(FC.ago(p.last_login_at)) : '<span class="muted">never</span>' },
        { l:'Indications', cls:'r', html: p => String((count[p.id] || {}).i || 0) }, { l:'Bound', cls:'r', html: p => String((count[p.id] || {}).b || 0) },
        { l:'Discount', cls:'r', html: p => esc(effDisc(p)) + ' %<br><span class="xs muted">' + esc(discLabel(p)) + '</span>' } ],
      menu: userMenu,
      bulk:[ ['Enable', async rs => { for(const p of rs) if(p.id !== me().id) await manageUser('enable', p, true); toast('Enabled.'); await loadAll(); render(); }],
        ['Disable', async rs => { if(!(await FC.confirm('Disable ' + rs.length + ' user(s)?', 'They can no longer log in.', 'Disable', 'danger'))) return; for(const p of rs) if(p.id !== me().id) await manageUser('disable', p, true); toast('Disabled.'); await loadAll(); render(); }],
        ['Export CSV', rs => csvSave('FREIGHTCON_users', ['Name','E-mail','Company','Customer','Office','Cover','Role','Status','Last login'], rs.map(p => [p.full_name, p.email, p.company, (userCust(p) || {}).name, (ofcOf(p.office_id) || {}).name, COVER_T[coverOfUser(p)], p.is_admin ? 'Staff' : 'Client', p.is_active === false ? 'Disabled' : p.approved ? 'Active' : 'Waiting', p.last_login_at || '']))],
        ['Delete', async rs => { const ok = await FC.confirm('Delete ' + rs.length + ' user(s)?', 'Logins are removed and personal data anonymised; you receive one confirmation e-mail per user.', 'Delete', 'danger'); if(!ok) return; for(const p of rs) if(p.id !== me().id) await manageUser('delete', p, true); toast('Deleted. Confirmations were sent to ' + me().email + '.'); await loadAll(); render(); }, 'danger'] ] });
    return L;
  }
  // ---------------- user groups, departments, permission matrix (staff admins) ----------------
  const FEATURES = [['new_request','New shipment / requests'],['my_shipments','My shipments'],['bulk_upload','Bulk upload'],['claims','Claims'],['policy_clauses','View active policy clauses'],
    ['zone_map','View zones'],['rates','View rates (reserved)'],['fdf_certificate','Certificate .fdf'],['direct_certificate','Direct certificate issuance'],['insurer_dashboard','Insurer dashboard']];
  const UG_KIND = { staff:'Staff', client:'Clients', insurer:'Insurers' };
  async function impactText(kind, id){ const { data } = await sb.rpc('admin_impact', { p_kind: kind, p_id: id }); return data ? Object.entries(data).map(([k, v]) => v + ' ' + k).join(', ') : ''; }
  function renderAccess(body){
    body.appendChild(FC.el('<h2 style="margin:4px 0 8px">User groups</h2>'));
    selList({ host: body, rows: S.userGroups, toolbar: tb => tb.appendChild(btn('+ Add user group', 'primary', () => userGroupDialog(null))),
      cols:[ { l:'User group', html: g => `<b>${esc(g.name)}</b> <span class="xs muted">${esc(g.code)}</span>${g.active ? '' : ' ' + chip('declined', 'Disabled')}` }, { l:'Kind', html: g => esc(UG_KIND[g.kind] || g.kind) },
        { l:'Users', cls:'r', html: g => String(Object.values(S.profiles).filter(p => p.user_group_id === g.id && !p.deleted_at).length) } ],
      menu: g => [['Edit', () => userGroupDialog(g)], [g.active ? 'Disable' : 'Enable', async () => { if(g.active && !(await seriousConfirm('Disable ' + g.name + '?', 'Affects ' + esc(await impactText('user_group', g.id)) + '. They keep their login; the group can no longer be assigned.', [['Disable', true]]))) return; await sb.from('user_groups').update({ active: !g.active }).eq('id', g.id); await loadAll(); render(); }],
        ['code'].includes('x') ? null : '-', ['Delete', async () => { if(['staff','clients','insurers'].includes(g.code)) return toast('The three default groups can be disabled, not deleted.', 'error');
          if(!(await seriousConfirm('Delete the user group ' + g.name + '?', 'Affects ' + esc(await impactText('user_group', g.id)) + '. Their users lose the group assignment.', [['Delete for good', true]]))) return;
          const { error } = await sb.from('user_groups').delete().eq('id', g.id); if(error) return toast(error.message, 'error'); await loadAll(); render(); }, 'danger']] });
    body.appendChild(FC.el('<h2 style="margin:26px 0 8px">Departments</h2>'));
    selList({ host: body, rows: S.departments, toolbar: tb => tb.appendChild(btn('+ Add department', 'primary', () => deptDialog(null))),
      cols:[ { l:'Department', html: d => `<b>${esc(d.name)}</b>${d.active ? '' : ' ' + chip('declined', 'Disabled')}` }, { l:'For', html: d => d.customer_id ? esc((custOf(d.customer_id) || {}).name || '') : 'all companies' },
        { l:'Users', cls:'r', html: d => String(Object.values(S.profiles).filter(p => p.department_id === d.id && !p.deleted_at).length) } ],
      menu: d => [['Edit', () => deptDialog(d)], [d.active ? 'Disable' : 'Enable', async () => { await sb.from('departments').update({ active: !d.active }).eq('id', d.id); await loadAll(); render(); }], '-',
        ['Delete', async () => { if(!(await seriousConfirm('Delete the department ' + d.name + '?', 'Affects ' + esc(await impactText('department', d.id)) + '.', [['Delete for good', true]]))) return; const { error } = await sb.from('departments').delete().eq('id', d.id); if(error) return toast(error.message, 'error'); await loadAll(); render(); }, 'danger']] });
    // permission matrix
    body.appendChild(FC.el(`<h2 style="margin:26px 0 4px">Dashboard &amp; feature access</h2><p class="small muted" style="margin:0 0 10px">Company overrides company group, which overrides user group. “Inherit” uses the next level (default: clients see requests, shipments, uploads and claims; clauses, zones and rates only if allowed here; certificates also need the switches on the client).</p>`));
    const subj = FC.el(`<div class="toolbar"><select class="input" id="pmS" style="max-width:420px" aria-label="Who"><optgroup label="User groups">${S.userGroups.map(g => `<option value="user_group:${g.id}">${esc(g.name)}</option>`).join('')}</optgroup><optgroup label="Company groups">${S.groups.map(g => `<option value="company_group:${g.id}">${esc(g.name)}</option>`).join('')}</optgroup><optgroup label="Companies">${S.customers.map(c => `<option value="company:${c.id}">${esc(c.name)}</option>`).join('')}</optgroup></select><span style="flex:1"></span></div>`);
    body.appendChild(subj);
    const mx = FC.el('<div class="card card-pad" style="max-width:640px"></div>'); body.appendChild(mx);
    const paintM = () => { const [t, id] = subj.querySelector('#pmS').value.split(':');
      mx.innerHTML = `<table class="tbl"><thead><tr><th>Feature</th><th>Access</th></tr></thead><tbody>${FEATURES.map(([k, l]) => { const p = S.perms.find(x => x.subject_type === t && x.subject_id === Number(id) && x.feature === k); const v = p ? (p.allowed ? 'allow' : 'deny') : '';
        return `<tr><td>${esc(l)}</td><td><select data-f="${k}"><option value="" ${!v ? 'selected' : ''}>Inherit</option><option value="allow" ${v === 'allow' ? 'selected' : ''}>Allow</option><option value="deny" ${v === 'deny' ? 'selected' : ''}>Deny</option></select></td></tr>`; }).join('')}</tbody></table><div class="toolbar" style="margin-top:10px"></div>`;
      mx.querySelector('.toolbar').appendChild(btn('Save access', 'primary', async b => { busy(b, true);
        const ups = [], dels = []; mx.querySelectorAll('[data-f]').forEach(sl => { if(sl.value) ups.push({ subject_type: t, subject_id: Number(id), feature: sl.dataset.f, allowed: sl.value === 'allow', updated_at: new Date().toISOString() }); else dels.push(sl.dataset.f); });
        let error = null; if(ups.length) ({ error } = await sb.from('role_dashboard_permissions').upsert(ups, { onConflict: 'subject_type,subject_id,feature' }));
        if(!error && dels.length) ({ error } = await sb.from('role_dashboard_permissions').delete().eq('subject_type', t).eq('subject_id', Number(id)).in('feature', dels));
        busy(b, false); if(error) return toast(error.message, 'error'); toast('Access saved.'); await loadAll(); paintM(); })); };
    subj.querySelector('#pmS').addEventListener('change', paintM); paintM();
  }
  function userGroupDialog(g){
    const body = FC.el(`<div><div class="grid2"><div class="field"><label for="ugN">Name</label><input id="ugN" maxlength="120" value="${esc(g ? g.name : '')}"></div>
      <div class="field"><label for="ugC">Code</label><input id="ugC" maxlength="30" value="${esc(g ? g.code : '')}" ${g ? 'disabled' : ''} placeholder="e.g. surveyors"></div>
      <div class="field"><label for="ugK">Kind</label><select id="ugK">${Object.entries(UG_KIND).map(([k, l]) => `<option value="${k}" ${g && g.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select><span class="hint">Staff see the Internal area; insurers see the insurer dashboard; clients the portal.</span></div>
      <div class="field"><label for="ugS">Sort</label><input id="ugS" inputmode="numeric" value="${esc(g ? g.sort : 100)}"></div></div><div class="err-msg" id="ugE"></div></div>`);
    FC.dialog({ title: g ? g.name : 'New user group', body, actions:[{ label:'Cancel', kind:'ghost', value:null }, { label:'Save', kind:'primary', onClick: async () => {
      const v = id => body.querySelector(id).value.trim(); if(!v('#ugN')) return void (body.querySelector('#ugE').textContent = 'Name required.');
      const code = g ? g.code : v('#ugC').toLowerCase(); if(!/^[a-z0-9_]{2,30}$/.test(code)) return void (body.querySelector('#ugE').textContent = 'Code: 2-30 lower-case letters, digits or _.');
      if(g && g.kind !== v('#ugK') && !(await seriousConfirm('Change the kind of ' + g.name + '?', 'Affects ' + esc(await impactText('user_group', g.id)) + '. Their access changes accordingly.', [['Change', true]]))) return;
      return (await saveRow('user_groups', { name: v('#ugN'), code, kind: v('#ugK'), sort: Number(v('#ugS')) || 100 }, g && g.id)) ? true : undefined; } }] });
  }
  function deptDialog(d){
    const body = FC.el(`<div><div class="grid2"><div class="field"><label for="dpN">Name</label><input id="dpN" maxlength="120" value="${esc(d ? d.name : '')}"></div>
      <div class="field"><label for="dpC">Company</label><select id="dpC"><option value="">All companies</option>${S.customers.map(c => `<option value="${c.id}" ${d && d.customer_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div></div><div class="err-msg" id="dpE"></div></div>`);
    FC.dialog({ title: d ? d.name : 'New department', body, actions:[{ label:'Cancel', kind:'ghost', value:null }, { label:'Save', kind:'primary', onClick: async () => {
      const n = body.querySelector('#dpN').value.trim(); if(!n) return void (body.querySelector('#dpE').textContent = 'Name required.');
      return (await saveRow('departments', { name: n, customer_id: Number(body.querySelector('#dpC').value) || null }, d && d.id)) ? true : undefined; } }] });
  }
  // ---------------- client groups ----------------
  const RULE_DEF = { icc_c_pct:50, interest_pct:40, deck_loading_pct:50, air_war_permille:0.5, air_freight:{ used_pct:50, cars_pct:50, household_permille:10 }, air_charter:{ used_pct:25, cars_pct:25, household_permille:null } };
  const KIND = { office:'Office', warehouse:'Warehouse', agent:'Approved agent' };
  function renderGroups(body){
    body.appendChild(FC.el(`<p class="small muted" style="margin:0 0 14px">Groups bundle customers (e.g. a forwarding network). Currencies set on a group apply to its customers unless the customer, policy or office restricts them further.</p>`));
    selList({ host: body, rows: S.groups, search: g => g.name, toolbar: tb => tb.appendChild(btn('+ Add group', 'primary', () => groupDialog(null))),
      cols:[ { l:'Group', html: g => `<b>${esc(g.name)}</b>${g.notes ? '<br><span class="xs muted">' + esc(g.notes) + '</span>' : ''}` }, { l:'Customers', html: g => esc(S.customers.filter(c => c.group_id === g.id).map(c => c.name).join(', ') || '-') },
        { l:'Currencies', html: g => esc((g.currencies || []).join(' · ') || 'all') }, { l:'Premium for clients', html: g => g.show_premium ? 'shown' : chip('pending', 'request only') }, { l:'E-mail domains', html: g => esc((g.email_domains || []).map(d => '@' + d).join(' ')) } ],
      menu: g => [['Edit group', () => groupDialog(g)], [g.active === false ? 'Enable' : 'Disable', async () => { if(g.active !== false && !(await seriousConfirm('Disable ' + g.name + '?', 'Affected: ' + esc(await impactText('company_group', g.id)) + '. New companies can no longer be added to it.', [['Disable', true]]))) return; await sb.from('client_groups').update({ active: g.active === false }).eq('id', g.id); await loadAll(); render(); }], ['+ Add customer to this group', () => customerDialog(null, g.id)], '-', ['Delete group', () => delRow('client_groups', g.id, 'Delete the group ' + g.name + '?', 'Customers stay, without a group.'), 'danger']],
      bulk:[ ['Delete', async rs => { const imps = (await Promise.all(rs.map(g => impactText('company_group', g.id)))).join('; '); if(!(await seriousConfirm('Delete ' + rs.length + ' company group(s)?', 'Affected: ' + esc(imps) + '. Companies stay, without a group.', [['Delete for good', true]]))) return; const { error } = await sb.from('client_groups').delete().in('id', rs.map(g => g.id)); if(error) return toast(error.message, 'error'); await loadAll(); render(); }, 'danger'] ] });
  }
  async function saveRow(table, row, id){
    const r = id ? await sb.from(table).update(row).eq('id', id).select() : await sb.from(table).insert(row).select();
    if(r.error){ toast('Could not save: ' + r.error.message, 'error'); return false; }
    toast('Saved.'); await loadAll(); render(); return (r.data && r.data[0]) || true;
  }
  async function delRow(table, id, title, text){
    const kind = { customers:'company', client_groups:'company_group' }[table];
    if(kind){
      const imp = await impactText(kind, id);
      if(!(await seriousConfirm(title, esc(text) + (imp ? '<br><b>Affected:</b> ' + esc(imp) + '.' : ''), [['Delete for good', true]]))) return false;
      const { error } = await sb.from(table).delete().eq('id', id);
      if(error){ toast('Could not delete: ' + error.message, 'error'); return false; }
      toast('Deleted.'); await loadAll(); render(); return true;
    }
    if(!(await FC.confirm(title, text, 'Delete', 'danger'))) return false;
    const { error } = await sb.from(table).delete().eq('id', id);
    if(error){ toast('Could not delete: ' + error.message, 'error'); return false; }
    toast('Deleted.'); await loadAll(); render(); return true;
  }
  const numOrNull = v => { const t = String(v == null ? '' : v).trim(); return t === '' ? null : FC.parseNum(t); };
  function groupDialog(g){
    const body = FC.el(`<div><div class="grid2">
        <div class="field"><label for="gdName">Name</label><input id="gdName" maxlength="150" value="${esc(g ? g.name : '')}"></div>
        <div class="field"><label for="gdKind">Type</label><select id="gdKind"><option value="spot" ${g && g.kind === 'spot' ? 'selected' : ''}>Spot / one-off clients</option><option value="open_cover" ${!g || g.kind === 'open_cover' ? 'selected' : ''}>Open cover clients</option></select></div>
        <div class="field"><label for="gdDom">E-mail domains <span class="muted">(comma separated, e.g. bertling.com)</span></label><input id="gdDom" value="${esc(g ? (g.email_domains || []).join(', ') : '')}"></div>
        <div class="field"><label for="gdSort">Sort</label><input id="gdSort" inputmode="numeric" value="${esc(g ? g.sort : 100)}"></div>
        <div class="field"><label>Allowed currencies</label>${curBoxes('gdCurs', g ? g.currencies : [])}</div></div>
      <label class="switch"><input type="checkbox" id="gdShow" ${!g || g.show_premium ? 'checked' : ''}><span><b>Clients see the indicative premium</b><span>Off: the portal only takes declarations and requests. Set by staff only; a client or policy can be set differently by staff.</span></span></label>
      <div class="field" style="margin-top:12px"><label for="gdNotes">Internal notes</label><textarea id="gdNotes" rows="2" maxlength="1000">${esc(g ? g.notes || '' : '')}</textarea></div>
      <div class="err-msg" id="gdErr"></div></div>`);
    const actions = [{ label:'Cancel', kind:'ghost', value:null }];
    if(g) actions.unshift({ label:'Delete group', kind:'danger', onClick: async () => (await delRow('client_groups', g.id, 'Delete the group ' + g.name + '?', 'Customers stay, without a group.')) ? true : undefined });
    actions.push({ label:'Save', kind:'primary', onClick: async () => {
      const name = body.querySelector('#gdName').value.trim(); if(!name){ body.querySelector('#gdErr').textContent = 'Name required.'; return; }
      const doms = body.querySelector('#gdDom').value.split(/[,;\s]+/).map(x => x.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
      if(doms.some(d => !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d))){ body.querySelector('#gdErr').textContent = 'Please enter domains like bertling.com.'; return; }
      const row = { name, kind: body.querySelector('#gdKind').value, show_premium: body.querySelector('#gdShow').checked, email_domains: doms, currencies: readCurs(body, 'gdCurs'), notes: body.querySelector('#gdNotes').value.trim() || null, sort: Number(body.querySelector('#gdSort').value) || 100 };
      return (await saveRow('client_groups', row, g && g.id)) ? true : undefined;
    } });
    FC.dialog({ title: g ? 'Client group' : 'New client group', body, actions });
  }
  // inline default clauses (customer or policy): general + own clauses with ticks
  const clauseTicks = (custId, polId) => `<div class="cl-ticks">${CL_CAT.map(([cat, label]) => { const items = clausesFor(custId, polId).filter(c => c.category === cat); return items.length ? `<div><b class="xs">${esc(label)}</b>${items.map(c => `<label class="xs"><input type="checkbox" data-tick="${c.id}" ${clauseOn(c, polId, custId) ? 'checked' : ''}> ${esc(c.title)}${c.scope_type !== 'one_off_general' ? ' <span class="chip neutral">own</span>' : ''}</label>`).join('')}</div>` : ''; }).join('')}</div>`;
  async function saveTicks(box, kind, id){
    const tbl = kind === 'customer' ? 'customer_clauses' : 'policy_clauses', col = kind === 'customer' ? 'customer_id' : 'policy_id';
    const rows = Array.from(box.querySelectorAll('[data-tick]')).map(i => ({ [col]: id, clause_id: Number(i.dataset.tick), enabled: i.checked }));
    if(!rows.length) return true;
    const { error } = await sb.from(tbl).upsert(rows, { onConflict: col + ',clause_id' });
    if(error){ toast('Clauses not saved: ' + error.message, 'error'); return false; }
    return true;
  }
  const profileOptions = (exclude, own) => `<option value="">${own || 'Keep as it is'}</option><option value="g">Copy of the general one-off pool</option>${S.customers.filter(c => c.cover_type !== 'one_off' && !(exclude && exclude.t === 'customer' && exclude.id === c.id)).map(c => `<option value="c${c.id}">Copy of customer ${esc(c.name)}</option>${S.policies.filter(po => po.customer_id === c.id && !(exclude && exclude.t === 'policy' && exclude.id === po.id)).map(po => `<option value="p${po.id}">Copy of policy ${esc(polLabel(po))}</option>`).join('')}`).join('')}`;
  async function applyProfile(src, target, reason){
    if(!src) return true;
    const from = scParse(src);
    const { data, error } = await sb.rpc('admin_copy_config', { p_parts_j: ['schedules','cargo','zones','factors','map','war','clauses'], p_from_type: from.t, p_from_id: from.id, p_targets: [{ type: target.t, id: target.id }], p_items: null, p_reason: reason });
    if(error){ toast('Rate profile not applied: ' + error.message, 'error'); return false; }
    toast('Rate profile applied (' + data + ' items).'); return true;
  }
  // opt: { name, onSaved(id) } - onSaved keeps the calling form (on-the-spot creation from a user, an approval or a quotation)
  function customerDialog(c, groupId, opt){
    opt = opt || {};
    const body = FC.el(`<div><div class="grid2">
        <div class="field"><label for="cuName">Name</label><input id="cuName" maxlength="150" value="${esc(c ? c.name : opt.name || '')}"></div>
        <div class="field"><label for="cuGroup">Client group</label><select id="cuGroup"><option value="">-</option>${S.groups.map(g => `<option value="${g.id}" ${g.id === (c ? c.group_id : groupId) ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></div>
        <div class="field"><label for="cuType">Company type</label><select id="cuType">${[['client','Client'],['insurer','Insurer / underwriting market'],['surveyor','Surveyor'],['agent','Agent']].map(([k, l]) => `<option value="${k}" ${(c ? c.company_type : 'client') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field"><label for="cuCover">Cover type</label><select id="cuCover">${Object.entries(COVER_T).map(([k, l]) => `<option value="${k}" ${(c ? c.cover_type : 'open_cover') === k ? 'selected' : ''}>${l}</option>`).join('')}</select><span class="hint">One-off: always rated from the general one-off pool, never from own terms.</span></div>
        <div class="field"><label for="cuShow">Clients see the indicative premium</label><select id="cuShow"><option value="" ${!c || c.show_premium == null ? 'selected' : ''}>As the group</option><option value="true" ${c && c.show_premium === true ? 'selected' : ''}>Yes</option><option value="false" ${c && c.show_premium === false ? 'selected' : ''}>No - the portal only takes declarations and requests</option></select><span class="hint">Set by staff only. Clients cannot change it.</span></div>
        <div class="field"><label for="cuDisc">Client discount %</label><input id="cuDisc" inputmode="decimal" value="${esc(c ? Number(c.discount_pct || 0) : 0)}"><span class="hint">Applies to every user of the client set to “Default as per client”.</span></div>
        <div class="field"><label for="cuDiscN">Discount notes</label><input id="cuDiscN" maxlength="300" value="${esc(c ? c.discount_notes || '' : '')}"></div>
        <div class="field"><label for="cuCountry">Country of the client (ISO)</label><input id="cuCountry" maxlength="2" value="${esc(c ? c.country || '' : '')}" placeholder="e.g. DE"><span class="hint">Policyholder domicile for the German IPT rules.</span></div>
        <div class="field"><label for="cuMode">Quotations show the client</label>${modeSel('cuMode', c && c.quote_display_mode, 'As the configuration (' + (FC.DISPLAY[setting('quote_display_mode', 'both')] || 'both') + ')')}</div>
        <div class="field"><label for="cuIpt">German IPT</label>${iptSel('cuIpt', c && c.ipt_mode, 'As the configuration (' + (FC.IPT_MODE[(S.ipt || {}).default_mode] || 'off') + ')')}</div>
        <div class="field"><label>Allowed currencies</label>${curBoxes('cuCurs', c ? c.currencies : [])}</div>
        <div class="field"><label for="cuDom">E-mail domains <span class="muted">(users with these addresses belong to the customer)</span></label><input id="cuDom" value="${esc(c ? (c.email_domains || []).join(', ') : '')}"></div>
        <div class="field"><label for="cuProf">Rate profile</label><select id="cuProf">${profileOptions(c ? { t:'customer', id: c.id } : null, c ? 'Keep the current configuration' : 'None yet (set up later in Rates)')}</select><span class="hint">${c ? 'Choosing a source overwrites schedules, cargo types, zones, factors, map, war areas and default clauses (logged).' : 'Schedules, cargo types, zones, factors, map, war areas and default clauses.'}</span></div>
        <div class="field"><label for="cuSort">Sort</label><input id="cuSort" inputmode="numeric" value="${esc(c ? c.sort : 100)}"></div>
        ${c ? '' : `<div class="field"><label for="cuOff">First office <span class="muted">(optional)</span></label><input id="cuOff" maxlength="200" placeholder="e.g. Hamburg head office"></div>`}</div>
      <h3 style="margin:16px 0 6px">Certificates</h3>
      <label class="switch"><input type="checkbox" id="cuFdf" ${c && c.fdf_certificate_enabled ? 'checked' : ''}><span><b>Certificate .fdf generation</b><span>Staff (and later the client) can download the certificate data file for accepted quotations.</span></span></label>
      <label class="switch"><input type="checkbox" id="cuDirect" ${c && c.direct_certificate_enabled ? 'checked' : ''}><span><b>Direct certificate issuance</b><span>A certificate can be issued without indication or quotation; the case is created retroactively.</span></span></label>
      <div class="grid3" id="cuCertF"><div class="field"><label for="cuCH">Holder on the certificate</label><input id="cuCH" maxlength="300" value="${esc(c ? c.cert_holder || '' : '')}" placeholder="as the policyholder"></div>
        <div class="field"><label for="cuCP">Open policy no.</label><input id="cuCP" maxlength="60" value="${esc(c ? c.cert_open_policy || '' : '')}" placeholder="as in Settings"></div>
        <div class="field"><label for="cuCC">Survey / claims agent</label><input id="cuCC" maxlength="120" value="${esc(c ? c.cert_claims_contact || '' : '')}" placeholder="www.vht-network.de"></div></div>
      ${c ? `<h3 style="margin:16px 0 6px">Default clauses</h3><p class="xs muted" style="margin:0 0 8px">Pre-ticked in quotations for this customer (a policy can override them).</p>${clauseTicks(c.id, null)}` : ''}
      <label class="switch"><input type="checkbox" id="cuActive" ${!c || c.active ? 'checked' : ''}><span><b>Active</b></span></label>
      <div class="field" style="margin-top:12px"><label for="cuNotes">Internal notes</label><textarea id="cuNotes" rows="2" maxlength="2000">${esc(c ? c.notes || '' : '')}</textarea></div>
      <div class="err-msg" id="cuErr"></div></div>`);
    if(!c) body.querySelector('#cuProf').value = 'g';
    FC.dialog({ title: c ? c.name : 'New customer', wide:true, body, actions:[{ label:'Cancel', kind:'ghost', value:null }, { label:'Save', kind:'primary', onClick: async () => {
      const v = id => body.querySelector(id).value.trim(), err = t => { body.querySelector('#cuErr').textContent = t; };
      if(!v('#cuName')) return err('Name required.');
      const doms = v('#cuDom').split(/[,;\s]+/).map(x => x.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
      if(doms.some(d => !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d))) return err('Please enter domains like bertling.com.');
      const prof = v('#cuProf');
      if(c && prof && !(await FC.confirm('Overwrite the configuration of ' + c.name + '?', 'Schedules, cargo types, zones, factors, map, war areas and default clauses are replaced by ' + body.querySelector('#cuProf').selectedOptions[0].textContent.replace(/^Copy of /, '') + '.', 'Overwrite', 'danger'))) return;
      const disc = FC.parseNum(v('#cuDisc') || '0'); if(!(disc >= 0 && disc < 100)) return err('The discount must be between 0 and 99.99 %.');
      const row = { name: v('#cuName'), group_id: Number(v('#cuGroup')) || null, cover_type: v('#cuCover'), show_premium: v('#cuShow') === '' ? null : v('#cuShow') === 'true', currencies: readCurs(body, 'cuCurs'), email_domains: doms, active: body.querySelector('#cuActive').checked, notes: v('#cuNotes') || null, sort: Number(v('#cuSort')) || 100,
        company_type: v('#cuType'), discount_pct: disc, discount_notes: v('#cuDiscN') || null, fdf_certificate_enabled: body.querySelector('#cuFdf').checked, direct_certificate_enabled: body.querySelector('#cuDirect').checked,
        cert_holder: v('#cuCH') || null, cert_open_policy: v('#cuCP') || null, cert_claims_contact: v('#cuCC') || null,
        country: v('#cuCountry').toUpperCase() || null, quote_display_mode: v('#cuMode') || null, ipt_mode: v('#cuIpt') || null };
      if(row.country && !/^[A-Z]{2}$/.test(row.country)) return err('Country as a two-letter ISO code, e.g. DE.');
      const r = c ? await sb.from('customers').update(row).eq('id', c.id).select() : await sb.from('customers').insert(row).select();
      if(r.error) return err('Could not save: ' + r.error.message);
      const id = c ? c.id : r.data[0].id;
      if(c) await saveTicks(body, 'customer', id);
      if(prof && row.cover_type !== 'one_off') await applyProfile(prof, { t:'customer', id }, (c ? 'New rate profile for ' : 'Set-up of new customer ') + row.name);
      let officeId = null;
      if(!c && body.querySelector('#cuOff') && v('#cuOff')){ const ro = await sb.from('offices').insert({ customer_id: id, name: v('#cuOff'), kind:'office', active:true, sort:100 }).select(); if(!ro.error && ro.data) officeId = ro.data[0].id; }
      toast('Saved.'); openCust.add(id); await loadAll();
      if(opt.onSaved){ opt.onSaved(id, officeId); return true; }
      render(); return true;
    } }] });
  }
  // ---------------- policy years, expiry, certificate numbering matrices ----------------
  const yStatus = y => { const end = yEnd(y), t = FC.today();
    if(y.status === 'expired') return ['declined', 'Expired'];
    if(end < t) return ['expired', 'Expired (date passed)'];
    if(d10(y.starts_on) > t) return ['pending', 'Upcoming' + (y.status === 'extended' ? ', extended' : '')];
    if(y.status === 'extended') return ['accepted', 'Extended to ' + ymd(y.extended_to)];
    return ['approved', 'Active']; };
  const mtxOf = y => S.matrices.find(m => m.policy_year_id === y.id && m.active) || null;
  const certNo = (m, po, y, n) => { const st = d10(y.starts_on);
    return String(m.naming_pattern || '').replace(/\{\{policy_no\}\}/g, (po && po.policy_no) || '').replace(/\{\{yyyy\}\}/g, st.slice(0, 4)).replace(/\{\{yy\}\}/g, st.slice(2, 4))
      + (Number(m.zero_padding) > 0 ? String(n).padStart(Number(m.zero_padding), '0') : String(n)) + (m.suffix || ''); };
  const nextNo = (m, po, y) => certNo(m, po, y, Math.max(Number(m.current_next_number), Number(m.starting_from)));
  const yearsOf = poId => S.polYears.filter(y => y.policy_id === poId).sort((a, b) => d10(b.starts_on).localeCompare(d10(a.starts_on)));
  A.polYearsOf = yearsOf;
  function paintPolicyYears(host, po){
    const ys = yearsOf(po.id), cov = polCover(po.id, FC.today());
    host.innerHTML = `${cov ? '' : `<div class="notice warn pol-lock"><b>No active policy year today</b>Quotations and certificates under this policy are blocked until a policy year is extended or added.</div>`}
      <div class="tbl-wrap"><table class="tbl py-tbl"><thead><tr><th>Policy year</th><th>Period</th><th>Status</th><th>Certificate numbering</th><th class="r">Certificates</th><th></th></tr></thead><tbody>${ys.map(y => { const st = yStatus(y), m = mtxOf(y), n = S.certs.filter(c => c.policy_year_id === y.id).length;
        return `<tr data-y="${y.id}"><td><b>${esc(y.label)}</b>${y.notes ? '<br><span class="xs muted">' + esc(y.notes) + '</span>' : ''}</td><td class="xs">${esc(ymd(y.starts_on))} - ${esc(ymd(y.ends_on))}${y.extended_to ? '<br>extended to ' + esc(ymd(y.extended_to)) : ''}</td><td>${chip(st[0], st[1])}</td>
          <td class="xs">${m ? '<b>' + esc(m.matrix_name) + '</b><br>next: <code>' + esc(nextNo(m, po, y)) + '</code>' + (m.allow_manual ? '' : ' · manual off') : '<span class="muted">running number (no matrix)</span>'}</td>
          <td class="r">${n ? `<button type="button" class="linkbtn" data-yc="${y.id}">${n}</button>` : '0'}</td>
          <td class="py-acts"><button type="button" class="btn btn-ghost btn-sm" data-ye="${y.id}">Edit</button> <button type="button" class="btn btn-ghost btn-sm" data-yx="${y.id}">Extend</button> <button type="button" class="btn btn-ghost btn-sm" data-ym="${y.id}">${m ? 'Matrix' : '+ Matrix'}</button></td></tr>`; }).join('') || '<tr><td colspan="6" class="muted">No policy year yet.</td></tr>'}</tbody></table></div>
      <div class="toolbar" style="margin-top:8px"><button type="button" class="btn btn-ghost btn-sm" data-yadd>+ Add policy year</button></div>`;
    const again = async () => { await loadAll(); paintPolicyYears(host, polOf(po.id) || po); };
    host.onclick = e => { const b = e.target.closest('button'); if(!b) return; const y = S.polYears.find(z => z.id === Number(b.dataset.ye || b.dataset.yx || b.dataset.ym || b.dataset.yc));
      if(b.dataset.yadd !== undefined) policyYearDialog(po, null).then(ok => ok && again());
      else if(b.dataset.ye) policyYearDialog(po, y).then(ok => ok && again());
      else if(b.dataset.yx) policyYearDialog(po, y, { extend:true }).then(ok => ok && again());
      else if(b.dataset.ym) matrixDialog(po, y).then(ok => ok && again());
      else if(b.dataset.yc) yearCertsDialog(po, y); };
  }
  function policyYearDialog(po, y, o){
    o = o || {};
    const last = yearsOf(po.id)[0], add1 = (dt, n) => { const d = new Date(d10(dt) + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
    const st0 = y ? d10(y.starts_on) : last ? add1(yEnd(last), 1) : FC.today().slice(0, 4) + '-01-01';
    const en0 = y ? d10(y.ends_on) : (() => { const d = new Date(st0 + 'T00:00:00Z'); d.setUTCFullYear(d.getUTCFullYear() + 1); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })();
    const lab0 = y ? y.label : st0.slice(0, 4) + '/' + (Number(st0.slice(0, 4)) + 1);
    const stat0 = o.extend ? 'extended' : y ? y.status : 'active';
    const ext0 = y && y.extended_to ? d10(y.extended_to) : o.extend && y ? add1(y.ends_on, 90) : '';
    const body = FC.el(`<div><div class="grid2"><div class="field"><label for="pyLab">Policy year</label><input id="pyLab" maxlength="60" value="${esc(lab0)}" placeholder="2026/2027"></div>
      <div class="field"><label for="pySt">Status</label><select id="pySt">${[['active','Active'],['extended','Extended'],['expired','Expired']].map(([k, l]) => `<option value="${k}" ${k === stat0 ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="field"><label for="pyFrom">From</label><input id="pyFrom" type="date" value="${esc(st0)}"></div><div class="field"><label for="pyTo">To</label><input id="pyTo" type="date" value="${esc(en0)}"></div>
      <div class="field" id="pyExtF" ${stat0 === 'extended' ? '' : 'hidden'}><label for="pyExt">Extended to</label><input id="pyExt" type="date" value="${esc(ext0)}"></div></div>
      <div class="field"><label for="pyNote">Notes</label><input id="pyNote" maxlength="300" value="${esc(y ? y.notes || '' : '')}"></div>
      <p class="xs muted">Quotations and certificates under the policy need an active or extended policy year covering the shipment date (or today).</p><div class="err-msg" id="pyErr"></div></div>`);
    body.querySelector('#pySt').addEventListener('change', e => { body.querySelector('#pyExtF').hidden = e.target.value !== 'extended'; });
    const acts = [{ label:'Cancel', kind:'ghost', value:false }];
    if(y && !S.certs.some(c => c.policy_year_id === y.id)) acts.unshift({ label:'Delete', kind:'danger', onClick: async () => { if(!(await FC.confirm('Delete policy year ' + y.label + '?', 'Its numbering matrix is deleted too.', 'Delete', 'danger'))) return; const { error } = await sb.from('policy_years').delete().eq('id', y.id); if(error){ toast(error.message, 'error'); return; } toast('Deleted.'); return true; } });
    acts.push({ label:'Save', kind:'primary', onClick: async () => {
      const v = id => body.querySelector(id).value.trim(), err = t => { body.querySelector('#pyErr').textContent = t; };
      const row = { policy_id: po.id, label: v('#pyLab'), starts_on: v('#pyFrom'), ends_on: v('#pyTo'), status: v('#pySt'), extended_to: v('#pySt') === 'extended' ? v('#pyExt') || null : null, notes: v('#pyNote') || null };
      if(!row.label || !row.starts_on || !row.ends_on) return err('Policy year, from and to are required.');
      if(row.ends_on < row.starts_on) return err('"To" lies before "From".');
      if(row.status === 'extended' && !row.extended_to) return err('Enter the date the policy year is extended to.');
      const res = y ? await sb.from('policy_years').update(row).eq('id', y.id) : await sb.from('policy_years').insert(row);
      if(res.error) return err(res.error.message);
      toast('Policy year saved.'); return true; } });
    return FC.dialog({ title: (y ? (o.extend ? 'Extend ' : 'Edit ') + y.label : 'New policy year') + ' · ' + polLabel(po), body, actions: acts });
  }
  function matrixDialog(po, y){
    const m = mtxOf(y), prev = yearsOf(po.id).find(z => d10(z.starts_on) < d10(y.starts_on) && mtxOf(z)), pm = prev ? mtxOf(prev) : null;
    const base = m || (pm ? Object.assign({}, pm, { matrix_name: String(pm.matrix_name).replace(/\d{4}/, d10(y.starts_on).slice(0, 4)), current_next_number: pm.starting_from }) : { matrix_name: (po.name || 'Policy') + ' ' + d10(y.starts_on).slice(0, 4) + ' Matrix', naming_pattern: (po.policy_no ? '{{policy_no}}' : '') + '-{{yy}}/', starting_from: 1, current_next_number: 1, zero_padding: 3, suffix: '', allow_manual: true });
    const body = FC.el(`<div>${!m && pm ? `<p class="small muted" style="margin-top:0">Pre-filled from the matrix of ${esc(prev.label)}, starting again at ${esc(pm.starting_from)}.</p>` : ''}
      <div class="grid2"><div class="field" style="grid-column:1/-1"><label for="mxName">Matrix name</label><input id="mxName" maxlength="120" value="${esc(base.matrix_name)}"></div>
      <div class="field"><label for="mxPat">Prefix / naming pattern</label><input id="mxPat" maxlength="60" value="${esc(base.naming_pattern)}" placeholder="4349-26/ or {{policy_no}}/{{yy}}-"><span class="hint">{{policy_no}}, {{yy}}, {{yyyy}} are filled in.</span></div>
      <div class="field"><label for="mxSuf">Suffix (optional)</label><input id="mxSuf" maxlength="30" value="${esc(base.suffix || '')}"></div>
      <div class="field"><label for="mxStart">Starting from</label><input id="mxStart" inputmode="numeric" value="${esc(base.starting_from)}"></div>
      <div class="field"><label for="mxNext">Next number (counter)</label><input id="mxNext" inputmode="numeric" value="${esc(base.current_next_number)}"><span class="hint">Adjust or reset the sequence at any time.</span></div>
      <div class="field"><label for="mxPad">Zero padding</label><select id="mxPad">${[0,1,2,3,4,5,6].map(n => `<option value="${n}" ${n === Number(base.zero_padding) ? 'selected' : ''}>${n ? n + ' digits (' + '1'.padStart(n, '0') + ')' : 'none (1)'}</option>`).join('')}</select></div></div>
      <label class="switch"><input type="checkbox" id="mxMan" ${base.allow_manual ? 'checked' : ''}><span><b>Staff may type a manual number instead</b><span>Off: every certificate of this policy year gets the next matrix number.</span></span></label>
      <div class="mx-prev">Next certificate number: <b id="mxOut"></b></div><div class="err-msg" id="mxErr"></div></div>`);
    const read = () => ({ matrix_name: body.querySelector('#mxName').value.trim(), naming_pattern: body.querySelector('#mxPat').value.trim(), suffix: body.querySelector('#mxSuf').value.trim(),
      starting_from: parseInt(body.querySelector('#mxStart').value, 10), current_next_number: parseInt(body.querySelector('#mxNext').value, 10), zero_padding: Number(body.querySelector('#mxPad').value), allow_manual: body.querySelector('#mxMan').checked });
    const prevPaint = () => { const x = read(); body.querySelector('#mxOut').textContent = isFinite(x.current_next_number) && isFinite(x.starting_from) ? nextNo(x, po, y) : '-'; };
    body.addEventListener('input', prevPaint); body.addEventListener('change', prevPaint); prevPaint();
    const acts = [{ label:'Cancel', kind:'ghost', value:false }];
    if(m) acts.unshift({ label:'Remove matrix', kind:'danger', onClick: async () => { if(!(await FC.confirm('Remove the matrix?', 'New certificates of this policy year get the running number instead. Issued certificates keep their numbers.', 'Remove', 'danger'))) return; const { error } = await sb.from('certificate_numbering_matrices').delete().eq('id', m.id); if(error){ toast(error.message, 'error'); return; } return true; } });
    acts.push({ label:'Save matrix', kind:'primary', onClick: async () => {
      const x = read(), err = t => { body.querySelector('#mxErr').textContent = t; };
      if(!x.matrix_name) return err('Matrix name required.');
      if(!(x.starting_from >= 0) || !(x.current_next_number >= 0)) return err('Starting number and counter must be whole numbers of 0 or more.');
      const res = m ? await sb.from('certificate_numbering_matrices').update(Object.assign({ updated_at: new Date().toISOString() }, x)).eq('id', m.id) : await sb.from('certificate_numbering_matrices').insert(Object.assign({ policy_year_id: y.id, active: true }, x));
      if(res.error) return err(res.error.message);
      toast('Numbering matrix saved.'); return true; } });
    return FC.dialog({ title:'Certificate numbering · ' + y.label, wide:true, body, actions: acts });
  }
  function yearCertsDialog(po, y){
    const cs = S.certs.filter(c => c.policy_year_id === y.id).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const box = FC.el(`<div class="list">${cs.map(c => `<div class="item"><div><div class="t">${esc(c.number)} ${chip('neutral', CERT_MODE[c.numbering_mode] || '')}</div><div class="meta">${esc(FC.dateTime(c.created_at))} · ${esc(((S.rows.find(r => r.id === c.indication_id) || {}).ref) || '')} · ${esc(((c.data || {}).holder || '').slice(0, 60))}</div></div><div class="acts"><button type="button" class="btn btn-ok btn-sm" data-f="${c.id}">.fdf</button></div></div>`).join('')}</div>`);
    box.addEventListener('click', e => { const b = e.target.closest('[data-f]'); if(b) fdfDownload(S.certs.find(c => c.id === Number(b.dataset.f))); });
    FC.dialog({ title:'Certificates · ' + polLabel(po) + ' · ' + y.label, wide:true, body: box, actions:[{ label:'Close', kind:'primary', value:true }] });
  }

  // display mode / IPT selects for client and policy
  const modeSel = (id, v, inherit) => `<select id="${id}"><option value="" ${!v ? 'selected' : ''}>${esc(inherit)}</option>${Object.entries(FC.DISPLAY).map(([k, l]) => `<option value="${k}" ${v === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const iptSel = (id, v, inherit) => `<select id="${id}"><option value="" ${!v ? 'selected' : ''}>${esc(inherit)}</option>${Object.entries(FC.IPT_MODE).map(([k, l]) => `<option value="${k}" ${v === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  function policyDialog(po, customerId){
    const R = Object.assign({}, (po && po.rules) || {}), rv = (path) => { let v = R; path.forEach(k => v = v && v[k]); return v == null ? '' : v; }, rd = (path) => { let v = RULE_DEF; path.forEach(k => v = v && v[k]); return v == null ? 'on request' : v; };
    const rIn = (id, path, label) => `<div class="field"><label for="${id}">${label}</label><input id="${id}" data-rule="${path.join('.')}" inputmode="decimal" value="${esc(rv(path))}" placeholder="${esc(rd(path))}"></div>`;
    const secRow = x => `<div class="gp-sec"><input class="sc-ins" placeholder="Insurer" value="${esc(x.insurer || '')}"><input class="sc-share" inputmode="decimal" placeholder="%" value="${esc(x.share ?? '')}"><label class="xs"><input type="checkbox" class="sc-lead" ${x.lead ? 'checked' : ''} style="width:auto;min-width:0"> Lead</label><button type="button" class="linkbtn sc-del">Remove</button></div>`;
    const cid = po ? po.customer_id : customerId;
    const hasOwn = po && S.rateTables.some(t => t.scope_type === 'policy' && t.scope_id === po.id);
    const body = FC.el(`<div><div class="grid3">
        <div class="field"><label for="pdName">Name</label><input id="pdName" maxlength="150" value="${esc(po ? po.name : '')}" placeholder="e.g. Bertling Global"></div>
        <div class="field"><label for="pdNo">Policy number</label><input id="pdNo" maxlength="60" value="${esc(po ? po.policy_no || '' : '')}"></div>
        <div class="field"><label for="pdCust">Customer</label><select id="pdCust">${S.customers.map(c => `<option value="${c.id}" ${c.id === cid ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
        <div class="field"><label for="pdType">Cover type</label><select id="pdType"><option value="open_cover" ${!po || po.cover_type === 'open_cover' ? 'selected' : ''}>Open cover</option><option value="policy" ${po && po.cover_type === 'policy' ? 'selected' : ''}>Policy</option></select></div>
        <div class="field" style="grid-column:span 2"><label for="pdHolder">Policyholder (as on the policy)</label><input id="pdHolder" maxlength="300" value="${esc(po ? po.policyholder || '' : '')}"></div>
        <div class="field"><label for="pdCur">Base currency</label><select id="pdCur">${CURS.map(c => `<option ${(po ? po.currency : 'EUR') === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
        <div class="field" style="grid-column:span 2"><label>Allowed currencies</label>${curBoxes('pdCurs', po ? po.currencies : [])}</div>
        <div class="field"><label for="pdMin">Minimum premium</label><input id="pdMin" inputmode="decimal" value="${esc(po ? po.min_premium : 100)}"></div>
        <div class="field"><label for="pdDed">Deductible (each and every loss)</label><input id="pdDed" inputmode="decimal" value="${esc(po ? po.deductible ?? '' : 100)}"></div>
        <div class="field"><label for="pdL1">Limit any one conveyance / storage</label><input id="pdL1" inputmode="decimal" value="${esc(po ? po.limit_conveyance ?? '' : '')}"></div>
        <div class="field"><label for="pdL2">Limit on deck / barge</label><input id="pdL2" inputmode="decimal" value="${esc(po ? po.limit_on_deck ?? '' : '')}"></div>
        <div class="field"><label for="pdL3">Limit parcel post / mail</label><input id="pdL3" inputmode="decimal" value="${esc(po ? po.limit_post ?? '' : '')}"></div>
        <div class="field"><label for="pdRating">Rating</label><select id="pdRating"><option value="schedule" ${!po || po.rating === 'schedule' ? 'selected' : ''}>Policy schedules (zone matrices as they stand)</option><option value="standard" ${po && po.rating === 'standard' ? 'selected' : ''}>Standard FREIGHTCON rating</option></select></div>
        <div class="field"><label for="pdProf">Rate profile</label><select id="pdProf">${profileOptions(po ? { t:'policy', id: po.id } : null, hasOwn ? 'Keep its own configuration' : "Use the customer's configuration")}</select><span class="hint">${hasOwn ? 'This policy has its own schedules.' : 'Without an own copy the policy uses the customer defaults.'}</span></div>
        <div class="field"><label for="pdShow">Clients see the indicative premium</label><select id="pdShow"><option value="" ${!po || po.show_premium == null ? 'selected' : ''}>As the client</option><option value="true" ${po && po.show_premium === true ? 'selected' : ''}>Yes</option><option value="false" ${po && po.show_premium === false ? 'selected' : ''}>No - the portal only takes declarations and requests</option></select></div>
        <div class="field"><label for="pdMode">Quotations show the client</label>${modeSel('pdMode', po && po.quote_display_mode, 'As the client')}</div>
        <div class="field"><label for="pdIpt">German IPT</label>${iptSel('pdIpt', po && po.ipt_mode, 'As the client')}</div>
        <div class="field"><label for="pdHC">Policyholder country (ISO)</label><input id="pdHC" maxlength="2" value="${esc(po ? po.policyholder_country || '' : '')}" placeholder="e.g. DE"><span class="hint">Domicile for the IPT rules; empty = as the client.</span></div>
        <div class="field"><label for="pdVia">Placed via</label><input id="pdVia" maxlength="150" value="${esc(po ? po.placed_via || '' : '')}" placeholder="e.g. Assekuranz-Kontor Montan GmbH"></div>
        <div class="field"><label for="pdSort">Sort</label><input id="pdSort" inputmode="numeric" value="${esc(po ? po.sort : 100)}"></div></div>
      <h3 style="margin:16px 0 6px">Policy years</h3><p class="xs muted" style="margin:0 0 8px">Each year with its period, status and certificate numbering. Without an active or extended year covering the shipment, quotations and certificates are blocked.</p>
      ${po ? '<div id="pdYears"></div>' : `<div class="grid3"><div class="field"><label for="pdY1">First policy year from</label><input id="pdY1" type="date" value="${FC.today().slice(0, 4)}-01-01"></div><div class="field"><label for="pdY2">to</label><input id="pdY2" type="date" value="${FC.today().slice(0, 4)}-12-31"></div></div>`}
      <h3 style="margin:16px 0 6px">Security (insurer splits)</h3><p class="xs muted" style="margin:0 0 8px">Internal only - never shown to clients or on slips. Never copied to other policies.</p>
      <div id="pdSec">${((po && po.security) || []).map(secRow).join('')}</div><button type="button" class="btn btn-ghost btn-sm" id="pdSecAdd" style="margin-top:6px">+ Add insurer</button> <span class="xs" id="pdSecSum"></span>
      <h3 style="margin:18px 0 6px">Schedule rules</h3><p class="xs muted" style="margin:0 0 8px">Only used with “Policy schedules”. Empty = the value shown in grey.</p>
      <div class="grid3">
        ${rIn('ruC', ['icc_c_pct'], 'ICC (C): % of schedule rate')}${rIn('ruI', ['interest_pct'], "Seller's / buyer's interest: % of rate")}${rIn('ruD', ['deck_loading_pct'], 'Conventional on deck: loading %')}
        ${rIn('ruW', ['air_war_permille'], 'Air: war &amp; strikes A.P. ‰')}${rIn('ruAU', ['air_freight', 'used_pct'], 'Airfreight: used goods loading %')}${rIn('ruAC', ['air_freight', 'cars_pct'], 'Airfreight: cars loading %')}
        ${rIn('ruAH', ['air_freight', 'household_permille'], 'Airfreight: household goods flat ‰')}${rIn('ruCU', ['air_charter', 'used_pct'], 'Air charter: used goods loading %')}${rIn('ruCC', ['air_charter', 'cars_pct'], 'Air charter: cars loading %')}</div>
      ${po ? `<h3 style="margin:18px 0 6px">Default clauses</h3><p class="xs muted" style="margin:0 0 8px">Pre-ticked in quotations under this policy.</p>${clauseTicks(po.customer_id, po.id)}` : ''}
      <label class="switch"><input type="checkbox" id="pdCert" ${po && po.certificate ? 'checked' : ''}><span><b>Issues certificates</b><span>On the AKM / MARINCON certificate form.</span></span></label>
      <label class="switch"><input type="checkbox" id="pdActive" ${!po || po.active ? 'checked' : ''}><span><b>Active</b><span>Inactive policies send every shipment to the brokers.</span></span></label>
      <div class="field" style="margin-top:12px"><label for="pdNotes">Internal notes</label><textarea id="pdNotes" rows="2" maxlength="2000">${esc(po ? po.notes || '' : '')}</textarea></div>
      <div class="err-msg" id="pdErr"></div></div>`);
    const secHost = body.querySelector('#pdSec');
    const sum = () => { const t = Array.from(secHost.querySelectorAll('.sc-share')).reduce((a, i) => a + (FC.parseNum(i.value) || 0), 0); body.querySelector('#pdSecSum').innerHTML = secHost.children.length ? `Total <b>${Math.round(t * 100) / 100} %</b>${Math.abs(t - 100) > 0.001 ? ' <span class="chip declined">should be 100 %</span>' : ''}` : ''; };
    secHost.addEventListener('input', sum); secHost.addEventListener('click', e => { if(e.target.closest('.sc-del')){ e.target.closest('.gp-sec').remove(); sum(); } });
    body.querySelector('#pdSecAdd').addEventListener('click', () => { secHost.appendChild(FC.el(secRow({}))); sum(); }); sum();
    if(po) paintPolicyYears(body.querySelector('#pdYears'), po);
    const actions = [{ label:'Cancel', kind:'ghost', value:null }];
    if(po) actions.unshift({ label:'Delete policy', kind:'danger', onClick: async () => (await delRow('policies', po.id, 'Delete ' + po.name + '?', 'Its own configuration is deleted. Past shipments keep their figures.')) ? true : undefined });
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
      const curs = readCurs(body, 'pdCurs');
      if(curs.length && !curs.includes(v('#pdCur'))) return err('The base currency must be one of the allowed currencies.');
      const cust = custOf(Number(v('#pdCust')));
      const row = Object.assign({ name: v('#pdName'), policy_no: v('#pdNo') || null, customer_id: cust.id, group_id: cust.group_id || (po ? po.group_id : null), cover_type: v('#pdType'), policyholder: v('#pdHolder') || null, currency: v('#pdCur'), currencies: curs,
        rating: v('#pdRating'), show_premium: v('#pdShow') === '' ? null : v('#pdShow') === 'true', placed_via: v('#pdVia') || null, security, rules,
        quote_display_mode: v('#pdMode') || null, ipt_mode: v('#pdIpt') || null, policyholder_country: v('#pdHC').toUpperCase() || null, certificate: body.querySelector('#pdCert').checked, active: body.querySelector('#pdActive').checked, notes: v('#pdNotes') || null, sort: Number(v('#pdSort')) || 100 }, nums);
      if(!row.group_id){ const g = S.groups[0]; row.group_id = g ? g.id : null; }
      const prof = v('#pdProf');
      if(po && prof && hasOwn && !(await FC.confirm('Overwrite the configuration of ' + po.name + '?', "The policy's own schedules, cargo types, zones, factors, map, war areas and default clauses are replaced. Policy number, currency, limits, minimum premium, deductible and security stay.", 'Overwrite', 'danger'))) return;
      if(row.policyholder_country && !/^[A-Z]{2}$/.test(row.policyholder_country)) return err('Policyholder country as a two-letter ISO code, e.g. DE.');
      if(!po && (!v('#pdY1') || !v('#pdY2') || v('#pdY2') < v('#pdY1'))) return err('Enter the first policy year (from / to).');
      const saved = await saveRow('policies', row, po && po.id); if(!saved) return;
      const id = po ? po.id : saved.id;
      if(!po && id){ const y1 = v('#pdY1'), y2 = v('#pdY2'), lab = y1.slice(0, 4) + '/' + (Number(y1.slice(0, 4)) + 1);
        const { data: ys } = await sb.from('policy_years').select('id').eq('policy_id', id);
        const r1 = (ys || []).length ? await sb.from('policy_years').update({ label: lab, starts_on: y1, ends_on: y2, status:'active' }).eq('id', ys[0].id) : await sb.from('policy_years').insert({ policy_id: id, label: lab, starts_on: y1, ends_on: y2, status:'active' });
        if(r1.error) toast('Policy saved, but the policy year could not be set: ' + r1.error.message, 'error'); }
      if(po) await saveTicks(body, 'policy', id);
      if(prof && id) await applyProfile(prof, { t:'policy', id }, (po ? 'New rate profile for policy ' : 'Set-up of new policy ') + row.name);
      await loadAll(); render(); return true;
    } });
    FC.dialog({ title: po ? po.name : 'New policy', wide:true, body, actions });
  }
  function officeDialog(o, policyId, customerId){
    const cid0 = o ? o.customer_id : customerId || (polOf(policyId) || {}).customer_id;
    const body = FC.el(`<div><div class="grid2">
        <div class="field" style="grid-column:1/-1"><label for="odName">Entity / office name</label><input id="odName" maxlength="200" value="${esc(o ? o.name : '')}"></div>
        <div class="field"><label for="odLoc">City / location</label><input id="odLoc" maxlength="200" value="${esc(o ? o.location || '' : '')}"></div>
        <div class="field"><label for="odCty">Country</label><select id="odCty"><option value="">-</option>${S.countries.map(c => `<option value="${c.iso2}" ${o && o.country === c.iso2 ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
        <div class="field"><label for="odKind">Type</label><select id="odKind">${Object.entries(KIND).map(([k, l]) => `<option value="${k}" ${o && o.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field"><label for="odCust">Customer</label><select id="odCust">${S.customers.map(c => `<option value="${c.id}" ${c.id === cid0 ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
        <div class="field"><label for="odPol">Policy</label><select id="odPol"></select></div>
        <div class="field"><label for="odSub">Subcategory <span class="muted">(e.g. Singapore)</span></label><input id="odSub" maxlength="60" value="${esc(o ? o.subcategory || '' : '')}"></div>
        <div class="field"><label>Allowed currencies <span class="muted">(this office only)</span></label>${curBoxes('odCurs', o ? o.currencies : [])}</div>
        <div class="field"><label for="odSort">Sort</label><input id="odSort" inputmode="numeric" value="${esc(o ? o.sort : 100)}"></div>
        <div class="field"><label for="odMin">Minimum premium <span class="muted" id="odMinH"></span></label><input id="odMin" inputmode="decimal" value="${esc(o ? o.min_premium ?? '' : '')}"></div>
        <div class="field"><label for="odDed">Deductible <span class="muted" id="odDedH"></span></label><input id="odDed" inputmode="decimal" value="${esc(o ? o.deductible ?? '' : '')}"></div>
        <div class="field" style="grid-column:1/-1"><label for="odCon">Contacts <span class="muted">(internal only)</span></label><input id="odCon" maxlength="500" value="${esc(o ? o.contacts || '' : '')}"></div></div>
      <label class="switch"><input type="checkbox" id="odActive" ${!o || o.active ? 'checked' : ''}><span><b>Active</b><span>Inactive offices cannot be chosen for new shipments.</span></span></label>
      <div class="err-msg" id="odErr"></div></div>`);
    const cs = body.querySelector('#odCust'), ps = body.querySelector('#odPol');
    const paintPol = () => { const cid = Number(cs.value); const pols = S.policies.filter(x => x.customer_id === cid);
      ps.innerHTML = '<option value="">- none -</option>' + pols.map(x => `<option value="${x.id}" ${x.id === (o ? o.policy_id : policyId) || (!o && !policyId && pols.length === 1) ? 'selected' : ''}>${esc(polLabel(x))} (${esc(x.currency)})</option>`).join(''); paintHint(); };
    const paintHint = () => { const po = polOf(Number(ps.value)); body.querySelector('#odMinH').textContent = po ? '(empty = policy: ' + amt(po.min_premium, po.currency) + ')' : '(empty = schedule)'; body.querySelector('#odDedH').textContent = po ? '(empty = policy: ' + amt(po.deductible, po.currency) + ')' : '(empty = cargo type)'; };
    cs.addEventListener('change', paintPol); ps.addEventListener('change', paintHint); paintPol();
    const actions = [{ label:'Cancel', kind:'ghost', value:null }];
    if(o) actions.unshift({ label:'Remove office', kind:'danger', onClick: async () => (await delRow('offices', o.id, 'Remove ' + o.name + '?', 'Users of this office must choose a new one. Past shipments keep their figures.')) ? true : undefined });
    actions.push({ label:'Save', kind:'primary', onClick: async () => {
      const v = id => body.querySelector(id).value.trim();
      if(!v('#odName')) return void (body.querySelector('#odErr').textContent = 'Name required.');
      const mn = numOrNull(v('#odMin')), dd = numOrNull(v('#odDed'));
      if((mn != null && !(mn >= 0)) || (dd != null && !(dd >= 0))) return void (body.querySelector('#odErr').textContent = 'Amounts must be numbers of 0 or more, or empty.');
      const row = { name: v('#odName'), location: v('#odLoc') || null, country: v('#odCty') || null, kind: v('#odKind'), customer_id: Number(v('#odCust')), policy_id: Number(v('#odPol')) || null, subcategory: v('#odSub') || null,
        currencies: readCurs(body, 'odCurs'), min_premium: mn, deductible: dd, contacts: v('#odCon') || null, active: body.querySelector('#odActive').checked, sort: Number(v('#odSort')) || 100 };
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
    const body = FC.el(`<div><dl class="kv"><dt>E-mail</dt><dd>${esc(p.email)}</dd><dt>Registered</dt><dd>${esc(FC.dateTime(p.created_at))}</dd><dt>Last login</dt><dd>${p.last_login_at ? esc(FC.dateTime(p.last_login_at)) : 'never'}</dd><dt>Referral code</dt><dd>${esc(p.referral_code || '')}</dd>${p.deletion_requested_at ? `<dt>Deletion requested</dt><dd>${esc(FC.dateTime(p.deletion_requested_at))}</dd>` : ''}</dl>
      <div class="grid2" style="margin-top:14px">
        <div class="field"><label for="ecFirst">First name</label><input id="ecFirst" maxlength="60" value="${esc(p.first_name || (p.full_name || '').split(' ')[0] || '')}"></div>
        <div class="field"><label for="ecLast">Last name</label><input id="ecLast" maxlength="60" value="${esc(p.last_name || (p.full_name || '').split(' ').slice(1).join(' ') || '')}"></div>
        <div class="field"><label for="ecCo">Company</label><input id="ecCo" maxlength="150" value="${esc(p.company || '')}"></div>
        <div class="field"><label for="ecAddr">Street and number</label><input id="ecAddr" maxlength="150" value="${esc(p.address_line || '')}"></div>
        <div class="field"><label for="ecZip">Postcode and city</label><div class="grid2" style="grid-template-columns:100px 1fr"><input id="ecZip" maxlength="20" value="${esc(p.postcode || '')}"><input id="ecCity" maxlength="80" value="${esc(p.city || '')}" aria-label="City"></div></div>
        <div class="field"><label for="ecCountry">Country</label><input id="ecCountry" maxlength="80" value="${esc(p.country || '')}"></div>
        <div class="field"><label for="ecPhone">Phone</label><input id="ecPhone" maxlength="40" value="${esc(p.phone || '')}"></div>
        ${discModeHtml(p)}
        <div class="field"><label for="ecStatus">Access</label><select id="ecStatus"><option value="active" ${p.approved && !p.rejected ? 'selected' : ''}>Approved</option><option value="waiting" ${!p.approved && !p.rejected ? 'selected' : ''}>Waiting</option><option value="rejected" ${p.rejected ? 'selected' : ''}>Rejected / blocked</option></select></div>
      </div>
      <h3 style="margin:18px 0 8px">Customer, office &amp; cover</h3>
      <div class="grid2">
        <div class="field"><label for="ecCust">Customer</label><select id="ecCust"><option value="">${domainCust(p.email) ? 'By e-mail domain: ' + esc(domainCust(p.email).name) : 'None (one-off client)'}</option>${S.customers.map(c => `<option value="${c.id}" ${p.customer_id === c.id ? 'selected' : ''}>${esc(c.name)}${c.active ? '' : ' (inactive)'}</option>`).join('')}</select></div>
        <div class="field"><label for="ecOffice">Office / entity</label><select id="ecOffice"></select></div>
        <div class="field"><label for="ecCover">Cover type</label><select id="ecCover"><option value="">As the customer</option>${Object.entries(COVER_T).map(([k, l]) => `<option value="${k}" ${p.cover_type === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field"><label>Currencies</label><div class="xs" id="ecCurs" style="padding-top:10px"></div></div>
        <div class="field"><label for="ecMin">Minimum premium for this user <span class="muted">(empty = office / policy)</span></label><input id="ecMin" inputmode="decimal" value="${esc(p.min_premium_override ?? '')}"></div>
        <div class="field"><label for="ecDed">Deductible for this user <span class="muted">(empty = office / policy)</span></label><input id="ecDed" inputmode="decimal" value="${esc(p.deductible_override ?? '')}"></div>
      </div>
      <p class="xs muted" id="ecEff" style="margin:-4px 0 0"></p>
      <div class="field" style="margin-top:12px"><label for="ecNote">Internal note</label><textarea id="ecNote" rows="2" maxlength="1000">${esc(p.internal_note || '')}</textarea></div>
      <label class="switch"><input type="checkbox" id="ecActive" ${p.is_active !== false ? 'checked' : ''} ${p.id === me().id ? 'disabled' : ''}><span><b>Login enabled</b><span>Off = disabled: no login, history kept.</span></span></label>
      <h3 style="margin:18px 0 8px">Access</h3>${accessHtml(p)}
      <div class="err-msg" id="ecErr"></div></div>`);
    const cSel = body.querySelector('#ecCust'), oSel = body.querySelector('#ecOffice');
    const curCust = () => custOf(Number(cSel.value)) || domainCust(p.email);
    const paintOffices = () => {
      const c = curCust();
      oSel.innerHTML = `<option value="">No office</option>` + (c ? S.offices.filter(o => o.customer_id === c.id).map(o => `<option value="${o.id}" ${p.office_id === o.id ? 'selected' : ''}>${esc(o.name)}${o.location ? ' - ' + esc(o.location) : ''}${o.active ? '' : ' (inactive)'}</option>`).join('') : '');
      paintEff();
    };
    const paintEff = () => {
      const c = curCust(), o = ofcOf(Number(oSel.value)), po = o && polOf(o.policy_id), x = Object.assign({}, p, { min_premium_override: body.querySelector('#ecMin').value.trim() === '' ? null : FC.parseNum(body.querySelector('#ecMin').value), deductible_override: body.querySelector('#ecDed').value.trim() === '' ? null : FC.parseNum(body.querySelector('#ecDed').value) });
      const cover = body.querySelector('#ecCover').value || (c ? c.cover_type : 'one_off');
      body.querySelector('#ecCurs').textContent = (cover === 'one_off' ? allowedCurs(null, null, null) : allowedCurs(o && o.id, po && po.id, c && c.id)).join(' · ');
      body.querySelector('#ecEff').textContent = cover !== 'one_off' && po ? `Applies: ${po.name} ${po.policy_no || ''} in ${po.currency} · minimum premium ${amt(effMin(po, o, x), po.currency)} · deductible ${amt(effDed(po, o, x), po.currency)}` : cover === 'one_off' ? 'One-off: rated from the general one-off pool.' : c ? 'Rated from the configuration of ' + c.name + '.' : '';
    };
    cSel.addEventListener('change', paintOffices); oSel.addEventListener('change', paintEff); body.querySelector('#ecCover').addEventListener('change', paintEff);
    body.querySelector('#ecMin').addEventListener('input', paintEff); body.querySelector('#ecDed').addEventListener('input', paintEff);
    paintOffices();
    const repaintDisc = wireDiscMode(body, curCust); cSel.addEventListener('change', repaintDisc);
    spotClient(cSel, () => body.querySelector('#ecCo').value.trim(), (id, off) => { if(off){ oSel.value = String(off); paintEff(); } });
    wireAccess(body); if(p.id === me().id) body.querySelectorAll('.acc-blk select, .acc-blk input').forEach(x => { if(x.id !== 'acDep') x.disabled = true; });
    FC.dialog({ title: p.full_name || p.email, wide:true, body, actions:[{ label:'Cancel', kind:'ghost', value:null }, { label:'Save', kind:'primary', onClick: async () => {
      const dm = readDiscMode(body); if(dm.error){ body.querySelector('#ecErr').textContent = dm.error; return; }
      const minO = body.querySelector('#ecMin').value.trim(), dedO = body.querySelector('#ecDed').value.trim();
      if((minO && !(FC.parseNum(minO) >= 0)) || (dedO && !(FC.parseNum(dedO) >= 0))){ body.querySelector('#ecErr').textContent = 'Minimum premium and deductible must be numbers (or empty).'; return; }
      const offId = Number(oSel.value) || null, st = body.querySelector('#ecStatus').value;
      const fn = body.querySelector('#ecFirst').value.trim(), ln = body.querySelector('#ecLast').value.trim();
      const cid = Number(cSel.value) || (offId ? ofcOf(offId).customer_id : null);
      const patch = { full_name: [fn, ln].filter(Boolean).join(' ') || null, first_name: fn || null, last_name: ln || null, address_line: body.querySelector('#ecAddr').value.trim() || null, postcode: body.querySelector('#ecZip').value.trim() || null, city: body.querySelector('#ecCity').value.trim() || null, company: body.querySelector('#ecCo').value.trim() || null, country: body.querySelector('#ecCountry').value.trim() || null,
        phone: body.querySelector('#ecPhone').value.trim() || null, discount_mode: dm.discount_mode, special_discount_pct: dm.special_discount_pct, internal_note: body.querySelector('#ecNote').value.trim() || null,
        approved: st === 'active', rejected: st === 'rejected', customer_id: cid, office_id: offId, cover_type: body.querySelector('#ecCover').value || null,
        group_id: cid ? (custOf(cid) || {}).group_id || null : null,
        min_premium_override: minO ? FC.parseNum(minO) : null, deductible_override: dedO ? FC.parseNum(dedO) : null };
      const ac = readAccess(body); if(ac.error){ body.querySelector('#ecErr').textContent = ac.error; return; }
      patch.department_id = ac.department_id;
      if(p.id !== me().id && isStaffAdmin()){ Object.assign(patch, { is_admin: ac.is_admin, user_group_id: ac.user_group_id, staff_roles: ac.staff_roles, insurer_id: ac.insurer_id }); }
      if(p.id !== me().id){
        const act = body.querySelector('#ecActive').checked;
        if(act !== (p.is_active !== false)){ if(!(await manageUser(act ? 'enable' : 'disable', p, true))) return; } }
      return (await upd(p.id, patch)) ? true : undefined;
    } }] });
  }

  // =================================================================== RATES
  let rateTab = 'tables', curKind = null, rtUnlocked = false, rScope = GEN;
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
    return rows.length ? `<div class="audit-foot"><b>Change log</b>${rows.map(a => `<div><span class="xs muted">${esc(FC.dateTime(a.at))} · ${esc(a.user_name || '')}</span><br>${esc(a.summary)}<br><i>Reason: ${esc(a.reason || '-')}</i></div>`).join('')}</div>` : `<div class="audit-foot"><b>Change log</b><div class="xs muted">No changes recorded yet.</div></div>`;
  };
  const scEntity = sc => sc.t + (sc.id != null ? ':' + sc.id : '');
  // scoped rows loaded on demand (large tables stay out of loadAll; PostgREST returns at most 1000 rows)
  const scoped = (q, sc) => { q = q.eq('scope_type', sc.t); return sc.id != null ? q.eq('scope_id', sc.id) : q; };
  async function cellsOf(tableId){
    if(!S.cellCache[tableId]){ const { data, error } = await sb.from('rate_cells').select('*').eq('table_id', tableId); if(error) toast(error.message, 'error'); S.cellCache[tableId] = data || []; }
    return S.cellCache[tableId];
  }

  // ---------------- copy / apply configuration to other policies or customers ----------------
  const PART_L = { schedules:'Schedules', cargo:'Cargo types', zones:'Countries & zones', factors:'Factors & limits', map:'Zone map', war:'War & strikes exclusions', clauses:'Clauses & defaults' };
  function copyDialog(parts, from, items, opt){
    opt = opt || {};
    const cu = scCust(from), only = opt.only || null;
    const sibs = cu ? S.policies.filter(po => po.customer_id === cu.id && !(from.t === 'policy' && po.id === from.id)) : [];
    const others = S.customers.filter(c => !cu || c.id !== cu.id), xpols = S.policies.filter(po => !cu || po.customer_id !== cu.id);
    const polOpts = list => S.customers.map(c => { const ps = list.filter(po => po.customer_id === c.id); return ps.length ? `<optgroup label="${esc(c.name)}">${ps.map(po => `<option value="${po.id}">${esc(polLabel(po))}</option>`).join('')}</optgroup>` : ''; }).join('');
    const T = [];
    if(from.t === 'policy' && only !== 'policy') T.push(['own', `The customer defaults of ${esc(cu.name)}`, '']);
    if(sibs.length && only !== 'customer') T.push(['pol', 'Another policy of the same customer', `<select id="cpPol">${sibs.map(po => `<option value="${po.id}">${esc(polLabel(po))}</option>`).join('')}</select>`]);
    if(only !== 'customer' && ((from.t === 'customer' && sibs.length) || (from.t === 'policy' && sibs.length > 1))) T.push(['all', `All ${from.t === 'policy' ? 'other ' : ''}policies of ${esc(cu.name)} (${sibs.length})`, '']);
    if(others.length && only !== 'policy') T.push(['cust', cu ? 'Another customer' : 'A customer (customer defaults)', `<select id="cpCust" multiple size="${Math.min(5, others.length)}">${others.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>`]);
    if(xpols.length && only !== 'customer') T.push(['xpol', cu ? "A policy of another customer" : 'A policy', `<select id="cpXPol" multiple size="${Math.min(6, xpols.length + 1)}">${polOpts(xpols)}</select>`]);
    if(!T.length) return toast('There is no other customer or policy to copy to. Add one under Customers first.', 'error');
    const what = items ? Object.entries(items).map(([k, v]) => v.length + ' ' + (PART_L[k] || k).toLowerCase()).join(', ') : parts.map(p => PART_L[p]).join(', ');
    const body = FC.el(`<div><p class="small" style="margin-top:0">From <b>${esc(scName(from))}</b>: ${esc(what)}.</p>
      ${!items && parts.length > 1 ? `<div class="field"><label>What to copy</label><div class="cur-boxes">${parts.map(p => `<label><input type="checkbox" data-part="${p}" checked> ${esc(PART_L[p])}</label>`).join('')}</div></div>` : ''}
      <div class="field"><label>Apply to</label><div class="cp-targets">${T.map(([k, l, extra], i) => `<label class="cp-t"><input type="radio" name="cpT" value="${k}" ${i === 0 ? 'checked' : ''}><span>${l}</span>${extra ? '<span class="cp-x">' + extra + '</span>' : ''}</label>`).join('')}</div></div>
      <p class="xs muted">Existing settings of the target with the same name are replaced. <b>Never copied:</b> policy number, currency, limits, minimum premium and deductible of the policy, insurer splits (security).</p>
      <div class="field"><label for="cpWhy">Reason <span class="muted">(change log)</span></label><input id="cpWhy" maxlength="300" placeholder="e.g. same terms as agreed for the group"></div><div class="err-msg" id="cpErr"></div></div>`);
    FC.dialog({ title:'Copy / Apply to…', wide:true, body, actions:[{ label:'Cancel', kind:'ghost', value:null }, { label:'Copy', kind:'primary', onClick: async () => {
      const err = t => { body.querySelector('#cpErr').textContent = t; };
      const k = (body.querySelector('[name=cpT]:checked') || {}).value, sel = id => Array.from((body.querySelector(id) || { selectedOptions:[] }).selectedOptions).map(o => Number(o.value));
      let targets = [];
      if(k === 'own') targets = [{ type:'customer', id: cu.id }];
      if(k === 'pol') targets = [{ type:'policy', id: Number(body.querySelector('#cpPol').value) }];
      if(k === 'all') targets = sibs.map(po => ({ type:'policy', id: po.id }));
      if(k === 'cust') targets = sel('#cpCust').map(id => ({ type:'customer', id }));
      if(k === 'xpol') targets = sel('#cpXPol').map(id => ({ type:'policy', id }));
      if(!targets.length) return err('Choose at least one target.');
      const ps = !items && parts.length > 1 ? Array.from(body.querySelectorAll('[data-part]:checked')).map(i => i.dataset.part) : parts;
      if(!ps.length) return err('Choose what to copy.');
      const why = body.querySelector('#cpWhy').value.trim(); if(why.length < 3) return err('Please give a short reason.');
      const { data, error } = await sb.rpc('admin_copy_config', { p_parts_j: ps, p_from_type: from.t, p_from_id: from.id, p_targets: targets, p_items: items || null, p_reason: why });
      if(error) return err('Could not copy: ' + error.message);
      toast('Copied to ' + targets.length + ' target' + (targets.length > 1 ? 's' : '') + ' (' + data + ' items).'); await loadAll(); render(); return true;
    } }] });
  }
  // copy the terms of another policy / customer into this policy (target-specific identifiers stay)
  function copyTermsDialog(po){
    const body = FC.el(`<div><p class="small" style="margin-top:0">Copies schedules, cargo types, zones, factors, map, war &amp; strikes exclusions and clause defaults into <b>${esc(polLabel(po))}</b>. <b>Never copied:</b> policy number, currency, limits, minimum premium, deductible and security.</p>
      <div class="field"><label for="ctFrom">Copy from</label><select id="ctFrom">${S.customers.map(c => `<optgroup label="${esc(c.name)}"><option value="c${c.id}">${esc(c.name)} - customer defaults</option>${S.policies.filter(x => x.customer_id === c.id && x.id !== po.id).map(x => `<option value="p${x.id}">Policy ${esc(polLabel(x))}</option>`).join('')}</optgroup>`).join('')}</select></div>
      <div class="field"><label for="ctWhy">Reason</label><input id="ctWhy" maxlength="300"></div><div class="err-msg" id="ctErr"></div></div>`);
    FC.dialog({ title:'Copy terms to ' + po.name, body, actions:[{ label:'Cancel', kind:'ghost', value:null }, { label:'Copy terms', kind:'primary', onClick: async (c, box) => {
      const why = box.querySelector('#ctWhy').value.trim(); if(why.length < 3) return void (box.querySelector('#ctErr').textContent = 'Please give a short reason.');
      const from = scParse(box.querySelector('#ctFrom').value);
      const { error } = await sb.rpc('admin_copy_config', { p_parts_j: ['schedules','cargo','zones','factors','map','war','clauses'], p_from_type: from.t, p_from_id: from.id, p_targets: [{ type:'policy', id: po.id }], p_items: null, p_reason: why });
      if(error) return void (box.querySelector('#ctErr').textContent = error.message);
      const src = from.t === 'policy' ? polOf(from.id) : null;
      if(src) await sb.from('policies').update({ rules: src.rules || {}, rating: src.rating }).eq('id', po.id);
      toast('Terms copied.'); await loadAll(); render(); return true; } }] });
  }
  // a policy without own data uses the customer defaults: say so, offer an own copy
  function inheritNote(host, part, label){
    const po = polOf(rScope.id), cu = scCust(rScope);
    const n = FC.el(`<div class="empty card"><h3>${esc(label)}: as the customer</h3><p>Policy ${esc(polLabel(po))} has no own ${esc(label.toLowerCase())}. It uses the customer defaults of <b>${esc(cu ? cu.name : '-')}</b>.</p><div class="toolbar" style="justify-content:center"></div></div>`);
    n.querySelector('.toolbar').appendChild(btn('Show the customer defaults', 'ghost', () => { rScope = { t:'customer', id: cu.id }; render(); }));
    n.querySelector('.toolbar').appendChild(btn('Create own ' + label.toLowerCase() + ' for this policy', 'primary', async b => {
      const why = await askReason('Policy ' + polLabel(po) + ' gets its own ' + label.toLowerCase() + ' (copy of the customer defaults of ' + cu.name + ').'); if(!why) return;
      busy(b, true); const { error } = await sb.rpc('admin_copy_config', { p_parts_j: [part], p_from_type:'customer', p_from_id: cu.id, p_targets: [{ type:'policy', id: po.id }], p_items: null, p_reason: why }); busy(b, false);
      if(error) return toast(error.message, 'error'); toast('Own ' + label.toLowerCase() + ' created.'); await loadAll(); render(); }));
    host.appendChild(n);
  }

  // =================================================================== CLAUSES
  // master library = general clause library; lists per level: one-off defaults, client defaults, policy defaults
  // (in a list a clause is active = pre-ticked, or standby = available but unticked; removing never deletes the clause)
  let CL_CAT = [['header','1 · Opening'],['general','2 · General conditions'],['subject_matter','3 · Subject-matter insured'],['special_cargo','4 · Special cargoes'],['special','5 · Special conditions'],
    ['expenses','6 · Expenses'],['contingency','7 · Contingency'],['claims','8 · Claims'],['administration','9 · Administration'],['sanctions','10 · Sanctions'],
    ['pricing','11 · Rate, minimum premium & deductible'],['disclaimer','12 · Disclaimer'],['subjectivity','13 · Subjectivities & warranties']];
  const catLabel = k => ((CL_CAT.find(x => x[0] === k) || [0, k])[1]).replace(/^\d+ · /, '');
  const catOrder = k => CL_CAT.findIndex(x => x[0] === k);
  // headings in the quotation document (Editor.pdf: bold + underlined); empty = no heading
  const DOC_HEAD = { header:'', general:'General Conditions:', subject_matter:'Subject-Matter Insured:', special_cargo:'Special Cargoes:', special:'Special Conditions:', expenses:'Expenses:',
    contingency:'Contingency:', claims:'Claims:', administration:'Administration:', sanctions:'Sanctions Clause:', pricing:'', disclaimer:'', subjectivity:'Subjectivities:' };
  // categories with the clause title printed above the wording
  const CAT_TITLES = new Set(['subject_matter','special_cargo','special','expenses','contingency','claims','administration']);
  // categories are editable (table clause_categories): order, names, headings
  function setCats(rows){
    if(!rows || !rows.length) return;
    const s2 = rows.slice().sort((a, b) => a.sort - b.sort || a.key.localeCompare(b.key));
    CL_CAT = s2.map((c, i) => [c.key, (i + 1) + ' · ' + c.label]);
    Object.keys(DOC_HEAD).forEach(k => delete DOC_HEAD[k]); s2.forEach(c => { DOC_HEAD[c.key] = c.doc_heading || ''; });
    CAT_TITLES.clear(); s2.filter(c => c.show_titles).forEach(c => CAT_TITLES.add(c.key));
  }
  const libClauses = () => S.clauses.filter(c => c.scope_type === 'one_off_general');
  // which list applies: the policy's own list, else the client's, else the one-off defaults
  const listLevel = (custId, polId) => {
    if(polId && S.polClauses.some(x => x.policy_id === polId)) return { t:'policy', id: polId };
    const cu = custId || (polId ? (polOf(polId) || {}).customer_id : null);
    if(cu && S.custClauses.some(x => x.customer_id === cu)) return { t:'customer', id: cu };
    return GEN;
  };
  const listRows = lv => lv.t === 'policy' ? S.polClauses.filter(x => x.policy_id === lv.id).map(x => ({ clause_id: x.clause_id, on: !!x.enabled, sort: x.sort || 100 }))
    : lv.t === 'customer' ? S.custClauses.filter(x => x.customer_id === lv.id).map(x => ({ clause_id: x.clause_id, on: !!x.enabled, sort: x.sort || 100 }))
    : libClauses().filter(c => c.oneoff_list).map(c => ({ clause_id: c.id, on: !!c.default_spot, sort: c.sort || 100 }));
  const byCat = (a, b) => catOrder(a.category) - catOrder(b.category);
  // the clauses of a context (active and standby), in document order
  const clausesFor = (custId, polId) => {
    const lv = listLevel(custId, polId), rows = listRows(lv), map = new Map(rows.map(r => [r.clause_id, r]));
    return S.clauses.filter(c => c.active && map.has(c.id)).sort((a, b) => byCat(a, b) || map.get(a.id).sort - map.get(b.id).sort || (a.sort || 0) - (b.sort || 0));
  };
  // is a clause pre-ticked (active) in the list of the context
  const clauseOn = (c, polId, custId) => { const r = listRows(listLevel(custId, polId)).find(x => x.clause_id === c.id); return !!(r && r.on); };
  A.clauseOn = clauseOn; A.clausesFor = clausesFor;
  let clScope = GEN, clTab = 'lists';
  // library warning: how many lists / quotations use a clause
  async function clauseUsage(ids){
    const out = { oneoff:0, customers:0, policies:0, quotations:0 };
    for(const id of ids){ const { data } = await sb.rpc('admin_clause_usage', { p_id: id }); if(data){ out.oneoff += data.oneoff ? 1 : 0; out.customers += Number(data.customers || 0); out.policies += Number(data.policies || 0); out.quotations += Number(data.quotations || 0); } }
    return out;
  }
  const usageText = u => `${u.oneoff ? 'the one-off defaults, ' : ''}${u.customers} client list${u.customers === 1 ? '' : 's'}, ${u.policies} policy list${u.policies === 1 ? '' : 's'}` + (u.quotations ? ` and ${u.quotations} quotation${u.quotations === 1 ? '' : 's'} already sent (those keep their wording)` : '');
  function seriousConfirm(title, html, choices){
    return FC.dialog({ title, body:`<div class="serious"><b>Serious change</b><div>${html}</div></div>`, actions:[{ label:'Cancel', kind:'ghost', value:null }].concat(choices.map(([label, value, kind]) => ({ label, kind: kind || 'danger', value }))) });
  }

  function renderClauses(body){
    body.innerHTML = (isStaffAdmin() ? '' : '<div class="notice" style="margin:0 0 12px"><b>Read only</b>The clause library and default lists are changed by staff admins.</div>') + `<p class="small muted" style="margin:0 0 14px">The <b>master clauses library</b> holds every wording. Each level has its own list: <b>General (one-offs)</b>, <b>client defaults</b> (also for clients without a policy) and <b>policy defaults</b>. In a list a clause is <b>active</b> (pre-ticked in quotations) or on <b>standby</b> (offered unticked). Removing a clause from a list never deletes it: drag it back from the library at any time.</p>
      <div class="tabs" role="tablist">${[['library','Master clauses library'],['categories','Categories'],['one_off_general','General (one-offs)'],['customer','Client defaults'],['policy','Policy defaults'],['templates','Text templates']].map(([k, l]) => `<button role="tab" data-cltab="${k}" aria-selected="${(['library','categories','templates'].includes(k) ? clTab === k : clTab === 'lists' && k === clScope.t)}">${l}</button>`).join('')}</div><div id="clBody"></div>`;
    $$('[data-cltab]', body).forEach(b => b.addEventListener('click', () => { const t = b.dataset.cltab;
      if(['library','categories','templates'].includes(t)) clTab = t;
      else { clTab = 'lists'; clScope = t === 'one_off_general' ? GEN : t === 'customer' ? { t, id: (scCust(clScope) || S.customers[0] || {}).id } : { t, id: clScope.t === 'policy' ? clScope.id : (S.policies.find(po => po.customer_id === (scCust(clScope) || {}).id) || S.policies[0] || {}).id }; }
      renderClauses(body); }));
    const host = $('#clBody', body);
    if(clTab === 'library') return renderLibrary(host);
    if(clTab === 'categories') return renderCategories(host);
    if(clTab === 'templates') return renderTemplates(host);
    renderList(host, clScope);
  }
  function renderLibrary(host){
    const rows = libClauses().slice().sort((a, b) => byCat(a, b) || (a.sort || 0) - (b.sort || 0));
    let catF = '';
    const bar = FC.el(`<div class="toolbar"><select class="input" id="lbCat" aria-label="Category" style="max-width:260px"><option value="">All categories (${rows.length})</option>${CL_CAT.map(([k]) => `<option value="${k}">${esc(catLabel(k))} (${rows.filter(c => c.category === k).length})</option>`).join('')}</select><span class="xs muted">Edits change the wording in every list that uses the clause; you are asked first.</span></div>`);
    host.appendChild(bar);
    const tblHost = FC.el('<div></div>'); host.appendChild(tblHost);
    const paint = () => { tblHost.innerHTML = ''; editTable(tblHost, { table:'clause_library', key:'id', search:true, keyOptional:true,
      rows: rows.filter(c => !catF || c.category === catF),
      add: () => ({ id: undefined, category: catF || 'special', title:'', body:'', maritime:false, air_only:false, active:true, sort:100 }),
      cols:[ { k:'category', l:'Category', type:'select', options: CL_CAT }, { k:'title', l:'Title', w:220 }, { k:'body', l:'Wording ({policy_no}, {assured}, {ref}, {currency} are filled in)', w:520 },
        { k:'maritime', l:'Sea only', type:'bool' }, { k:'air_only', l:'Air only', type:'bool' }, { k:'active', l:'Active', type:'bool' }, { k:'sort', l:'Sort', type:'num' } ],
      clean: r => Object.assign(r, { scope_type:'one_off_general', scope_id: null }),
      beforeSave: async payload => {
        const edited = payload.filter(x => x.id && ('body' in x || 'title' in x || 'category' in x || 'active' in x));
        if(!edited.length) return payload;
        const u = await clauseUsage(edited.map(x => x.id));
        if(!u.oneoff && !u.customers && !u.policies) return payload;
        const ch = await seriousConfirm('Change ' + edited.length + ' library clause' + (edited.length > 1 ? 's' : '') + '?', `Used in ${esc(usageText(u))}.<br>Update the wording in every linked list, or keep the linked lists on the old wording and save your text as a new library clause?`,
          [['Save as new clause', 'copy', 'ghost'], ['Update all linked lists', 'all', 'danger']]);
        if(!ch) return false;
        if(ch === 'all') return payload;
        // keep the linked lists on the old wording: the edited text becomes a new clause
        const keep = payload.filter(x => !edited.includes(x));
        for(const x of edited){ const o = S.clauses.find(c => c.id === x.id) || {}; const n = Object.assign({}, o, x); delete n.id; delete n.created_at; delete n.updated_at; n.title = (x.title && x.title !== o.title ? x.title : o.title + ' (rev.)'); n.oneoff_list = false; n.default_spot = false; keep.push(n); }
        return keep;
      },
      menu: r => r.id ? [
        ['Add to one-off defaults (active)', () => addToList(GEN, [r.id], true)], ['Add to one-off defaults (standby)', () => addToList(GEN, [r.id], false)],
        ['Copy to client…', () => copyDialog(['clauses'], GEN, { clauses:[r.id] }, { only:'customer' })], ['Copy to policy…', () => copyDialog(['clauses'], GEN, { clauses:[r.id] }, { only:'policy' })], '-',
        ['Delete from the library', () => deleteLibClauses([r]), 'danger']] : [],
      bulk:[ ['Add to one-off defaults (standby)', rs => addToList(GEN, rs.filter(r => r.id).map(r => r.id), false)], ['Copy to client…', rs => copyDialog(['clauses'], GEN, { clauses: rs.filter(r => r.id).map(r => r.id) }, { only:'customer' })],
        ['Copy to policy…', rs => copyDialog(['clauses'], GEN, { clauses: rs.filter(r => r.id).map(r => r.id) }, { only:'policy' })], ['Delete', rs => deleteLibClauses(rs.filter(r => r.id)), 'danger'] ] }); };
    bar.querySelector('#lbCat').addEventListener('change', e => { catF = e.target.value; srt.disabled = !catF || !isStaffAdmin(); paint(); });
    const srt = btn('Sort within category', 'ghost', () => catF && sortClausesDialog(catF)); srt.disabled = true; srt.title = 'Choose a category first'; bar.appendChild(srt);
    paint();
  }
  async function deleteLibClauses(rs){
    if(!rs.length) return;
    const u = await clauseUsage(rs.map(r => r.id));
    const ok = await seriousConfirm('Delete ' + (rs.length === 1 ? '“' + rs[0].title + '”' : rs.length + ' clauses') + ' from the library?', `${u.oneoff || u.customers || u.policies ? 'Used in ' + esc(usageText(u)) + '. It disappears from those lists as well.' : 'Not used in any list.'} Quotations already sent keep their wording. This cannot be undone - deactivating keeps the clause instead.`, [['Delete for good', true]]);
    if(!ok) return;
    const { error } = await sb.from('clause_library').delete().in('id', rs.map(r => r.id));
    if(error) return toast(error.message, 'error'); toast('Deleted.'); await loadAll(); render();
  }
  // add clauses to a list (active or standby)
  async function addToList(lv, ids, on){
    let error;
    if(lv.t === 'one_off_general') ({ error } = await sb.from('clause_library').update({ oneoff_list:true, default_spot: !!on }).in('id', ids));
    else{ const tbl = lv.t === 'customer' ? 'customer_clauses' : 'policy_clauses', col = lv.t === 'customer' ? 'customer_id' : 'policy_id';
      // a level without a list of its own starts from the list it inherited
      const inherited = listLevel(lv.t === 'customer' ? lv.id : (polOf(lv.id) || {}).customer_id, lv.t === 'policy' ? lv.id : null);
      const base = (inherited.t === lv.t && inherited.id === lv.id) ? [] : listRows(inherited).filter(x => !ids.includes(x.clause_id)).map(x => ({ [col]: lv.id, clause_id: x.clause_id, enabled: x.on, sort: x.sort }));
      ({ error } = await sb.from(tbl).upsert(base.concat(ids.map(id => ({ [col]: lv.id, clause_id: id, enabled: !!on, sort: 900 }))), { onConflict: col + ',clause_id' })); }
    if(error) return toast(error.message, 'error');
    toast(ids.length + ' clause' + (ids.length > 1 ? 's' : '') + ' added as ' + (on ? 'active' : 'standby') + '.'); await loadAll(); render();
  }
  // one list (one-offs / client / policy) next to the library drawer; drag and drop, reorder, active / standby, remove
  function renderList(host, sc){
    if(sc.t === 'customer' && !S.customers.length) return void (host.innerHTML = '<div class="empty card"><h3>No clients yet</h3><p>Add a client under Customers.</p></div>');
    if(sc.t === 'policy' && !S.policies.length) return void (host.innerHTML = '<div class="empty card"><h3>No policies yet</h3><p>Clients work without a policy too - use Client defaults.</p></div>');
    if(sc.t !== 'one_off_general' && (sc.id == null || (sc.t === 'customer' ? !custOf(sc.id) : !polOf(sc.id)))) sc.id = sc.t === 'customer' ? S.customers[0].id : S.policies[0].id;
    const custId = sc.t === 'customer' ? sc.id : sc.t === 'policy' ? polOf(sc.id).customer_id : null, polId = sc.t === 'policy' ? sc.id : null;
    const lv = sc.t === 'one_off_general' ? GEN : listLevel(custId, polId), own = sc.t === 'one_off_general' || (lv.t === sc.t && lv.id === sc.id);
    // working copy of the list
    let items = listRows(lv).map(r => Object.assign({ c: S.clauses.find(c => c.id === r.clause_id) }, r)).filter(x => x.c).sort((a, b) => byCat(a.c, b.c) || a.sort - b.sort);
    let dirty = false, addOn = true;
    const bar = FC.el(`<div class="toolbar">${sc.t === 'one_off_general' ? '<b>One-off defaults</b><span class="xs muted">used for every one-off quotation and standalone one-off</span>' : `<select class="input" id="clSel" aria-label="${sc.t === 'customer' ? 'Client' : 'Policy'}" style="max-width:340px">${sc.t === 'customer' ? S.customers.map(c => `<option value="${c.id}" ${c.id === sc.id ? 'selected' : ''}>${esc(c.name)} (${esc(COVER_T[c.cover_type])})</option>`).join('')
      : S.customers.map(c => { const ps = S.policies.filter(po => po.customer_id === c.id); return ps.length ? `<optgroup label="${esc(c.name)}">${ps.map(po => `<option value="${po.id}" ${po.id === sc.id ? 'selected' : ''}>${esc(polLabel(po))}</option>`).join('')}</optgroup>` : ''; }).join('')}</select>`}
      <span style="flex:1"></span><span class="acts"></span><button class="btn btn-primary btn-sm" id="clSave" disabled><span class="spin"></span>Save list</button></div>
      ${own ? '' : `<div class="notice" style="margin:0 0 10px">This ${sc.t === 'policy' ? 'policy' : 'client'} has no list of its own yet and uses the ${lv.t === 'customer' ? 'client defaults of ' + esc(custOf(lv.id).name) : 'one-off defaults'}. Saving creates its own list.</div>`}`);
    host.appendChild(bar);
    if(sc.t !== 'one_off_general'){
      bar.querySelector('.acts').appendChild(btn('Copy list to client…', 'ghost', () => copyDialog(['clauses'], sc, null, { only:'customer' })));
      bar.querySelector('.acts').appendChild(btn('Copy list to policy…', 'ghost', () => copyDialog(['clauses'], sc, null, { only:'policy' })));
      bar.querySelector('.acts').appendChild(btn('+ Own clause', 'ghost', () => ownClauseDialog(sc)));
      bar.querySelector('#clSel').addEventListener('change', e => { clScope = { t: sc.t, id: Number(e.target.value) }; render(); });
    } else bar.querySelector('.acts').appendChild(btn('Copy list to…', 'ghost', () => copyDialog(['clauses'], GEN, null)));
    const wrap = FC.el(`<div class="cl-split"><div class="cl-list" id="clList" aria-label="Clause list"></div>
      <aside class="cl-drawer card"><div class="cl-dh"><b>Master clauses library</b><span class="xs muted">Drag into the list, or use +</span></div>
        <div class="toolbar" style="margin:6px 0"><input class="input" type="search" id="ldQ" placeholder="Search wording" aria-label="Search the library"><select class="input" id="ldCat" aria-label="Category"><option value="">All</option>${CL_CAT.map(([k]) => `<option value="${k}">${esc(catLabel(k))}</option>`).join('')}</select></div>
        <div class="seg" id="ldOn" role="radiogroup" aria-label="Add as"><button type="button" data-v="1" aria-checked="true">Add as active</button><button type="button" data-v="0" aria-checked="false">Add as standby</button></div>
        <div class="cl-lib" id="ldList"></div></aside></div>`);
    host.appendChild(wrap);
    const listEl = wrap.querySelector('#clList'), libEl = wrap.querySelector('#ldList'), save = bar.querySelector('#clSave');
    const mark = () => { dirty = true; save.disabled = false; };
    const own2 = c => c.scope_type !== 'one_off_general' ? ' <span class="chip accepted">own</span>' : '';
    const paintList = () => {
      listEl.innerHTML = items.length ? '' : '<div class="cl-drop-empty">Drop clauses here</div>';
      CL_CAT.forEach(([cat]) => { const its = items.filter(x => x.c.category === cat); if(!its.length) return;
        const sec = FC.el(`<section class="cl-cat card" data-cat="${cat}"><h3>${esc(catLabel(cat))} <span class="xs muted">${its.filter(x => x.on).length} active · ${its.filter(x => !x.on).length} standby</span></h3></section>`);
        its.forEach(x => { const row = FC.el(`<div class="cl-row${x.on ? '' : ' standby'}" draggable="true" data-id="${x.c.id}"><span class="grip" aria-hidden="true">⠿</span><label class="cl-item"><input type="checkbox" ${x.on ? 'checked' : ''} aria-label="Active (pre-ticked)"><span><b>${esc(x.c.title)}</b>${x.c.maritime ? ' <span class="chip neutral">sea</span>' : ''}${x.c.air_only ? ' <span class="chip neutral">air</span>' : ''}${own2(x.c)} <span class="chip ${x.on ? 'approved' : 'pending'}">${x.on ? 'active' : 'standby'}</span><span>${esc(x.c.body.length > 260 ? x.c.body.slice(0, 260) + '…' : x.c.body)}</span></span></label><span class="cl-mv"><button type="button" class="btn btn-ghost btn-sm" data-mv="-1" aria-label="Move ${esc(x.c.title)} up">▲</button><button type="button" class="btn btn-ghost btn-sm" data-mv="1" aria-label="Move ${esc(x.c.title)} down">▼</button></span><button type="button" class="linkbtn cl-rm" aria-label="Remove ${esc(x.c.title)} from this list">Remove</button></div>`);
          row.querySelectorAll('[data-mv]').forEach(b => b.addEventListener('click', () => { const same = items.filter(y => y.c.category === x.c.category), i = same.indexOf(x), o = same[i + Number(b.dataset.mv)]; if(!o) return;
            const a1 = items.indexOf(x), a2 = items.indexOf(o); items[a1] = o; items[a2] = x; mark(); paintList(); }));
          row.querySelector('input').addEventListener('change', e => { x.on = e.target.checked; mark(); paintList(); });
          row.querySelector('.cl-rm').addEventListener('click', async () => { const ok = await FC.confirm('Remove from this list?', 'Are you sure you want to remove ' + x.c.title + ' from this list? Note: It will remain safely stored in the Master Clauses Library and can be dragged back at any time.', 'Remove', 'danger'); if(!ok) return; items = items.filter(y => y !== x); mark(); paintList(); paintLib(); });
          row.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', 'row:' + x.c.id); e.dataTransfer.effectAllowed = 'move'; row.classList.add('dragging'); });
          row.addEventListener('dragend', () => row.classList.remove('dragging'));
          sec.appendChild(row); });
        listEl.appendChild(sec); });
    };
    const inList = id => items.some(x => x.c.id === id);
    const paintLib = () => {
      const q = wrap.querySelector('#ldQ').value.trim().toLowerCase(), cat = wrap.querySelector('#ldCat').value;
      const pool = S.clauses.filter(c => c.active && (c.scope_type === 'one_off_general' || (c.scope_type === 'customer' && Number(c.scope_id) === custId) || (c.scope_type === 'policy' && Number(c.scope_id) === polId)))
        .filter(c => (!cat || c.category === cat) && (!q || (c.title + ' ' + c.body).toLowerCase().includes(q))).sort((a, b) => byCat(a, b) || (a.sort || 0) - (b.sort || 0));
      libEl.innerHTML = pool.length ? '' : '<p class="xs muted">No match.</p>';
      pool.slice(0, 300).forEach(c => { const there = inList(c.id); const it = FC.el(`<div class="cl-libitem${there ? ' in' : ''}" draggable="${!there}" data-id="${c.id}"><div><b>${esc(c.title)}</b>${own2(c)}<span class="xs muted">${esc(catLabel(c.category))}</span></div><button type="button" class="btn btn-ghost btn-sm" ${there ? 'disabled' : ''}>${there ? 'In list' : '+ Add'}</button></div>`);
        it.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', 'lib:' + c.id); e.dataTransfer.effectAllowed = 'copy'; });
        it.querySelector('button').addEventListener('click', () => addItem(c.id));
        libEl.appendChild(it); });
    };
    const addItem = (id, beforeId) => { if(inList(id)) return; const c = S.clauses.find(x => x.id === id); if(!c) return;
      const x = { c, clause_id: id, on: addOn, sort: 0 }; const i = beforeId ? items.findIndex(y => y.c.id === beforeId) : -1; i >= 0 ? items.splice(i, 0, x) : items.push(x);
      mark(); paintList(); paintLib(); toast(c.title + ' added as ' + (addOn ? 'active' : 'standby') + ' - save the list to keep it.'); };
    // drop: from the library (add) or within the list (reorder)
    listEl.addEventListener('dragover', e => { e.preventDefault(); listEl.classList.add('over'); });
    listEl.addEventListener('dragleave', e => { if(!listEl.contains(e.relatedTarget)) listEl.classList.remove('over'); });
    listEl.addEventListener('drop', e => { e.preventDefault(); listEl.classList.remove('over');
      const [kind, sid] = String(e.dataTransfer.getData('text/plain')).split(':'), id = Number(sid), tgt = e.target.closest('.cl-row'), before = tgt ? Number(tgt.dataset.id) : null;
      if(kind === 'lib') return addItem(id, before);
      if(kind === 'row' && before && before !== id){ const from = items.findIndex(y => y.c.id === id), x = items.splice(from, 1)[0]; const to = items.findIndex(y => y.c.id === before); items.splice(to, 0, x); mark(); paintList(); } });
    wrap.querySelector('#ldQ').addEventListener('input', paintLib); wrap.querySelector('#ldCat').addEventListener('change', paintLib);
    wrap.querySelector('#ldOn').addEventListener('click', e => { const b = e.target.closest('button'); if(!b) return; addOn = b.dataset.v === '1'; wrap.querySelectorAll('#ldOn button').forEach(x => x.setAttribute('aria-checked', String(x === b))); });
    paintList(); paintLib();
    save.addEventListener('click', async () => {
      // order inside each category = order on screen
      const seq = {}; items.forEach(x => { seq[x.c.category] = (seq[x.c.category] || 0) + 10; x.sort = seq[x.c.category]; });
      let applyAll = false;
      if(sc.t === 'customer' && S.policies.some(po => po.customer_id === sc.id)){
        const ch = await FC.dialog({ title:'Apply to the policies too?', body:'<p style="margin-top:0">Do you want to reflect and apply these default clause changes across all existing policies of this customer?</p>',
          actions:[{ label:'Cancel', kind:'ghost', value:null }, { label:'No, save as customer default only', kind:'ghost', value:'no' }, { label:'Yes, update all policies of this customer', kind:'primary', value:'yes' }] });
        if(!ch) return; applyAll = ch === 'yes';
      }
      busy(save, true);
      let error = null;
      if(sc.t === 'one_off_general'){
        const keep = new Set(items.map(x => x.c.id));
        const rm = libClauses().filter(c => c.oneoff_list && !keep.has(c.id)).map(c => c.id);
        if(rm.length) ({ error } = await sb.from('clause_library').update({ oneoff_list:false, default_spot:false }).in('id', rm));
        for(const x of items){ if(error) break; ({ error } = await sb.from('clause_library').update({ oneoff_list:true, default_spot: x.on, sort: (catOrder(x.c.category) + 1) * 1000 + x.sort }).eq('id', x.c.id)); }
      }else{
        const tbl = sc.t === 'customer' ? 'customer_clauses' : 'policy_clauses', col = sc.t === 'customer' ? 'customer_id' : 'policy_id';
        const write = async id => { let r = await sb.from(tbl).delete().eq(col, id); if(r.error) return r.error;
          if(items.length){ r = await sb.from(tbl).insert(items.map(x => ({ [col]: id, clause_id: x.c.id, enabled: x.on, sort: x.sort }))); if(r.error) return r.error; } return null; };
        error = await write(sc.id);
        if(!error && applyAll){ for(const po of S.policies.filter(p => p.customer_id === sc.id)){ const r1 = await sb.from('policy_clauses').delete().eq('policy_id', po.id); if(r1.error){ error = r1.error; break; }
          if(items.length){ const r2 = await sb.from('policy_clauses').insert(items.map(x => ({ policy_id: po.id, clause_id: x.c.id, enabled: x.on, sort: x.sort }))); if(r2.error){ error = r2.error; break; } } } }
      }
      busy(save, false);
      if(error) return toast('Could not save: ' + error.message, 'error');
      toast(applyAll ? 'Saved for the client and all its policies.' : 'List saved.'); await loadAll(); render();
    });
  }
  // ---------------- categories: add, rename, describe, delete, reorder ----------------
  const catSlug = label => { let k = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'category'; if(!/^[a-z]/.test(k)) k = 'c_' + k; let x = k, i = 2; while(S.categories.some(c => c.key === x)) x = k + '_' + i++; return x; };
  function renderCategories(host){
    const adm = isStaffAdmin(), cats = S.categories.slice().sort((a, b) => a.sort - b.sort || a.key.localeCompare(b.key));
    let order = cats.map(c => c.key);
    const bar = FC.el(`<div class="toolbar"><span class="small muted">The order here is the order of the sections in every quotation, clause list and template. Drag a row or use the arrows.</span><span style="flex:1"></span></div>`);
    if(adm) bar.appendChild(btn('+ Add category', 'primary', () => categoryDialog()));
    host.appendChild(bar);
    const list = FC.el('<div class="cat-list" aria-label="Categories"></div>'); host.appendChild(list);
    const cnt = k => S.clauses.filter(c => c.category === k).length;
    const persist = async () => { const { error } = await sb.rpc('admin_sort_categories', { p_keys: order }); if(error) return toast(error.message, 'error'); toast('Order saved.'); await loadAll(); render(); };
    const move = (i, dlt) => { const j = i + dlt; if(j < 0 || j >= order.length) return; [order[i], order[j]] = [order[j], order[i]]; paint(); persist(); };
    const paint = () => { list.innerHTML = '';
      order.forEach((k, i) => { const c = cats.find(x => x.key === k);
        const row = FC.el(`<div class="cat-row card" draggable="${adm}" data-key="${esc(k)}"><span class="grip" aria-hidden="true">⠿</span><span class="cat-no">${i + 1}</span>
          <div class="cat-main"><b>${esc(c.label)}</b>${c.system ? ' <span class="chip neutral">used by the quotation logic</span>' : ''}${c.show_titles ? ' <span class="chip neutral">titles shown</span>' : ''}
          <span class="xs muted">${c.description ? esc(c.description) + ' · ' : ''}${c.doc_heading ? 'heading “' + esc(c.doc_heading) + '” · ' : 'no heading · '}${cnt(k)} clause${cnt(k) === 1 ? '' : 's'}</span></div><span class="cat-acts"></span></div>`);
        if(adm){ const a = row.querySelector('.cat-acts');
          const up = btn('▲', 'ghost', () => move(i, -1)), dn = btn('▼', 'ghost', () => move(i, 1)); up.setAttribute('aria-label', 'Move ' + c.label + ' up'); dn.setAttribute('aria-label', 'Move ' + c.label + ' down'); up.disabled = i === 0; dn.disabled = i === order.length - 1;
          a.appendChild(up); a.appendChild(dn); a.appendChild(btn('Sort clauses', 'ghost', () => sortClausesDialog(k))); a.appendChild(btn('Edit', 'ghost', () => categoryDialog(c)));
          if(!c.system) a.appendChild(btn('Delete', 'danger', () => deleteCategory(c)));
          row.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', 'cat:' + k); row.classList.add('dragging'); });
          row.addEventListener('dragend', () => row.classList.remove('dragging')); }
        list.appendChild(row); }); };
    list.addEventListener('dragover', e => { if(adm) e.preventDefault(); });
    list.addEventListener('drop', e => { e.preventDefault(); const [kind, k] = String(e.dataTransfer.getData('text/plain')).split(':'); if(kind !== 'cat') return;
      const tgt = e.target.closest('.cat-row'); if(!tgt || tgt.dataset.key === k) return; order.splice(order.indexOf(k), 1); order.splice(order.indexOf(tgt.dataset.key), 0, k); paint(); persist(); });
    paint();
  }
  function categoryDialog(c){
    const body = FC.el(`<div><div class="grid2"><div class="field"><label for="ctLabel">Name</label><input id="ctLabel" maxlength="80" value="${esc(c ? c.label : '')}"></div>
      <div class="field"><label for="ctHead">Heading in the quotation <span class="muted">(empty = none)</span></label><input id="ctHead" maxlength="80" value="${esc(c ? c.doc_heading || '' : '')}" placeholder="e.g. Special Conditions:"></div></div>
      <div class="field"><label for="ctDesc">Description</label><input id="ctDesc" maxlength="300" value="${esc(c ? c.description || '' : '')}"></div>
      <label class="switch"><input type="checkbox" id="ctTitles" ${c && c.show_titles ? 'checked' : ''}><span><b>Show clause titles</b><span>The title is printed bold and underlined above each wording (Editor.pdf).</span></span></label><div class="err-msg" id="ctErr"></div></div>`);
    FC.dialog({ title: c ? 'Edit category' : 'New category', body, actions:[{ label:'Cancel', kind:'ghost', value:null }, { label:'Save', kind:'primary', onClick: async () => {
      const v = id => body.querySelector(id).value.trim(), label = v('#ctLabel'); if(!label) return void (body.querySelector('#ctErr').textContent = 'Name required.');
      const row = { label, doc_heading: v('#ctHead'), description: v('#ctDesc') || null, show_titles: body.querySelector('#ctTitles').checked, updated_at: new Date().toISOString() };
      const res = c ? await sb.from('clause_categories').update(row).eq('key', c.key) : await sb.from('clause_categories').insert(Object.assign(row, { key: catSlug(label), sort: Math.max(0, ...S.categories.map(x => x.sort)) + 10 }));
      if(res.error) return void (body.querySelector('#ctErr').textContent = res.error.message);
      toast('Saved.'); await loadAll(); render(); return true; } }] });
  }
  async function deleteCategory(c){
    const n = S.clauses.filter(x => x.category === c.key).length, ids = S.clauses.filter(x => x.category === c.key).map(x => x.id);
    const u = ids.length ? await clauseUsage(ids) : { oneoff:0, customers:0, policies:0, quotations:0 };
    const others = S.categories.filter(x => x.key !== c.key).sort((a, b) => a.sort - b.sort);
    const body = FC.el(`<div><div class="serious"><b>Serious change</b><div>The category “${esc(c.label)}” holds ${n} clause${n === 1 ? '' : 's'}${u.oneoff || u.customers || u.policies ? ', used in ' + esc(usageText(u)) : ''}. Quotations already sent keep their wording.</div></div>
      ${n ? `<div class="field" style="margin-top:12px"><label for="dcMove">What happens to its clauses</label><select id="dcMove">${others.map(o => `<option value="${esc(o.key)}" ${o.key === 'special' ? 'selected' : ''}>Move them to “${esc(o.label)}”</option>`).join('')}<option value="">Delete them together with the category</option></select></div>` : ''}</div>`);
    const ok = await FC.dialog({ title:'Delete the category “' + c.label + '”?', body, actions:[{ label:'Cancel', kind:'ghost', value:null }, { label:'Delete category', kind:'danger', onClick: async () => {
      const mv = n ? body.querySelector('#dcMove').value : '';
      if(n && !mv && !(await FC.confirm('Delete ' + n + ' clause(s) for good?', 'They disappear from every list that uses them. This cannot be undone.', 'Delete for good', 'danger'))) return;
      const { error } = await sb.rpc('admin_delete_category', { p_key: c.key, p_move_to: mv || null });
      if(error){ toast(error.message, 'error'); return; } return true; } }] });
    if(ok){ toast('Category deleted.'); await loadAll(); render(); }
  }
  // free sorting of the master library inside one category (drag or arrows)
  function sortClausesDialog(cat){
    let items = libClauses().filter(c => c.category === cat).sort((a, b) => (a.sort || 0) - (b.sort || 0) || a.id - b.id);
    const box = FC.el(`<div><p class="small muted" style="margin-top:0">Drag or use the arrows. The order is used in the library, the one-off defaults and new lists.</p><div class="sort-list" id="soList"></div></div>`);
    const L = box.querySelector('#soList');
    const paint = () => { L.innerHTML = '';
      items.forEach((c, i) => { const row = FC.el(`<div class="sort-row" draggable="true" data-id="${c.id}"><span class="grip" aria-hidden="true">⠿</span><span class="so-t"><b>${esc(c.title)}</b><span class="xs muted">${esc(c.body.slice(0, 110))}${c.body.length > 110 ? '…' : ''}</span></span>
          <button type="button" class="btn btn-ghost btn-sm" data-mv="-1" aria-label="Move up" ${i ? '' : 'disabled'}>▲</button><button type="button" class="btn btn-ghost btn-sm" data-mv="1" aria-label="Move down" ${i < items.length - 1 ? '' : 'disabled'}>▼</button></div>`);
        row.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', 'so:' + c.id); });
        L.appendChild(row); }); };
    L.addEventListener('click', e => { const b = e.target.closest('[data-mv]'); if(!b) return; const id = Number(b.closest('.sort-row').dataset.id), i = items.findIndex(x => x.id === id), j = i + Number(b.dataset.mv); if(j < 0 || j >= items.length) return; [items[i], items[j]] = [items[j], items[i]]; paint(); });
    L.addEventListener('dragover', e => e.preventDefault());
    L.addEventListener('drop', e => { e.preventDefault(); const [k, sid] = String(e.dataTransfer.getData('text/plain')).split(':'); if(k !== 'so') return; const t = e.target.closest('.sort-row'); if(!t) return; const id = Number(sid), to = Number(t.dataset.id); if(id === to) return;
      const x = items.splice(items.findIndex(z => z.id === id), 1)[0]; items.splice(items.findIndex(z => z.id === to), 0, x); paint(); });
    paint();
    FC.dialog({ title:'Sort clauses · ' + catLabel(cat), wide:true, body: box, actions:[{ label:'Cancel', kind:'ghost', value:null }, { label:'Save order', kind:'primary', onClick: async () => {
      const { error } = await sb.rpc('admin_sort_clauses', { p_level:'library', p_id: null, p_ids: items.map(c => c.id) }); if(error){ toast(error.message, 'error'); return; }
      toast('Order saved.'); await loadAll(); render(); return true; } }] });
  }

  // ---------------- text templates (configuration -> client -> policy) ----------------
  const TPL_KINDS = [['quotation','Quotation wording'],['client_text','E-mail text to the client'],['insurer_text','Text to insurer'],['certificate_agreements','Certificate: additional agreements']];
  const TPL_HELP = { quotation:'Builds the wording of a new quotation. [[clauses]] puts in the active clauses of the list, [[category:...]] one category, [[clause:...]] one clause, [[pricing]] the rate / premium block. Each block on its own line.',
    client_text:'Used by “Copy text for customer”. [[quotation]] puts in the quotation (rate and premium as the display mode allows).',
    insurer_text:'Used by “Text to insurer”. [[shipment_details]] puts in the structured risk details.',
    certificate_agreements:'Pre-fills “Additional agreements” on new certificates (plain text).' };
  let tplScope = GEN, tplKind = 'quotation';
  const FMT_FONTS = ['Calibri','Arial','Helvetica','Cambria','Georgia','Times New Roman','Verdana','Tahoma'];
  function renderTemplates(host){
    const adm = isStaffAdmin();
    if(tplScope.t !== 'one_off_general' && !(tplScope.t === 'customer' ? custOf(tplScope.id) : polOf(tplScope.id))) tplScope = GEN;
    const lid = tplScope.t === 'one_off_general' ? null : tplScope.id;
    const custId = tplScope.t === 'customer' ? tplScope.id : tplScope.t === 'policy' ? (polOf(tplScope.id) || {}).customer_id : null, polId = tplScope.t === 'policy' ? tplScope.id : null;
    const own = tplRow(tplKind, tplScope.t, lid), eff = own || tplFor(tplKind, custId, polId);
    const fromTxt = x => !x ? 'nothing (empty)' : x.scope_type === 'one_off_general' ? 'the configuration (general)' : x.scope_type === 'customer' ? 'client ' + ((custOf(x.scope_id) || {}).name || '') : 'policy ' + polLabel(polOf(x.scope_id));
    const fOwn = fmtRow(tplScope.t, lid), fEff = fmtFor(custId, polId);
    const blocks = (tplKind === 'quotation' ? '<optgroup label="Blocks"><option value="[[clauses]]">All active clauses of the list</option><option value="[[pricing]]">Rate, premium &amp; deductible block</option><option value="free">Free-text block (box)</option></optgroup>'
        : `<optgroup label="Blocks">${tplKind === 'client_text' ? '<option value="[[quotation]]">The quotation</option>' : ''}${tplKind === 'insurer_text' ? '<option value="[[shipment_details]]">Shipment details</option>' : ''}<option value="free">Free-text block (box)</option></optgroup>`)
      + `<optgroup label="Categories (all active clauses)">${CL_CAT.filter(([k]) => k !== 'pricing' || tplKind === 'quotation').map(([k]) => `<option value="cat:${esc(k)}">${esc(catLabel(k))}</option>`).join('')}</optgroup>`
      + CL_CAT.map(([k]) => { const cs = S.clauses.filter(c => c.category === k && c.active && (c.scope_type === 'one_off_general' || (custId && c.scope_type === 'customer' && Number(c.scope_id) === custId) || (polId && c.scope_type === 'policy' && Number(c.scope_id) === polId))); return cs.length ? `<optgroup label="${esc(catLabel(k))}">${cs.map(c => `<option value="clause:${c.id}">${esc(c.title)}</option>`).join('')}</optgroup>` : ''; }).join('');
    host.innerHTML = `<div class="toolbar"><label class="xs" for="tpScope">Level</label><select class="input" id="tpScope" style="max-width:360px">${scopeOptions(tplScope)}</select>
        <div class="seg" id="tpKind" role="radiogroup" aria-label="Template">${TPL_KINDS.map(([k, l]) => `<button type="button" data-v="${k}" aria-checked="${k === tplKind}">${esc(l)}</button>`).join('')}</div></div>
      <div class="notice ${own ? 'ok' : 'info'}" style="margin:0 0 10px"><b>${own ? 'Own template of this level' : 'Inherited'}</b>${own ? 'Used for this level and everything below it that has no template of its own.' : 'This level uses the template of ' + esc(fromTxt(eff)) + '. Saving creates its own template.'} ${esc(TPL_HELP[tplKind])}</div>
      <div class="tpl-grid"><div class="card tpl-card">${rtBarHtml({ fields:true, blocks })}<div class="qe-doc tpl-ed" id="tpEd" contenteditable="${adm}" spellcheck="true" aria-label="Template text"></div>
          <div class="toolbar" style="margin:10px 0 0" id="tpActs"></div><div class="err-msg" id="tpErr"></div></div>
        <aside class="card tpl-fmt"><h3>Default formatting</h3><p class="xs muted" style="margin:0 0 8px">${fOwn ? 'Own setting of this level.' : 'Inherited - saving creates an own setting.'} Applied when quotations are shown, copied to the clipboard and printed as PDF.</p>
          <div class="field"><label for="tfFam">Font family</label><select id="tfFam">${FMT_FONTS.map(f => `<option ${f === fEff.font_family ? 'selected' : ''}>${f}</option>`).join('')}</select></div>
          <div class="grid2"><div class="field"><label for="tfSize">Size (pt)</label><input id="tfSize" inputmode="decimal" value="${esc(fEff.font_size_pt)}"></div><div class="field"><label for="tfLh">Line height</label><input id="tfLh" inputmode="decimal" value="${esc(fEff.line_height)}"></div>
          <div class="field"><label for="tfSp">Paragraph spacing (pt)</label><input id="tfSp" inputmode="decimal" value="${esc(fEff.paragraph_spacing_pt)}"></div><div class="field"><label for="tfCol">Text colour</label><input id="tfCol" type="color" value="${esc(fEff.text_color)}"></div></div>
          <div class="toolbar" id="tfActs" style="margin:6px 0 0"></div><div class="err-msg" id="tfErr"></div></aside></div>
      <details class="tpl-tags"><summary>Merge fields</summary><p class="small">${FC.MERGE_TAGS.map(([k, l]) => `<code>{{${k}}}</code> ${esc(l)}`).join(' · ')}</p></details>`;
    const ed = $('#tpEd', host); ed.innerHTML = FC.cleanHtml(eff ? eff.body : '');
    const fmtNow = () => ({ font_family: $('#tfFam', host).value, font_size_pt: FC.parseNum($('#tfSize', host).value), line_height: FC.parseNum($('#tfLh', host).value), paragraph_spacing_pt: FC.parseNum($('#tfSp', host).value), text_color: $('#tfCol', host).value });
    const paintFmt = () => { const f = fmtNow(); if(f.font_size_pt > 0 && f.line_height > 0){ ed.style.cssText = FC.fmtCss(f); ed.style.setProperty('--para', (f.paragraph_spacing_pt || 0) + 'pt'); } };
    paintFmt(); host.querySelector('.tpl-fmt').addEventListener('input', paintFmt); host.querySelector('.tpl-fmt').addEventListener('change', paintFmt);
    const clauseText = c => `<p>${CAT_TITLES.has(c.category) ? '<b><u>' + esc(c.title) + '</u></b><br>' : ''}${esc(c.body).replace(/\n/g, '<br>')}</p>`;
    wireRt(host.querySelector('.rt-bar'), ed, { onBlock: (v, insert) => {
      if(v === 'free') return insert('<p class="box">Free text</p>');
      if(/^\[\[/.test(v)) return insert('<p>' + esc(v) + '</p>');
      const [k, id] = v.split(':');
      if(tplKind === 'quotation') return insert('<p>' + esc(k === 'cat' ? '[[category:' + id + ']]' : '[[clause:' + id + ']]') + '</p>');
      const list = k === 'cat' ? clausesFor(custId, polId).filter(c => c.category === id && clauseOn(c, polId, custId)) : S.clauses.filter(c => c.id === Number(id));
      insert(list.map(clauseText).join('') || '<p></p>');
    } });
    $('#tpScope', host).addEventListener('change', e => { tplScope = scParse(e.target.value); render(); });
    $('#tpKind', host).addEventListener('click', e => { const b = e.target.closest('button'); if(!b) return; tplKind = b.dataset.v; render(); });
    if(!adm){ host.querySelectorAll('.rt-bar button, .rt-bar select, .rt-bar input, .tpl-fmt input, .tpl-fmt select').forEach(x => x.disabled = true); return; }
    const acts = $('#tpActs', host);
    acts.appendChild(btn('Save template', 'primary', async b => {
      const html = FC.dash(FC.cleanHtml(ed.innerHTML)); busy(b, true);
      const row = { body: html, updated_by: me().id, updated_at: new Date().toISOString(), active: true };
      const res = own ? await sb.from('text_templates').update(row).eq('id', own.id) : await sb.from('text_templates').insert(Object.assign(row, { scope_type: tplScope.t, scope_id: lid, kind: tplKind, name: (TPL_KINDS.find(k => k[0] === tplKind) || [0, 'Template'])[1] }));
      busy(b, false); if(res.error) return void ($('#tpErr', host).textContent = res.error.message);
      toast('Template saved for ' + scName(tplScope) + '.'); await loadAll(); render(); }));
    acts.appendChild(btn('Preview with a case', 'ghost', () => {
      const r = S.rows.find(x => (polId ? x.policy_id === polId : custId ? x.customer_id === custId : true)) || S.rows[0] || {};
      const html = FC.merge(FC.cleanHtml(ed.innerHTML), mergeCtx(r, {}));
      FC.dialog({ title:'Preview' + (r.ref ? ' · ' + r.ref : ''), wide:true, body:`<div class="qe-doc" style="${esc(FC.fmtCss(fmtNow()))}">${html}</div><p class="xs muted">Blocks in [[...]] are filled in when the template is used.</p>`, actions:[{ label:'Close', kind:'primary', value:true }] });
    }));
    if(own && tplScope.t !== 'one_off_general') acts.appendChild(btn('Remove own template', 'danger', async () => {
      if(!(await FC.confirm('Remove the own template?', 'This level then uses the template of the level above again.', 'Remove', 'danger'))) return;
      const { error } = await sb.from('text_templates').delete().eq('id', own.id); if(error) return toast(error.message, 'error'); await loadAll(); render(); }));
    const fa = $('#tfActs', host);
    fa.appendChild(btn('Save formatting', 'primary', async b => {
      const f = fmtNow(), err = t => { $('#tfErr', host).textContent = t; };
      if(!(f.font_size_pt >= 6 && f.font_size_pt <= 24)) return err('Size between 6 and 24 pt.'); if(!(f.line_height >= 1 && f.line_height <= 3)) return err('Line height between 1 and 3.'); if(!(f.paragraph_spacing_pt >= 0 && f.paragraph_spacing_pt <= 40)) return err('Paragraph spacing between 0 and 40 pt.');
      busy(b, true);
      let qy = fOwn ? sb.from('text_formatting').update(Object.assign({ updated_at: new Date().toISOString() }, f)).eq('scope_type', tplScope.t) : null;
      if(qy) qy = lid == null ? qy.is('scope_id', null) : qy.eq('scope_id', lid);
      const res = qy ? await qy : await sb.from('text_formatting').insert(Object.assign({ scope_type: tplScope.t, scope_id: lid }, f));
      busy(b, false); if(res.error) return err(res.error.message);
      toast('Formatting saved.'); await loadAll(); render(); }));
    if(fOwn && tplScope.t !== 'one_off_general') fa.appendChild(btn('Use the level above', 'ghost', async () => {
      const { error } = await sb.from('text_formatting').delete().eq('scope_type', tplScope.t).eq('scope_id', lid); if(error) return toast(error.message, 'error'); await loadAll(); render(); }));
  }

  function ownClauseDialog(sc){
    const body = FC.el(`<div><div class="grid2"><div class="field"><label for="ocCat">Category</label><select id="ocCat">${CL_CAT.map(([k]) => `<option value="${k}" ${k === 'special' ? 'selected' : ''}>${esc(catLabel(k))}</option>`).join('')}</select></div>
      <div class="field"><label for="ocTitle">Title</label><input id="ocTitle" maxlength="200"></div></div><div class="field"><label for="ocBody">Wording</label><textarea id="ocBody" rows="6"></textarea></div>
      <label class="switch"><input type="checkbox" id="ocOn" checked><span><b>Active (pre-ticked)</b><span>Off: standby.</span></span></label><div class="err-msg" id="ocErr"></div></div>`);
    FC.dialog({ title:'Own clause · ' + scName(sc), wide:true, body, actions:[{ label:'Cancel', kind:'ghost', value:null }, { label:'Add', kind:'primary', onClick: async () => {
      const t = body.querySelector('#ocTitle').value.trim(), w = body.querySelector('#ocBody').value.trim(); if(!t || !w) return void (body.querySelector('#ocErr').textContent = 'Title and wording required.');
      const r = await sb.from('clause_library').insert({ scope_type: sc.t, scope_id: sc.id, category: body.querySelector('#ocCat').value, title: t, body: w, oneoff_list:false, active:true, sort:100 }).select();
      if(r.error) return void (body.querySelector('#ocErr').textContent = r.error.message);
      await addToList(sc, [r.data[0].id], body.querySelector('#ocOn').checked); return true; } }] });
  }

  // ---- zone map: only for open covers / policies with zoning (zones per scope) ----
  const ZC = {
    air: ['#1F3F8F','#F2D33C','#D2B48C','#F08F7A','#1F7A7A','#A59F94','#E03131','#2F6B2F','#E0A82E','#B5C26A','#4A7FD6','#45C45A'],
    sea: ['#1F3F8F','#F2D33C','#D63FA0','#A4D65E','#A59F94','#D2B48C','#F08F7A','#5FD3B8','#B9A5E6','#5E3C99','#D9B44A','#2F6B2F','#E03131','#B07D2B','#4A7FD6','#F2B6D0','#45C45A','#E2734E','#FFE14D']
  };
  let mapMode = 'sea', mapUnlocked = false, mapGeo = null;
  const mapPending = {};
  async function mapData(){
    if(mapGeo) return mapGeo;
    if(!window.d3 || !window.d3.geoEqualEarth){ await FC.loadScript('assets/geo/d3-array.min.js'); await FC.loadScript('assets/geo/d3-geo.min.js'); }
    if(!window.d3.zoom) await FC.loadScript('assets/geo/d3-zoom.min.js');
    const [shapes, pts, places] = await Promise.all(['assets/geo/countries-110m.json', 'assets/geo/country-points.json', 'assets/geo/places.json'].map(u => fetch(u).then(r => r.json()).catch(() => null)));
    mapGeo = { shapes: shapes || [], pts: pts || {}, places: places || {} };
    return mapGeo;
  }
  async function zonesOf(sc){ const { data, error } = await scoped(sb.from('country_zones').select('*'), sc); if(error) toast(error.message, 'error'); return data || []; }
  async function rtMap(host){
    const sc = rScope, cu = scCust(sc);
    const emptyNote = (h, t) => { host.innerHTML = `<div class="empty card"><h3>${esc(h)}</h3><p>${t}</p></div>`; };
    if(sc.t === 'one_off_general') return emptyNote('No zone map for one-offs', 'The zone map is generated for open covers and policies with zoning. Choose a customer or policy above. One-off zones are edited in <b>Countries &amp; zones</b>.');
    if(cu && cu.cover_type === 'one_off') return emptyNote('No zone map for this customer', esc(cu.name) + ' is a one-off customer and is rated from the general one-off pool.');
    host.innerHTML = '<div class="empty">Loading the map…</div>';
    let cz = await zonesOf(sc);
    if(!cz.length){ host.innerHTML = ''; if(sc.t === 'policy') return inheritNote(host, 'zones', 'Zones'); return emptyNote('No zoning configured', esc(cu.name) + ' has no country zones yet. Use <b>Copy / Apply to…</b> from the general pool or another customer, or set zones in Countries &amp; zones.'); }
    const tables = S.rateTables.filter(t => inScope(t, sc) || (sc.t === 'policy' && !S.rateTables.some(x => inScope(x, sc)) && inScope(t, { t:'customer', id: cu.id })));
    if(!tables.some(t => t.mode === mapMode)) mapMode = tables.some(t => t.mode === 'sea') ? 'sea' : 'air';
    if(!tables.length) return emptyNote('No schedules in this scope', 'The map shows the zones of the sea and air schedules. Add or copy schedules first.');
    const G = await mapData(), d3 = window.d3;
    const zm = S.zoneMaps.find(z => inScope(z, sc) && z.mode === mapMode) || { colors:{}, labels:{} };
    const zoneColor = z => (zm.colors || {})[z] || ZC[mapMode][z - 1] || `hsl(${(z * 47) % 360} 55% 55%)`;
    const zoneLabel = z => (zm.labels || {})[z] || '';
    const zones = Math.max(...tables.filter(t => t.mode === mapMode).map(t => t.zones), 1);
    const byIso = {}; S.countries.forEach(c => byIso[c.iso2] = c);
    const zrow = {}; cz.forEach(r => zrow[r.iso2] = r);
    const zoneOf = c => { const k = c.iso2 + '|' + mapMode; const r = zrow[c.iso2] || {}; return k in mapPending ? mapPending[k] : (mapMode === 'sea' ? r.sea_zone : r.air_zone); };
    const comp = c => (zrow[c.iso2] || {}).compliance || 'ok';
    const W = 960, H = 470, proj = d3.geoEqualEarth().fitExtent([[8, 8], [W - 8, H - 8]], { type:'Sphere' }), path = d3.geoPath(proj);
    const drawn = new Set(G.shapes.map(f => f.t));
    // blocked and sanctioned countries are white like the excluded ones, whatever zone they still carry
    const fill = c => { const z = c ? zoneOf(c) : null; return z && comp(c) !== 'blocked' && !c.sanctioned ? zoneColor(z) : '#FFFFFF'; };
    const pending = Object.keys(mapPending).filter(k => k.endsWith('|' + mapMode)).length;
    const unassigned = S.countries.filter(c => !zoneOf(c) && comp(c) !== 'blocked' && !c.sanctioned);
    const count = {}; S.countries.forEach(c => { const z = zoneOf(c); if(z) count[z] = (count[z] || 0) + 1; });
    const portPt = name => { for(const cc of Object.keys(G.places)){ const p = G.places[cc].find(x => x[0].toLowerCase() === name.toLowerCase()); if(p) return [p[2], p[1]]; } return null; };
    const coastPins = S.warAreas.filter(a => a.kind === 'coast').map(a => { const pt = (a.ports || []).map(portPt).find(Boolean); return pt ? { a, xy: proj(pt) } : null; }).filter(Boolean);
    const zMax = m => Math.max(...tables.filter(t => t.mode === m).map(t => t.zones), 0);
    host.innerHTML = `<div class="toolbar"><div class="seg" id="mpMode">${zMax('sea') ? `<button type="button" data-v="sea" aria-checked="${mapMode === 'sea'}">Sea · ${zMax('sea')} zones</button>` : ''}${zMax('air') ? `<button type="button" data-v="air" aria-checked="${mapMode === 'air'}">Air · ${zMax('air')} zones</button>` : ''}</div>
        <span class="xs muted">${esc(scName(sc))}</span><span style="flex:1"></span>
        ${mapUnlocked ? `<button class="btn btn-ghost btn-sm" id="mpLbl" type="button">Labels &amp; colours</button><button class="btn btn-ghost btn-sm" id="mpAdd" type="button">+ Add zone</button><button class="btn btn-ghost btn-sm" id="mpDel" type="button">Remove zone ${zones}</button><button class="btn btn-ghost btn-sm" id="mpLock" type="button">Lock</button><button class="btn btn-primary btn-sm" id="mpSave" type="button" ${pending ? '' : 'disabled'}><span class="spin"></span>Save ${pending || ''} change${pending === 1 ? '' : 's'}</button>`
          : `<span class="chip neutral">🔒 Locked</span><button class="btn btn-ghost btn-sm" id="mpUnlock" type="button">Unlock to edit</button>`}</div>
      <div class="map-wrap card"><div class="zm-zoom" role="group" aria-label="Zoom"><button type="button" data-zm="in" aria-label="Zoom in">+</button><button type="button" data-zm="out" aria-label="Zoom out">-</button><button type="button" data-zm="reset" aria-label="Reset zoom">Reset</button></div>
        <svg viewBox="0 0 ${W} ${H}" class="zmap" role="img" aria-label="${mapMode} zone map"><g class="zm-g">
        <path d="${path({ type:'Sphere' })}" class="zm-sea"></path>
        ${G.shapes.map(f => { const c = byIso[f.t]; return `<path d="${path(f.g)}" data-iso="${f.t}" fill="${fill(c)}" class="zm-c${c && (!zoneOf(c) || comp(c) === 'blocked') ? ' ex' : ''}"></path>`; }).join('')}
        ${S.countries.filter(c => !drawn.has(c.iso2) && G.pts[c.iso2]).map(c => { const xy = proj([G.pts[c.iso2][1], G.pts[c.iso2][0]]); return xy ? `<circle cx="${xy[0].toFixed(1)}" cy="${xy[1].toFixed(1)}" r="3.2" data-iso="${c.iso2}" fill="${fill(c)}" class="zm-c zm-dot${zoneOf(c) ? '' : ' ex'}"></circle>` : ''; }).join('')}
        ${S.countries.filter(c => comp(c) === 'local' && (G.shapes.find(f => f.t === c.iso2) || G.pts[c.iso2])).map(c => { const f = G.shapes.find(x => x.t === c.iso2); const xy = f ? path.centroid(f.g) : proj([G.pts[c.iso2][1], G.pts[c.iso2][0]]); return xy && isFinite(xy[0]) ? `<text x="${xy[0].toFixed(1)}" y="${(xy[1] + 6).toFixed(1)}" class="zm-star">*</text>` : ''; }).join('')}
        ${coastPins.map(p => { const short = ({ sa_west:'SA West', sa_east:'SA East', ae_gulf:'UAE Gulf', ae_oman:'UAE Oman' })[p.a.code] || p.a.name, left = /west/.test(p.a.code); return `<g class="zm-pin" transform="translate(${p.xy[0].toFixed(1)},${p.xy[1].toFixed(1)})"><circle r="4"></circle><text x="${left ? -7 : 7}" y="${left ? 3 : -4}" text-anchor="${left ? 'end' : 'start'}">${esc(short)}</text><title>${esc(p.a.name)}</title></g>`; }).join('')}
      </g></svg><div class="zm-tip" hidden></div></div>
      <div class="map-side">
        <div class="zm-legend">${Array.from({ length: zones }, (_, i) => i + 1).map(z => `<span class="zm-key"><i style="background:${zoneColor(z)}"></i>Zone ${z}${zoneLabel(z) ? ' · ' + esc(zoneLabel(z)) : ''}<b>${count[z] || 0}</b></span>`).join('')}<span class="zm-key"><i class="ex"></i>Excluded / unassigned</span><span class="zm-key"><i class="star">*</i>Compliance check (licensing)</span><span class="zm-key"><i class="pin"></i>Coast split (war &amp; strikes)</span></div>
        ${unassigned.length ? `<div class="al-row al-orange" style="margin-top:12px"><i></i><span><b>${unassigned.length} countr${unassigned.length > 1 ? 'ies' : 'y'} without a ${mapMode} zone</b> (not blocked) - no automatic rate, always quoted individually: ${esc(unassigned.slice(0, 40).map(c => c.name).join(', '))}${unassigned.length > 40 ? ' …' : ''}</span></div>` : ''}
        ${mapUnlocked ? '<p class="xs muted" style="margin:10px 0 0">Click a country to move it to another zone. Changes are saved together with one reason.</p>' : '<p class="xs muted" style="margin:10px 0 0">Scroll or use + / - to zoom, drag to pan. Hover a country for its zone, status and notes.</p>'}
        ${auditFoot('zones', scEntity(sc), 4)}
      </div>`;
    // zoom & pan (d3.zoom), buttons + / - / Reset
    const svg = host.querySelector('svg'), g = svg.querySelector('.zm-g');
    const zb = d3.zoom().scaleExtent([1, 12]).translateExtent([[0, 0], [W, H]]).on('zoom', ev => { g.setAttribute('transform', ev.transform); g.style.setProperty('--k', ev.transform.k); });
    const sel = d3.select(svg).call(zb);
    $$('[data-zm]', host).forEach(b => b.addEventListener('click', () => { const k = b.dataset.zm; const t = sel.transition().duration(FC.reduced && FC.reduced() ? 0 : 250);
      if(k === 'reset') zb.transform(t, d3.zoomIdentity); else zb.scaleBy(t, k === 'in' ? 1.6 : 1 / 1.6); }));
    // rich hover: name, zone and label, status, notes
    const tip = host.querySelector('.zm-tip'), wrapEl = host.querySelector('.map-wrap');
    const status = c => { if(c.sanctioned) return ['Excluded · sanctioned', 'red']; if(comp(c) === 'blocked') return ['Excluded · blocked', 'red']; if(comp(c) === 'local') return ['Compliance check · licensing / local insurers', 'amber']; if(comp(c) === 'hold') return ['Compliance check · hold covered (refer)', 'yellow']; return zoneOf(c) ? ['Active', 'ok'] : ['Unassigned · quoted individually', 'orange']; };
    svg.addEventListener('mousemove', e => {
      const el = e.target.closest('[data-iso]'), c = el && byIso[el.dataset.iso];
      if(!c){ tip.hidden = true; return; }
      const z = zoneOf(c), st = status(c), notes = [(zrow[c.iso2] || {}).note, c.note, S.warAreas.filter(a => a.country === c.iso2 || (a.countries || []).includes(c.iso2)).map(a => 'War & strikes area: ' + a.name).join('; ')].filter(Boolean);
      tip.innerHTML = `<b>${esc(c.name)}</b><span class="zt-z">${z ? `<i style="background:${zoneColor(z)}"></i>Zone ${z}${zoneLabel(z) ? ' · ' + esc(zoneLabel(z)) : ''}` : 'No ' + mapMode + ' zone'}${(c.iso2 + '|' + mapMode) in mapPending ? ' <em>(unsaved)</em>' : ''}</span><span class="zt-st st-${st[1]}">${esc(st[0])}</span>${notes.length ? '<span class="zt-n">' + notes.map(esc).join('<br>') + '</span>' : ''}`;
      tip.hidden = false;
      const r = wrapEl.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      tip.style.left = Math.min(x + 14, r.width - tip.offsetWidth - 6) + 'px'; tip.style.top = (y + 16 + tip.offsetHeight > r.height ? y - tip.offsetHeight - 10 : y + 16) + 'px';
    });
    svg.addEventListener('mouseleave', () => { tip.hidden = true; });
    $$('#mpMode button', host).forEach(b => b.addEventListener('click', () => { mapMode = b.dataset.v; rtMap(host); }));
    const re = () => rtMap(host);
    if($('#mpUnlock', host)) $('#mpUnlock', host).addEventListener('click', () => { mapUnlocked = true; re(); });
    if($('#mpLock', host)) $('#mpLock', host).addEventListener('click', () => { mapUnlocked = false; Object.keys(mapPending).forEach(k => delete mapPending[k]); re(); });
    if($('#mpLbl', host)) $('#mpLbl', host).addEventListener('click', async () => {
      const body = FC.el(`<div><p class="xs muted" style="margin-top:0">${esc(scName(sc))} · ${mapMode}. Labels show in the legend and in the hover header.</p><div class="zm-lbls">${Array.from({ length: zones }, (_, i) => i + 1).map(z => `<label><span>Zone ${z}</span><input type="color" data-c="${z}" value="${zoneColor(z).startsWith('#') ? zoneColor(z) : '#888888'}"><input data-l="${z}" maxlength="60" value="${esc(zoneLabel(z))}" placeholder="e.g. Northern Europe"></label>`).join('')}</div></div>`);
      const ok = await FC.dialog({ title:'Zone labels & colours', wide:true, body, actions:[{ label:'Cancel', kind:'ghost', value:null }, { label:'Save', kind:'primary', onClick: async () => {
        const colors = {}, labels = {}; body.querySelectorAll('[data-c]').forEach(i => { if(i.value.toUpperCase() !== String(ZC[mapMode][i.dataset.c - 1] || '').toUpperCase()) colors[i.dataset.c] = i.value; }); body.querySelectorAll('[data-l]').forEach(i => { if(i.value.trim()) labels[i.dataset.l] = i.value.trim(); });
        const row = { scope_type: sc.t, scope_id: sc.id, mode: mapMode, colors, labels, updated_at: new Date().toISOString() };
        const r = zm.id ? await sb.from('zone_maps').update(row).eq('id', zm.id) : await sb.from('zone_maps').insert(row);
        if(r.error){ toast(r.error.message, 'error'); return; } return true; } }] });
      if(ok){ toast('Saved.'); await loadAll(); re(); }
    });
    const zoneCount = async action => {
      const reason = await askReason(action === 'add' ? `Add ${mapMode} zone ${zones + 1} to every ${mapMode} schedule of ${scName(sc)} (its rates start empty = on request).` : `Remove ${mapMode} zone ${zones} in ${scName(sc)}: its countries become unassigned and its rates are deleted.`);
      if(!reason) return;
      const { error } = await sb.rpc('admin_zone_count', { p_mode: mapMode, p_action: action, p_reason: reason, p_scope_type: sc.t, p_scope_id: sc.id });
      if(error) return toast(error.message, 'error'); toast('Done and logged.'); await loadAll(); re();
    };
    if($('#mpAdd', host)) $('#mpAdd', host).addEventListener('click', () => zoneCount('add'));
    if($('#mpDel', host)) $('#mpDel', host).addEventListener('click', () => zoneCount('remove'));
    if($('#mpSave', host)) $('#mpSave', host).addEventListener('click', async e => {
      const keys = Object.keys(mapPending).filter(k => k.endsWith('|' + mapMode));
      const rows = keys.map(k => { const iso = k.split('|')[0], r = zrow[iso] || {}; return { iso2: iso, sea_zone: mapMode === 'sea' ? mapPending[k] : r.sea_zone, air_zone: mapMode === 'air' ? mapPending[k] : r.air_zone }; });
      const reason = await askReason(scName(sc) + ': ' + rows.map(x => byIso[x.iso2].name + ' → ' + (mapPending[x.iso2 + '|' + mapMode] || 'unassigned')).join(', '));
      if(!reason) return;
      busy(e.currentTarget, true);
      const { error } = await sb.rpc('admin_set_zones', { p_rows: rows, p_reason: reason, p_scope_type: sc.t, p_scope_id: sc.id });
      if(error){ busy(e.currentTarget, false); return toast(error.message, 'error'); }
      keys.forEach(k => delete mapPending[k]); toast('Zones saved and logged.'); await loadAll(); re();
    });
    svg.addEventListener('click', async e => {
      const el = e.target.closest('[data-iso]'); if(!el || !mapUnlocked) return;
      const c = byIso[el.dataset.iso]; if(!c) return;
      const z = await FC.dialog({ title: c.name + ' - ' + mapMode + ' zone', body:`<div class="zm-pick">${Array.from({ length: zones }, (_, i) => i + 1).map(n => `<button type="button" data-z="${n}" class="${zoneOf(c) === n ? 'on' : ''}"><i style="background:${zoneColor(n)}"></i>${n}${zoneLabel(n) ? ' ' + esc(zoneLabel(n)) : ''}</button>`).join('')}<button type="button" data-z="0" class="${!zoneOf(c) ? 'on' : ''}"><i class="ex"></i>Excluded / unassigned</button></div>`,
        actions:[{ label:'Cancel', kind:'ghost', value:null }], onOpen: (box, close) => box.querySelectorAll('[data-z]').forEach(b => b.addEventListener('click', () => close(Number(b.dataset.z)))) });
      if(z == null) return;
      const r = zrow[c.iso2] || {}, orig = mapMode === 'sea' ? r.sea_zone : r.air_zone, k = c.iso2 + '|' + mapMode;
      if((z || null) === (orig || null)) delete mapPending[k]; else mapPending[k] = z || null;
      re();
    });
  }

  // ---- war & strikes: shared area definitions, exclusions and buy-back per scope ----
  function rtWar(host){
    const sc = rScope;
    host.appendChild(FC.el(`<p class="small muted" style="margin:0 0 12px">Areas where war &amp; strikes cover is lifted. A coast is matched by the port typed in the shipment (no or unknown port = every coast of that country counts). A sea is matched by its ports, its littoral countries, a transit country, or routing via Suez. The rate is never reduced; a buy-back loading (less no-claims bonus) gives a second rate with war &amp; strikes re-included.</p>`));
    const card = FC.el(`<div><h3 style="margin:0 0 8px">Exclusions and buy-back terms · ${esc(scName(sc))}</h3><div class="toolbar"><span class="xs muted">${sc.t === 'policy' ? 'Policy exclusions apply in addition to the customer defaults.' : sc.t === 'customer' ? 'Apply to every policy of the customer.' : 'Apply to one-off indications.'}</span><span style="flex:1"></span><button class="btn btn-ghost btn-sm" type="button" id="wxAdd">Add exclusion</button><button class="btn btn-primary btn-sm" type="button" id="wxSave" disabled><span class="spin"></span>Save changes</button></div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Area</th><th>Buy-back gross ‰</th><th>NCB %</th><th>Net ‰</th><th>Active</th><th>Note</th><th class="km"></th></tr></thead><tbody id="wxBody"></tbody></table></div>
      <p class="xs muted">Example: +0.35 % gross = 3.5 ‰, less 50 % NCB = 1.75 ‰ net (0.175 %). Empty buy-back = no terms; the case then shows "no buy-back terms set".</p></div>`);
    host.appendChild(card);
    const rows = S.warEx.filter(x => inScope(x, sc)).map(x => Object.assign({}, x)), removed = [];
    const tb = card.querySelector('#wxBody'), save = card.querySelector('#wxSave');
    const net = x => x.buyback_permille == null || x.buyback_permille === '' ? '-' : pm(Number(x.buyback_permille) * (1 - Number(x.ncb_pct || 0) / 100));
    const paint = () => {
      tb.innerHTML = rows.map((x, i) => `<tr data-i="${i}"><td><select data-k="area_code">${S.warAreas.map(a => `<option value="${esc(a.code)}" ${a.code === x.area_code ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></td>
        <td><input data-k="buyback_permille" inputmode="decimal" value="${x.buyback_permille == null ? '' : pm(x.buyback_permille)}" style="width:90px"></td>
        <td><input data-k="ncb_pct" inputmode="decimal" value="${esc(x.ncb_pct ?? 0)}" style="width:70px"></td><td class="num">${net(x)}</td>
        <td><input type="checkbox" data-k="active" ${x.active !== false ? 'checked' : ''} style="width:auto;min-width:0"></td>
        <td><input data-k="note" value="${esc(x.note || '')}" style="min-width:160px"></td><td class="km"></td></tr>`).join('') || '<tr><td colspan="7" class="muted small">No exclusions in this scope.</td></tr>';
      tb.querySelectorAll('tr[data-i]').forEach(tr => { const i = +tr.dataset.i; tr.querySelector('.km').appendChild(kebab([
        ['Copy to…', () => { if(!rows[i].id) return toast('Save first.', 'error'); copyDialog(['war'], sc, null); }],
        ['Remove', () => { const x = rows.splice(i, 1)[0]; if(x.id) removed.push(x.id); save.disabled = false; paint(); }, 'danger']])); });
    };
    const onWx = e => { const tr = e.target.closest('tr'), k = e.target.dataset.k; if(!tr || !k) return; const x = rows[+tr.dataset.i];
      x[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; x.__dirty = true; save.disabled = false;
      if(k === 'buyback_permille' || k === 'ncb_pct'){ const v = { buyback_permille: x.buyback_permille === '' ? null : ppm(x.buyback_permille), ncb_pct: FC.parseNum(x.ncb_pct) }; tr.children[3].textContent = net(v); } };
    tb.addEventListener('input', onWx); tb.addEventListener('change', onWx);
    card.querySelector('#wxAdd').addEventListener('click', () => { if(!S.warAreas.length) return toast('Add an area first.', 'error'); rows.push({ area_code: S.warAreas[0].code, buyback_permille:null, ncb_pct:0, active:true, note:'', __dirty:true }); save.disabled = false; paint(); });
    save.addEventListener('click', async () => {
      const dirty = rows.filter(x => x.__dirty);
      for(const x of dirty){ const bb = x.buyback_permille === '' || x.buyback_permille == null ? null : ppm(x.buyback_permille), ncb = FC.parseNum(x.ncb_pct);
        if((bb != null && !(bb >= 0)) || !(ncb >= 0 && ncb <= 100)) return toast('Buy-back must be a number in ‰, NCB between 0 and 100 %.', 'error'); }
      busy(save, true);
      for(const id of removed){ const { error } = await sb.from('war_exclusions').delete().eq('id', id); if(error){ busy(save, false); return toast(error.message, 'error'); } }
      for(const x of dirty){
        const bb = x.buyback_permille === '' || x.buyback_permille == null ? null : (typeof x.buyback_permille === 'number' ? x.buyback_permille : ppm(x.buyback_permille));
        const row = { scope_type: sc.t, scope_id: sc.id, group_id: null, policy_id: null, area_code: x.area_code, buyback_permille: bb, ncb_pct: FC.parseNum(x.ncb_pct) || 0, active: x.active !== false, note: (x.note || '').trim() || null, updated_at: new Date().toISOString() };
        const { error } = x.id ? await sb.from('war_exclusions').update(row).eq('id', x.id) : await sb.from('war_exclusions').insert(row);
        if(error){ busy(save, false); return toast(error.message, 'error'); }
      }
      busy(save, false); toast('Saved.'); await loadAll(); render();
    });
    paint();
    host.appendChild(FC.el('<h3 style="margin:26px 0 8px">Areas (shared definitions for every scope)</h3>'));
    editTable(host, { table:'war_areas', key:'code', search:false,
      rows: S.warAreas.map(a => Object.assign({}, a, { countries: (a.countries || []).join(', '), ports: (a.ports || []).join(', ') })),
      add: () => ({ code:'', name:'', kind:'coast', country:'', countries:'', ports:'', sort:100 }),
      cols:[ { k:'code', l:'Code', ro:true, w:90 }, { k:'name', l:'Name (shown to clients)', w:240 }, { k:'kind', l:'Type', type:'select', options:[['coast', 'Coast of a country'], ['sea', 'Sea']] },
        { k:'country', l:'Country (coast)', w:60 }, { k:'countries', l:'Littoral countries (sea)', w:150 }, { k:'ports', l:'Ports / places', w:360 }, { k:'note', l:'Note (hover on the map)', w:200 }, { k:'sort', l:'Sort', type:'num' } ],
      menu: r => r.code && !r.__new ? [['Delete area', () => delRowKey('war_areas', 'code', r.code, 'Delete the area ' + r.name + '?', 'Exclusions for this area are removed in every scope.'), 'danger']] : [],
      clean: r => { ['countries','ports'].forEach(k => { if(k in r) r[k] = String(r[k] || '').split(',').map(x => x.trim()).filter(Boolean).map(x => k === 'countries' ? x.toUpperCase() : x); }); if('country' in r) r.country = (r.country || '').toUpperCase() || null; if('code' in r) r.code = String(r.code || '').toLowerCase().replace(/[^a-z0-9_]/g, '_'); return r; } });
  }
  async function delRowKey(table, key, val, title, text){
    if(!(await FC.confirm(title, text, 'Delete', 'danger'))) return false;
    const { error } = await sb.from(table).delete().eq(key, val);
    if(error){ toast('Could not delete: ' + error.message, 'error'); return false; }
    toast('Deleted.'); await loadAll(); render(); return true;
  }
  function rtLog(host){
    if(!S.audit.length){ host.innerHTML = '<div class="empty card"><h3>No changes yet</h3><p>Changes to schedules, zones and copies are listed here with date, user and reason.</p></div>'; return; }
    const what = a => { const m = /^(one_off_general|customer|policy)(?::(\d+))?$/.exec(a.entity_id || ''); const sc = m ? { t: m[1], id: m[2] ? Number(m[2]) : null } : null;
      return (a.entity === 'zones' ? 'Zones' : a.entity === 'copy' ? 'Copy' : a.entity === 'user' ? 'User' : 'Schedule') + (sc ? ' · ' + scName(sc) : a.entity_id && a.entity !== 'user' ? ' · ' + a.entity_id : ''); };
    host.innerHTML = `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Date</th><th>User</th><th>What</th><th>Change</th><th>Reason</th></tr></thead><tbody>${S.audit.map(a => `<tr><td class="xs">${esc(FC.dateTime(a.at))}</td><td>${esc(a.user_name || '')}</td><td class="small">${esc(what(a))}</td><td class="small" style="max-width:520px">${esc(a.summary)}</td><td class="small">${esc(a.reason || '')}</td></tr>`).join('')}</tbody></table></div>`;
  }
  const COPY_PART = { tables:['schedules'], commodities:['cargo'], countries:['zones'], factors:['factors'], map:['zones','map'], war:['war'] };
  function renderRates(body){
    if(rScope.t !== 'one_off_general' && !(rScope.t === 'customer' ? custOf(rScope.id) : polOf(rScope.id))) rScope = GEN;
    const sc = rScope, cu = scCust(sc);
    const hint = sc.t === 'one_off_general' ? 'One-off indications and quotations of every client without a policy, and out-of-cover shipments. Never used for open covers.'
      : sc.t === 'customer' ? 'Defaults for every policy of ' + cu.name + ' (' + COVER_T[cu.cover_type] + '). Never used for one-offs or other customers.'
      : 'Own terms of this policy; parts without own data use the customer defaults of ' + (cu ? cu.name : '') + '.';
    const ro = isStaffAdmin() ? '' : '<div class="notice" style="margin:0 0 12px"><b>Read only</b>Rates, zones and configurations are changed by staff admins.</div>';
    body.innerHTML = ro + `<div class="scope-bar card"><div class="field" style="margin:0"><label for="rsScope">Configuration of</label><select class="input" id="rsScope">${scopeOptions(sc)}</select></div><p class="xs muted" style="margin:0;flex:1">${esc(hint)}</p><span id="rsCopy"></span></div>
      <div class="tabs" role="tablist">${[['tables','Schedules'],['commodities','Cargo types'],['countries','Countries & zones'],['factors','Factors & limits'],['map','Zone map'],['war','War & strikes areas'],['test','Test a calculation'],['log','Change log']].map(([k, l]) => `<button role="tab" data-rtab="${k}" aria-selected="${k === rateTab}">${l}</button>`).join('')}</div><div id="rtBody"></div>`;
    $$('[data-rtab]', body).forEach(b => b.addEventListener('click', () => { rateTab = b.dataset.rtab; renderRates(body); }));
    $('#rsScope', body).addEventListener('change', e => { rScope = scParse(e.target.value); Object.keys(mapPending).forEach(k => delete mapPending[k]); renderRates(body); });
    if(COPY_PART[rateTab]) $('#rsCopy', body).appendChild(btn('Copy / Apply to…', 'ghost', () => copyDialog(COPY_PART[rateTab], sc, null)));
    if(rateTab !== 'log' && rateTab !== 'test') $('#rsCopy', body).appendChild(btn('Copy everything to…', 'ghost', () => copyDialog(['schedules','cargo','zones','factors','map','war','clauses'], sc, null)));
    const host = $('#rtBody', body);
    ({ tables: rtTables, commodities: rtCommodities, countries: rtCountries, factors: rtFactors, test: rtTest, log: rtLog, war: rtWar, map: rtMap })[rateTab](host);
  }
  // generic editable table - o.menu(row) adds a ⋮ menu, o.bulk adds checkboxes and a bulk toolbar
  function editTable(host, o){
    const wrap = FC.el('<div class="edit-tbl"></div>'); host.appendChild(wrap);
    let unlocked = false;
    const tbar = FC.el(`<div class="toolbar">${o.search ? '<input class="input" type="search" placeholder="Search" aria-label="Search">' : ''}<span class="spacer" style="flex:1"></span>${o.lock ? `<span class="chip neutral" data-lockchip>🔒 ${esc(o.lock.label)} locked</span><button class="btn btn-ghost btn-sm" type="button" data-unlock>Unlock ${esc(o.lock.label)}</button>` : ''}${o.add ? '<button class="btn btn-ghost btn-sm" type="button" data-add>Add row</button>' : ''}<button class="btn btn-primary btn-sm" type="button" data-save disabled><span class="spin"></span>Save changes</button></div>`);
    wrap.appendChild(tbar);
    if(o.tools) o.tools(tbar);
    const sel = new Set();
    const bar = FC.el('<div class="bulkbar" hidden><b></b><span class="bk-acts"></span><button type="button" class="linkbtn">Clear selection</button></div>'); wrap.appendChild(bar);
    (o.bulk || []).forEach(([label, fn, kind]) => bar.querySelector('.bk-acts').appendChild(btn(label, kind || 'ghost', async b => { const rs = rows.filter(r => sel.has(r)); if(!rs.length) return; busy(b, true); try{ await fn(rs); }finally{ if(b.isConnected) busy(b, false); } })));
    bar.querySelector('.linkbtn').addEventListener('click', () => { sel.clear(); paint(); });
    const paintBar = () => { bar.hidden = !sel.size; bar.querySelector('b').textContent = sel.size + ' selected'; };
    if(o.lock) tbar.querySelector('[data-unlock]').addEventListener('click', e => { unlocked = !unlocked; e.currentTarget.textContent = (unlocked ? 'Lock ' : 'Unlock ') + o.lock.label; tbar.querySelector('[data-lockchip]').hidden = unlocked; paint(); });
    const tw = FC.el('<div class="tbl-wrap"></div>'); wrap.appendChild(tw);
    const dirty = new Map();
    const rows = o.rows.map(r => Object.assign({}, r));
    const cell = (r, c) => {
      const v = r[c.k];
      if(c.fixed) return c.html ? c.html(r) : esc(v == null ? '' : v);
      if(c.type === 'bool') return `<input type="checkbox" data-k="${c.k}" ${v ? 'checked' : ''} aria-label="${esc(c.l)}" style="width:auto;min-width:0">`;
      if(c.type === 'select') return `<select data-k="${c.k}" aria-label="${esc(c.l)}" ${o.lock && !unlocked && o.lock.cols.includes(c.k) ? 'disabled' : ''}>${c.options.map(([ov, ol]) => `<option value="${esc(ov)}" ${String(ov) === String(v == null ? '' : v) ? 'selected' : ''}>${esc(ol)}</option>`).join('')}</select>`;
      if(c.type === 'covers') return ['icc_a','icc_b','icc_c'].map(x => `<label class="xs" style="white-space:nowrap;margin-right:6px"><input type="checkbox" data-k="${c.k}" data-v="${x}" ${(v || []).includes(x) ? 'checked' : ''} style="width:auto;min-width:0"> ${x.slice(-1).toUpperCase()}</label>`).join('');
      if(c.ro && !r.__new) return esc(v == null ? '' : v);
      return `<input data-k="${c.k}" value="${esc(v == null ? '' : v)}" ${c.type === 'num' ? 'inputmode="decimal"' : ''} aria-label="${esc(c.l)}" style="${c.w ? 'min-width:' + c.w + 'px' : ''}">`;
    };
    let shown = [];
    const paint = () => {
      const s = tbar.querySelector('input[type=search]') ? tbar.querySelector('input[type=search]').value.trim().toLowerCase() : '';
      shown = rows.filter(r => !s || o.cols.some(c => String(r[c.k] == null ? '' : r[c.k]).toLowerCase().includes(s)));
      tw.innerHTML = `<table class="tbl"><thead><tr>${o.bulk ? '<th class="cb"><input type="checkbox" class="sl-all" aria-label="Select all"></th>' : ''}${o.cols.map(c => `<th>${esc(c.l)}</th>`).join('')}${o.menu ? '<th class="km"></th>' : ''}</tr></thead><tbody></tbody></table>`;
      shown.forEach(r => {
        const tr = document.createElement('tr'); tr.innerHTML = (o.bulk ? `<td class="cb"><input type="checkbox" class="sl-row" aria-label="Select" ${sel.has(r) ? 'checked' : ''}></td>` : '') + o.cols.map(c => `<td>${cell(r, c)}</td>`).join('') + (o.menu ? '<td class="km"></td>' : ''); tr.__row = r;
        if(o.menu){ const items = o.menu(r); if(items && items.length) tr.querySelector('td.km').appendChild(kebab(() => o.menu(r))); }
        const cb = tr.querySelector('.sl-row'); if(cb) cb.addEventListener('change', e => { e.stopPropagation(); cb.checked ? sel.add(r) : sel.delete(r); paintBar(); });
        tr.addEventListener('input', e => onEdit(tr, e)); tr.addEventListener('change', e => onEdit(tr, e));
        tw.querySelector('tbody').appendChild(tr);
      });
      const all = tw.querySelector('.sl-all'); if(all){ all.checked = shown.length && shown.every(r => sel.has(r)); all.addEventListener('change', () => { shown.forEach(r => all.checked ? sel.add(r) : sel.delete(r)); paint(); }); }
      paintBar();
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
      let payload = Array.from(dirty.values()).map(r => { let x = {}; o.cols.forEach(c => { if(!c.virtual && !c.fixed && r[c.k] !== undefined) x[c.k] = r[c.k]; }); (o.carry || []).forEach(k => { if(r[k] !== undefined) x[k] = r[k]; }); x[o.key] = r[o.key]; if(o.clean) x = o.clean(x, r); return x; });
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
  // the rate breakdown in words, used in the case, the test tab and New quotation
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
      return t + ' · min. premium ' + (d.min_premium != null ? money2(d.min_premium, d.currency) : '-');
    }
    const parts = [['class', d.f_class], ['cover', d.f_cover], ['conveyance', d.f_conveyance], ['packing', d.f_packing], ['on deck', d.f_deck], ['theft', d.f_theft], ['extra', d.f_loading]]
      .filter(([, v]) => v != null && Number(v) !== 1).map(([k, v]) => k + ' ' + pm(v));
    const route = d.mode === 'land' ? 'land ' + String(d.band || '').replace('_', '-') : 'zone ' + d.zone_from + ' → ' + d.zone_to;
    return `${d.table_name}, ${route}: base ${pm(d.base_permille)} ‰${parts.length ? ' × ' + parts.join(' × ') : ''} = ${pm(d.cargo_permille)} ‰${Number(d.hssc_permille) ? ' + HSSC ' + pm(d.hssc_permille) + ' ‰' : ''}${Number(d.liw_permille) ? ' + LiW/DiW ' + pm(d.liw_permille) + ' ‰' : ''} + ${d.mode === 'land' ? 'strikes' : 'war'} ${pm(d.war_permille)} ‰${Number(d.crisis_permille) ? ' + crisis ' + pm(d.crisis_permille) + ' ‰' : ''}${Number(d.f_interest) !== 1 ? ', × interest ' + pm(d.f_interest) : ''} = ${pm(d.rate_permille)} ‰`;
  }
  // step-by-step rate breakdown as table rows (New quotation)
  function breakdownRows(d){
    if(!d) return [];
    const r = [];
    if(d.scheme === 'open_cover'){
      r.push(['Schedule', `${d.table_name || ''}, zone ${d.zone_from} → ${d.zone_to}`, pm(d.schedule_permille) + ' ‰']);
      if(Number(d.war_included_permille)) r.push(['incl. war & strikes', 'part of the schedule, not deducted', pm(d.war_included_permille) + ' ‰']);
      [['ICC (C) factor', d.f_cover], ['On deck', d.f_deck], ['Loading', d.f_loading]].forEach(([k, v]) => { if(v != null && Number(v) !== 1) r.push([k, '× ' + pm(v), '']); });
      if(d.cargo_permille != null) r.push(['Cargo rate', '', pm(d.cargo_permille) + ' ‰']);
    }else{
      r.push(['Base rate', d.mode === 'land' ? 'land ' + String(d.band || '').replace('_', '-') : `${d.table_name || ''}, zone ${d.zone_from} → ${d.zone_to}`, pm(d.base_permille) + ' ‰']);
      [['Cargo class', d.f_class], ['Cover', d.f_cover], ['Conveyance', d.f_conveyance], ['Packing', d.f_packing], ['On deck', d.f_deck], ['Theft (land)', d.f_theft], ['Extra loading', d.f_loading]].forEach(([k, v]) => { if(v != null && Number(v) !== 1) r.push([k, '× ' + pm(v), '']); });
      r.push(['Cargo rate', '', pm(d.cargo_permille) + ' ‰']);
    }
    [['HSSC', d.hssc_permille], ['LiW / DiW', d.liw_permille], [d.mode === 'land' ? 'Strikes' : 'War & strikes', d.scheme === 'open_cover' ? d.war_permille : d.war_permille], ['Crisis surcharge', d.crisis_permille]].forEach(([k, v]) => { if(Number(v)) r.push([k, '+', pm(v) + ' ‰']); });
    if(d.f_interest != null && Number(d.f_interest) !== 1) r.push(["Seller's / buyer's interest", '× ' + pm(d.f_interest), '']);
    r.push(['Rate', '', '<b>' + pm(d.rate_permille) + ' ‰</b>']);
    return r;
  }
  // ---- schedules: list of the scope's schedules (⋮ / bulk) and the selected matrix
  function rtTables(host){
    const sc = rScope, tables = S.rateTables.filter(t => inScope(t, sc));
    if(!tables.length){
      if(sc.t === 'policy') return inheritNote(host, 'schedules', 'Schedules');
      host.innerHTML = `<div class="empty card"><h3>No schedules${sc.t === 'customer' ? ' for ' + esc(scCust(sc).name) : ''}</h3><p>${sc.t === 'customer' ? 'Use <b>Copy / Apply to…</b> on the general pool or on another customer to give this customer its own schedules.' : 'Run update_2026-10-20c.sql in Supabase.'}</p></div>`; return;
    }
    if(!curKind || !tables.find(t => t.kind === curKind)) curKind = tables[0].kind;
    const t = tables.find(x => x.kind === curKind);
    selList({ host, rows: tables, id: x => x.id,
      cols:[ { l:'Schedule', html: x => `<button type="button" class="linkbtn tb-pick" data-k="${esc(x.kind)}">${x.kind === curKind ? '<b>' + esc(x.name) + '</b>' : esc(x.name)}</button>` }, { l:'Mode', html: x => esc(x.mode) }, { l:'Zones', cls:'r', html: x => String(x.zones) },
        { l:'Min. premium', cls:'r num', html: x => esc(x.min_premium) }, { l:'War incl.', cls:'r num', html: x => pm(x.war_included_permille) + ' ‰' }, { l:'Updated', cls:'xs', html: x => esc(FC.date(x.updated_at || x.created_at)) } ],
      menu: x => [['Edit matrix', () => { curKind = x.kind; render(); }], ['Copy this schedule to…', () => copyDialog(['schedules'], sc, { schedules:[x.kind] })]],
      bulk:[ ['Copy selected to…', rs => copyDialog(['schedules'], sc, { schedules: rs.map(x => x.kind) })] ],
      onRow: (tr, x) => tr.querySelector('.tb-pick').addEventListener('click', () => { curKind = x.kind; render(); }) });
    host.appendChild(FC.el(`<h3 style="margin:18px 0 8px">${esc(t.name)} <span class="xs muted" style="font-weight:400">${esc(scName(sc))}</span></h3>`));
    const bar = FC.el(`<div class="toolbar"><span class="xs muted">${esc(t.mode)} · ${t.zones} zones</span>
      <span style="flex:1"></span>${rtUnlocked ? `<button class="btn btn-ghost btn-sm" id="tbZAdd" type="button">+ Add ${esc(t.mode)} zone</button><button class="btn btn-ghost btn-sm" id="tbZDel" type="button">Remove zone ${t.zones}</button><label class="btn btn-ghost btn-sm" style="cursor:pointer">Import Excel sheet<input type="file" id="tbFile" accept=".xls,.xlsx" hidden></label><button class="btn btn-ghost btn-sm" id="tbLock" type="button">Lock again</button>` : `<span class="chip neutral">🔒 Locked</span><button class="btn btn-ghost btn-sm" id="tbUnlock" type="button">Unlock to edit</button>`}<button class="btn btn-primary btn-sm" id="tbSave" disabled ${rtUnlocked ? '' : 'hidden'}><span class="spin"></span>Save changes</button></div>`);
    host.appendChild(bar);
    const box = FC.el('<div><div class="empty">Loading…</div></div>'); host.appendChild(box);
    const relock = () => { rtUnlocked = !rtUnlocked; render(); };
    if(bar.querySelector('#tbUnlock')) bar.querySelector('#tbUnlock').addEventListener('click', relock);
    if(bar.querySelector('#tbLock')) bar.querySelector('#tbLock').addEventListener('click', relock);
    const zoneCount = async action => {
      const reason = await askReason(action === 'add' ? `Add ${t.mode} zone ${t.zones + 1} to every ${t.mode} schedule of ${scName(sc)} (rates start empty = on request).` : `Remove ${t.mode} zone ${t.zones} in ${scName(sc)}: its countries become unassigned and its rates are deleted.`);
      if(!reason) return;
      const { error } = await sb.rpc('admin_zone_count', { p_mode: t.mode, p_action: action, p_reason: reason, p_scope_type: sc.t, p_scope_id: sc.id });
      if(error) return toast(error.message, 'error'); toast('Done and logged.'); await loadAll(); render();
    };
    if(bar.querySelector('#tbZAdd')) bar.querySelector('#tbZAdd').addEventListener('click', () => zoneCount('add'));
    if(bar.querySelector('#tbZDel')) bar.querySelector('#tbZDel').addEventListener('click', () => zoneCount('remove'));
    cellsOf(t.id).then(list => {
      box.innerHTML = '';
      box.appendChild(FC.el(`<div class="grid3" style="margin-bottom:12px">
        <div class="field"><label>Minimum premium</label><input id="tbMin" inputmode="decimal" value="${esc(t.min_premium)}"></div>
        <div class="field"><label>War &amp; strikes inside the rates (‰)</label><input id="tbWar" inputmode="decimal" value="${pm(t.war_included_permille)}"></div>
        <div class="field"><label>Options</label><div class="small" style="padding-top:10px;display:flex;gap:16px;flex-wrap:wrap"><label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="tbDeck" ${t.deck_allowed ? 'checked' : ''}> On deck allowed</label><label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="tbCont" ${t.contingency_allowed ? 'checked' : ''}> Interest cover allowed</label></div></div>
        ${t.mode === 'air' ? `<div class="field"><label>Loading used goods %</label><input id="tbUsed" inputmode="decimal" value="${esc(t.used_loading_pct ?? '')}"></div><div class="field"><label>Loading cars %</label><input id="tbCars" inputmode="decimal" value="${esc(t.cars_loading_pct ?? '')}"></div><div class="field"><label>Household flat ‰ (empty = on request)</label><input id="tbHh" inputmode="decimal" value="${pm(t.household_flat_permille)}"></div>` : ''}
      </div><p class="xs muted" style="margin:-4px 0 12px">${esc(t.notes || '')} Rates in per mille (‰), valid both ways. Empty cell = quoted individually.</p>`));
      const n = t.zones, cells = {}; list.forEach(c => { cells[c.zone_a + '-' + c.zone_b] = c.permille; });
      const tw = FC.el('<div class="tbl-wrap"></div>'); box.appendChild(tw);
      let head = '<tr><th>Zone</th>'; for(let b = 1; b <= n; b++) head += `<th class="r">${b}</th>`; head += '</tr>';
      let rowsH = '';
      for(let a = 1; a <= n; a++){
        rowsH += `<tr><th>${a}</th>`;
        for(let b = 1; b <= n; b++) rowsH += b < a ? '<td class="muted xs" style="text-align:center">·</td>' : `<td style="padding:3px"><input data-a="${a}" data-b="${b}" inputmode="decimal" value="${pm(cells[a + '-' + b])}" style="min-width:52px;width:56px;text-align:right;padding:5px 6px" aria-label="Zone ${a} to ${b}"></td>`;
        rowsH += '</tr>';
      }
      tw.innerHTML = `<table class="tbl">${head}${rowsH}</table>`;
      box.appendChild(FC.el(auditFoot('schedule', t.name, 5)));
      if(!rtUnlocked) box.querySelectorAll('.grid3 input, .tbl input').forEach(i => { i.disabled = true; });
      const save = bar.querySelector('#tbSave');
      box.addEventListener('input', e => { if(e.target.matches('input')){ e.target.classList.add('dirty'); save.disabled = false; } });
      box.addEventListener('change', e => { if(e.target.type === 'checkbox'){ save.disabled = false; } });
      if(bar.querySelector('#tbFile')) bar.querySelector('#tbFile').addEventListener('change', async e => {
        const f = e.target.files[0]; if(!f) return;
        try{
          if(!window.XLSX) await FC.loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
          const wb = XLSX.read(await f.arrayBuffer());
          const pick = await FC.dialog({ title:'Which sheet?', body:`<div class="field"><label for="shSel">Sheet to import into “${esc(t.name)}”</label><select id="shSel">${wb.SheetNames.map(nm => `<option>${esc(nm)}</option>`).join('')}</select></div>`,
            actions:[{ label:'Cancel', kind:'ghost', value:null }, { label:'Import', kind:'primary', onClick: async (c, bx) => bx.querySelector('#shSel').value }] });
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
        const num = id => { const el = box.querySelector(id); if(!el) return undefined; const x = el.value.trim(); return x === '' ? null : ppm(x); };
        const meta = { min_premium: num('#tbMin') || 0, war_included_permille: num('#tbWar') || 0, deck_allowed: box.querySelector('#tbDeck').checked, contingency_allowed: box.querySelector('#tbCont').checked };
        if(t.mode === 'air'){ meta.used_loading_pct = num('#tbUsed'); meta.cars_loading_pct = num('#tbCars'); meta.household_flat_permille = num('#tbHh'); }
        const up = [], del = []; let bad = 0;
        tw.querySelectorAll('input.dirty').forEach(inp => { const v = inp.value.trim(), a = Number(inp.dataset.a), b = Number(inp.dataset.b); if(v === '') del.push({ a, b }); else { const x = ppm(v); if(isFinite(x) && x >= 0) up.push({ a, b, v: x }); else bad++; } });
        if(bad) return toast(bad + ' cell(s) are not valid numbers.', 'error');
        const reason = await askReason(`${t.name} (${scName(sc)}): ${up.length} rate(s) changed${del.length ? ', ' + del.length + ' removed' : ''}, settings checked for changes.`);
        if(!reason) return;
        busy(save, true);
        const { data, error } = await sb.rpc('admin_save_rate_table', { p_table: t.id, p_meta: meta, p_cells: up, p_removed: del, p_reason: reason });
        busy(save, false);
        if(error) return toast('Could not save: ' + error.message, 'error');
        delete S.cellCache[t.id];
        toast(data ? data + ' change(s) saved and logged.' : 'Nothing changed.'); rtUnlocked = false; await loadAll(); render();
      });
    });
  }
  const COM_COLS = tables => [ { k:'class_factor', l:'Class factor', type:'num' }, { k:'allowed_covers', l:'Covers', type:'covers' },
    { k:'sea_table', l:'Sea base rates (standard rating)', type:'select', options: tables },
    { k:'oc_class', l:'Policy schedule', type:'select', options:[['', '- on request -'], ['new', 'New goods'], ['used', 'Used goods'], ['cars_new', 'New vehicles'], ['cars_used', 'Used vehicles'], ['household', 'Household goods']] },
    { k:'air_class', l:'By air', type:'select', options:[['', 'no'], ['new', 'yes']] },
    { k:'theft_attractive', l:'Theft-attractive', type:'bool' }, { k:'ext_hssc', l:'Offer HSSC', type:'bool' }, { k:'ext_liw', l:'Offer LiW / DiW', type:'bool' },
    { k:'loading_pct', l:'Extra loading %', type:'num' }, { k:'max_sum_insured', l:'Max. sum insured', type:'num' },
    { k:'on_request', l:'Always on request', type:'bool' }, { k:'active', l:'Active', type:'bool' },
    { k:'deductible', l:'Deductible (shown to clients)', w:240 }, { k:'conditions', l:'Special conditions', w:280 } ];
  const comClean = r => { ['sea_table','air_class','oc_class'].forEach(k => { if(r[k] === '') r[k] = null; }); if('loading_pct' in r && r.loading_pct == null) r.loading_pct = 0; ['theft_attractive','ext_hssc','ext_liw','on_request','active'].forEach(k => { if(k in r && r[k] == null) r[k] = k === 'active'; }); return r; };
  async function rtCommodities(host){
    const sc = rScope, kinds = Array.from(new Set(S.rateTables.filter(t => t.mode === 'sea').map(t => t.kind)));
    const tables = [['', '- not by sea -']].concat(kinds.map(k => [k, (S.rateTables.find(t => t.kind === k) || {}).name || k]));
    if(sc.t === 'one_off_general'){
      return editTable(host, { table:'commodities', key:'id', rows:S.commodities, search:true,
        add: () => ({ id:'', name:'', group_name:'General & industrial', class_factor:1, sea_table:'sea_new', air_class:'new', allowed_covers:['icc_a','icc_b','icc_c'], active:true, on_request:false, sort:200, loading_pct:0 }),
        cols:[ { k:'id', l:'ID', ro:true, w:110 }, { k:'group_name', l:'Group', w:150 }, { k:'name', l:'Name', w:200 } ].concat(COM_COLS(tables), [{ k:'temp_controlled', l:'Temp.-controlled', type:'bool' }, { k:'sort', l:'Sort', type:'num' }, { k:'description', l:'Description (shown to clients)', w:220 }]),
        clean: r => { comClean(r); if('class_factor' in r && r.class_factor == null) r.class_factor = 1; return r; },
        menu: r => r.id && !r.__new ? [['Copy to customer / policy…', () => copyDialog(['cargo'], GEN, { cargo:[r.id] })]] : [],
        bulk:[ ['Copy selected to…', rs => copyDialog(['cargo'], GEN, { cargo: rs.filter(r => r.id).map(r => r.id) })] ] });
    }
    host.innerHTML = '<div class="empty">Loading…</div>';
    const { data: terms, error } = await scoped(sb.from('commodity_terms').select('*'), sc);
    host.innerHTML = '';
    if(error) return toast(error.message, 'error');
    if(!(terms || []).length && sc.t === 'policy') return inheritNote(host, 'cargo', 'Cargo types');
    const missing = S.commodities.filter(c => !(terms || []).some(t => t.commodity_id === c.id));
    host.appendChild(FC.el(`<p class="small muted" style="margin:0 0 10px">Cargo types covered under ${esc(scName(sc))}. A cargo type that is not listed here is <b>not covered</b>: it goes on request and is treated as out of cover (quoted as a one-off).</p>`));
    editTable(host, { table:'commodity_terms', key:'id', keyOptional:true, search:true,
      rows: (terms || []).map(t => Object.assign({}, t, { _name: (S.commodities.find(c => c.id === t.commodity_id) || {}).name || t.commodity_id, _group: (S.commodities.find(c => c.id === t.commodity_id) || {}).group_name || '' })).sort((a, b) => a._group.localeCompare(b._group) || a._name.localeCompare(b._name)),
      cols: [ { k:'_name', l:'Cargo type', fixed:true, html: r => `<b>${esc(r._name)}</b><br><span class="xs muted">${esc(r._group)}</span>` } ].concat(COM_COLS(tables)),
      carry:['commodity_id'], clean: r => Object.assign(comClean(r), { scope_type: sc.t, scope_id: sc.id, updated_at: new Date().toISOString() }),
      tools: tb => { if(!missing.length) return; const s = FC.el(`<select class="input" aria-label="Add cargo type" style="max-width:260px"><option value="">+ Add cargo type…</option>${missing.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select>`);
        s.addEventListener('change', async () => { const c = S.commodities.find(x => x.id === s.value); if(!c) return;
          const { error: e2 } = await sb.from('commodity_terms').insert({ scope_type: sc.t, scope_id: sc.id, commodity_id: c.id, active:true, on_request: c.on_request, allowed_covers: c.allowed_covers, class_factor: c.class_factor, sea_table: c.sea_table, air_class: c.air_class, oc_class: c.oc_class, loading_pct: c.loading_pct, theft_attractive: c.theft_attractive, deductible: c.deductible, conditions: c.conditions, max_sum_insured: c.max_sum_insured, ext_hssc: c.ext_hssc, ext_liw: c.ext_liw });
          if(e2) return toast(e2.message, 'error'); toast(c.name + ' added with the general terms - adjust and save.'); render(); });
        tb.insertBefore(s, tb.querySelector('.spacer')); },
      menu: r => [['Copy to…', () => copyDialog(['cargo'], sc, { cargo:[r.commodity_id] })], '-', ['Remove (not covered)', () => delRow('commodity_terms', r.id, 'Remove ' + r._name + ' from ' + scName(sc) + '?', 'Shipments of this cargo type go on request and are treated as out of cover.'), 'danger']],
      bulk:[ ['Copy selected to…', rs => copyDialog(['cargo'], sc, { cargo: rs.map(r => r.commodity_id) })],
        ['Remove (not covered)', async rs => { if(!(await FC.confirm('Remove ' + rs.length + ' cargo type(s)?', 'They are no longer covered under ' + scName(sc) + '.', 'Remove', 'danger'))) return; const { error: e3 } = await sb.from('commodity_terms').delete().in('id', rs.map(r => r.id)); if(e3) return toast(e3.message, 'error'); render(); }, 'danger'] ] });
  }
  async function rtCountries(host){
    const sc = rScope;
    host.innerHTML = '<div class="empty">Loading…</div>';
    const cz = await zonesOf(sc);
    host.innerHTML = '';
    if(!cz.length && sc.t === 'policy') return inheritNote(host, 'zones', 'Zones');
    const zs = n => [['', '- none -']].concat(Array.from({ length:n }, (_, i) => [String(i + 1), String(i + 1)]));
    const tbs = S.rateTables.filter(t => inScope(t, sc) || (sc.t === 'policy' && inScope(t, { t:'customer', id: scCust(sc).id })));
    const sea = Math.max(0, ...tbs.filter(t => t.mode === 'sea').map(t => t.zones)) || 19, air = Math.max(0, ...tbs.filter(t => t.mode === 'air').map(t => t.zones)) || 12;
    const by = {}; cz.forEach(r => by[r.iso2] = r);
    const rows = S.countries.map(c => { const r = by[c.iso2]; return Object.assign({ id: r ? r.id : undefined, iso2: c.iso2, _name: c.name, sea_zone: r && r.sea_zone != null ? String(r.sea_zone) : '', air_zone: r && r.air_zone != null ? String(r.air_zone) : '', compliance: r ? r.compliance : 'ok', note: r ? r.note || '' : '' }); });
    // zones switched on / off for this level (a switched-off zone = no automatic rate, quoted individually)
    const zcard = FC.el(`<div class="card card-pad zone-onoff" style="margin:0 0 14px"><div class="toolbar" style="margin:0 0 6px"><b>Zones in use · ${esc(scName(sc))}</b><span class="xs muted">Untick to switch a zone off on this level.</span><span style="flex:1"></span></div>
      ${[['sea', sea], ['air', air]].map(([m, n]) => { const zm = S.zoneMaps.find(z => inScope(z, sc) && z.mode === m) || {}; const off = zm.disabled || [];
        return `<div class="zo-row"><span class="zo-m">${m === 'sea' ? 'Sea' : 'Air'}</span>${Array.from({ length:n }, (_, i) => i + 1).map(z => `<label class="zo"><input type="checkbox" data-m="${m}" value="${z}" ${off.includes(z) ? '' : 'checked'}> ${z} <span class="xs muted">(${cz.filter(r => r[m + '_zone'] === z).length})</span></label>`).join('')}</div>`; }).join('')}</div>`);
    zcard.querySelector('.toolbar').appendChild(btn('Save zones', 'ghost', async b => {
      const off = m => Array.from(zcard.querySelectorAll(`input[data-m="${m}"]:not(:checked)`)).map(i => Number(i.value));
      const n = ['sea','air'].reduce((t, m) => t + cz.filter(r => off(m).includes(r[m + '_zone'])).length, 0);
      if(n && !(await seriousConfirm('Switch zones off in ' + scName(sc) + '?', n + ' country assignment(s) lose their automatic rate and go on request. The rate matrices stay unchanged and the zones can be switched on again.', [['Switch off', true]]))) return;
      busy(b, true);
      for(const m of ['sea','air']){ const zm = S.zoneMaps.find(z => inScope(z, sc) && z.mode === m);
        const r = zm ? await sb.from('zone_maps').update({ disabled: off(m) }).eq('id', zm.id) : await sb.from('zone_maps').insert({ scope_type: sc.t, scope_id: sc.id, mode: m, colors:{}, labels:{}, disabled: off(m) });
        if(r.error){ busy(b, false); return toast(r.error.message, 'error'); } }
      busy(b, false); toast('Zones saved.'); await loadAll(); render(); }));
    host.appendChild(zcard);
    host.appendChild(FC.el(`<p class="small muted" style="margin:0 0 10px">Zones and the country check of ${esc(scName(sc))}. Notes appear when hovering the country on the zone map (e.g. coastal splits, war &amp; strikes suspensions, licensing remarks).</p>`));
    editTable(host, { table:'country_zones', key:'id', keyOptional:true, search:true, rows,
      lock: { cols:['sea_zone','air_zone'], label:'zones' },
      beforeSave: async payload => {
        const changed = payload.filter(x => { const o = by[x.iso2] || {}; return ('sea_zone' in x && x.sea_zone !== (o.sea_zone == null ? null : o.sea_zone)) || ('air_zone' in x && x.air_zone !== (o.air_zone == null ? null : o.air_zone)); });
        if(changed.length){
          const reason = await askReason(scName(sc) + ': ' + changed.length + ' countr' + (changed.length > 1 ? 'ies' : 'y') + ' moved to another zone: ' + changed.map(x => x.iso2).join(', ') + '.');
          if(!reason) return false;
          const { error } = await sb.rpc('admin_set_zones', { p_rows: changed.map(x => ({ iso2: x.iso2, sea_zone: x.sea_zone, air_zone: x.air_zone })), p_reason: reason, p_scope_type: sc.t, p_scope_id: sc.id });
          if(error){ toast('Could not save the zones: ' + error.message, 'error'); return false; }
          const fresh = changed.filter(x => !x.id).map(x => x.iso2);
          if(fresh.length){ const { data } = await scoped(sb.from('country_zones').select('id,iso2'), sc).in('iso2', fresh); (data || []).forEach(d => { const x = payload.find(y => y.iso2 === d.iso2); if(x) x.id = d.id; }); }
        }
        return payload.map(x => { const y = Object.assign({}, x); delete y.sea_zone; delete y.air_zone; return y; }).filter(y => y.id || y.compliance !== 'ok' || y.note);
      },
      cols:[ { k:'iso2', l:'ISO', fixed:true }, { k:'_name', l:'Country', fixed:true },
        { k:'sea_zone', l:'Sea zone', type:'select', options: zs(sea) }, { k:'air_zone', l:'Air zone', type:'select', options: zs(air) },
        { k:'compliance', l:'Country check', type:'select', options:[['ok', 'OK'], ['local', 'Amber · licensing / local insurers'], ['hold', 'Yellow · hold covered (refer)'], ['blocked', 'Red · blocked']] },
        { k:'note', l:'Note / comment (map hover)', w:260 } ],
      carry:['iso2'],
      foot: auditFoot('zones', scEntity(sc), 5),
      clean: r => { r.sea_zone = r.sea_zone === '' || r.sea_zone == null ? null : Number(r.sea_zone); r.air_zone = r.air_zone === '' || r.air_zone == null ? null : Number(r.air_zone); r.scope_type = sc.t; r.scope_id = sc.id; if(r.note === '') r.note = null; r.updated_at = new Date().toISOString(); return r; },
      menu: r => [['Copy this country to…', () => copyDialog(['zones'], sc, { zones:[r.iso2] })]],
      bulk:[ ['Copy selected to…', rs => copyDialog(['zones'], sc, { zones: rs.map(r => r.iso2) })] ] });
    if(sc.t === 'one_off_general'){
      host.appendChild(FC.el('<h3 style="margin:26px 0 6px">Country facts (apply in every scope)</h3><p class="xs muted" style="margin:0 0 8px">Sanctions, local insurance rules and crisis surcharges belong to the country itself.</p>'));
      editTable(host, { table:'countries', key:'iso2', rows:S.countries, search:true,
        cols:[ { k:'iso2', l:'ISO', ro:true }, { k:'name', l:'Name', w:170 }, { k:'local_insurance', l:'Local insurance rules (*)', type:'bool' }, { k:'crisis_permille', l:'Crisis surcharge ‰', type:'num' },
          { k:'on_request', l:'On request', type:'bool' }, { k:'sanctioned', l:'Sanctioned', type:'bool' } ],
        clean: r => { if('crisis_permille' in r && r.crisis_permille == null) r.crisis_permille = 0; return r; } });
    }
  }
  const SCOPED_KEYS = ['cover_factors','conveyance_factors','packing_factors','deck_loading_pct','theft_land_factor','contingency_factor','sea_war_permille','air_war_permille','land_strikes_permille','land_rates','land_min_premium','auto_limit','uplift_pct','extensions','land_groups'];
  function rtFactors(host){
    const sc = rScope, cu = scCust(sc);
    const own = k => { const r = S.scopeSettings.find(x => inScope(x, sc) && x.key === k); return r ? r.value : undefined; };
    const val = (k, d) => { let v = own(k); if(v === undefined && sc.t === 'policy') { const r = S.scopeSettings.find(x => x.scope_type === 'customer' && x.scope_id === cu.id && x.key === k); v = r ? r.value : undefined; } return v === undefined ? setting(k, d) : v; };
    const inh = k => sc.t !== 'one_off_general' && own(k) === undefined ? ' <span class="chip neutral" title="Not set here - inherited">inherited</span>' : '';
    const cf = val('cover_factors', {}), al = val('auto_limit', {}), conv = val('conveyance_factors', {}), pack = val('packing_factors', {}), land = val('land_rates', {}), ext = val('extensions', {}) || {};
    const inp = (attr, k, v) => `<input data-${attr}="${esc(k)}" inputmode="decimal" value="${esc(v ?? '')}">`;
    const gen = sc.t === 'one_off_general';
    const body = FC.el(`<div class="card card-pad" style="max-width:860px">
      <p class="xs muted" style="margin-top:0">${esc(scName(sc))}.${gen ? '' : ' Values marked “inherited” come from ' + (sc.t === 'policy' ? 'the customer defaults or ' : '') + 'the general pool until you save them here.'}</p>
      <h3 style="margin-bottom:6px">Cover factors${inh('cover_factors')}</h3><p class="xs muted" style="margin:0 0 10px">Share of the cargo rate. War &amp; strikes are not affected.</p>
      <div class="grid3">${['icc_a','icc_b','icc_c'].map(k => `<div class="field"><label>${esc(FC.COVER[k].clause)}</label>${inp('cf', k, cf[k])}</div>`).join('')}</div>
      <h3 style="margin:20px 0 6px">Conveyance factors${inh('conveyance_factors')}</h3><div class="grid3">${Object.entries(FC.CONVEYANCE).map(([k, v]) => `<div class="field"><label>${esc(v.label)}</label>${inp('cv', k, conv[k] ?? 1)}</div>`).join('')}</div>
      <h3 style="margin:20px 0 6px">Packing factors${inh('packing_factors')}</h3><div class="grid3">${Object.keys(Object.assign({ '':1 }, pack)).map(k => `<div class="field"><label>${esc(k || 'Not stated')}</label>${inp('pk', k, pack[k] ?? 1)}</div>`).join('')}</div>
      <h3 style="margin:20px 0 6px">Road &amp; rail base rates (‰)${inh('land_rates')}</h3><div class="grid3">
        <div class="field"><label>Domestic (same country)</label>${inp('lr', 'domestic', land.domestic)}</div>
        <div class="field"><label>Regional (same sea zone)</label>${inp('lr', 'regional', land.regional)}</div>
        <div class="field"><label>Long-haul (other zone)</label>${inp('lr', 'long_haul', land.long_haul)}</div></div>
      <div class="field" style="margin-top:12px"><label>Zones connected by land (JSON: group → sea zones)${inh('land_groups')}</label><input id="ffGroups" value="${esc(JSON.stringify(val('land_groups', {})))}"></div>
      <h3 style="margin:20px 0 6px">War, strikes &amp; loadings</h3><div class="grid3">
        <div class="field"><label>War &amp; strikes sea (‰)${inh('sea_war_permille')}</label><input id="ffSeaWar" inputmode="decimal" value="${esc(val('sea_war_permille', 0.5))}"></div>
        <div class="field"><label>War &amp; strikes air (‰)${inh('air_war_permille')}</label><input id="ffAirWar" inputmode="decimal" value="${esc(val('air_war_permille', 0.5))}"></div>
        <div class="field"><label>Strikes road / rail (‰)${inh('land_strikes_permille')}</label><input id="ffLandSt" inputmode="decimal" value="${esc(val('land_strikes_permille', 0.1))}"></div>
        <div class="field"><label>On-deck loading %${inh('deck_loading_pct')}</label><input id="ffDeck" inputmode="decimal" value="${esc(val('deck_loading_pct', 50))}"></div>
        <div class="field"><label>Theft loading on land (factor)${inh('theft_land_factor')}</label><input id="ffTheft" inputmode="decimal" value="${esc(val('theft_land_factor', 1.5))}"></div>
        <div class="field"><label>Seller's / buyer's interest factor${inh('contingency_factor')}</label><input id="ffCont" inputmode="decimal" value="${esc(val('contingency_factor', 0.4))}"></div></div>
      <h3 style="margin:20px 0 6px">Optional extensions${inh('extensions')}</h3><p class="xs muted" style="margin:0 0 10px">Added flat to the rate in ‰ of the sum insured, only for cargo types that offer them. 0.15 ‰ = 0.015 %.</p><div class="grid3">
        <div class="field"><label>HSSC surcharge (‰)</label><input id="ffHssc" inputmode="decimal" value="${esc((ext.hssc || {}).permille ?? 0.15)}"></div>
        <div class="field"><label>LiW / DiW surcharge (‰)</label><input id="ffLiw" inputmode="decimal" value="${esc((ext.liw || {}).permille ?? 0.75)}"></div>
        <div class="field"><label>LiW / DiW deductible</label><input id="ffLiwDed" maxlength="100" value="${esc((ext.liw || {}).deductible || '0.5 % of the sum insured')}"></div></div>
      <h3 style="margin:20px 0 6px">Limits &amp; minimums</h3><div class="grid3">
        ${CURS.map(c => `<div class="field"><label>Automatic limit ${c}${c === 'USD' ? inh('auto_limit') : ''}</label>${inp('al', c, al[c])}</div>`).join('')}
        <div class="field"><label>Minimum premium road / rail${inh('land_min_premium')}</label><input id="ffLandMin" inputmode="decimal" value="${esc(val('land_min_premium', 75))}"></div>
        <div class="field"><label>Default uplift %${inh('uplift_pct')}</label><input id="ffUp" inputmode="decimal" value="${esc(val('uplift_pct', 10))}"></div>
        ${gen ? `<div class="field"><label>Referral discount %</label><input id="ffRef" inputmode="decimal" value="${esc(setting('referral_discount_pct', 5))}"></div>` : ''}</div>
      ${gen ? `<div class="field" style="margin-top:12px"><label>Default deductible (if the cargo type has none)</label><input id="ffDed" maxlength="200" value="${esc(setting('deductible_text', ''))}"></div>
        <div class="field"><label>Currencies of the general one-off pool</label>${curBoxes('ffCurs', setting('currencies', ['EUR','USD','GBP','SGD']))}</div>` : ''}
      <p class="xs muted">Sea and air minimum premiums are set per schedule (tab Schedules). Cargo class factors, deductibles and limits per cargo type (tab Cargo types)${gen ? '' : '; minimum premium and deductible of a policy in the policy itself'}.</p>
      <div class="err-msg" id="ffErr"></div><div id="ffSave" style="margin-top:12px" class="toolbar"></div></div>`);
    host.appendChild(body);
    body.querySelector('#ffSave').appendChild(btn('Save', 'primary', async b => {
      const num = el => FC.parseNum(el.value), obj = attr => { const o = {}; body.querySelectorAll(`[data-${attr}]`).forEach(i => { if(i.value.trim() !== '' || attr !== 'al') o[i.getAttribute('data-' + attr)] = num(i); }); return o; };
      let groups; try{ groups = JSON.parse(body.querySelector('#ffGroups').value); }catch(e){ body.querySelector('#ffErr').textContent = 'Zones connected by land: not valid JSON.'; return; }
      const vals = { cover_factors: obj('cf'), conveyance_factors: obj('cv'), packing_factors: obj('pk'), land_rates: obj('lr'), auto_limit: obj('al'), land_groups: groups,
        sea_war_permille: num(body.querySelector('#ffSeaWar')), air_war_permille: num(body.querySelector('#ffAirWar')), land_strikes_permille: num(body.querySelector('#ffLandSt')),
        deck_loading_pct: num(body.querySelector('#ffDeck')), theft_land_factor: num(body.querySelector('#ffTheft')), contingency_factor: num(body.querySelector('#ffCont')),
        land_min_premium: num(body.querySelector('#ffLandMin')), uplift_pct: num(body.querySelector('#ffUp')) };
      if(gen){ vals.referral_discount_pct = num(body.querySelector('#ffRef')); vals.deductible_text = body.querySelector('#ffDed').value.trim(); vals.currencies = readCurs(body, 'ffCurs');
        if(!vals.currencies.length){ body.querySelector('#ffErr').textContent = 'Tick at least one currency for the one-off pool.'; return; } }
      const ex = JSON.parse(JSON.stringify(ext || {})); ex.hssc = ex.hssc || {}; ex.liw = ex.liw || {};
      ex.hssc.permille = num(body.querySelector('#ffHssc')); ex.liw.permille = num(body.querySelector('#ffLiw')); ex.liw.deductible = body.querySelector('#ffLiwDed').value.trim() || '0.5 % of the sum insured';
      if(!(ex.hssc.permille >= 0) || !(ex.liw.permille >= 0)){ body.querySelector('#ffErr').textContent = 'Extension surcharges need a value of 0 or more.'; return; }
      ex.liw.clause = 'Extended to cover loss in weight / difference in weight (shortage), subject to a deductible of ' + ex.liw.deductible + '.';
      vals.extensions = ex;
      const nums = Object.entries(vals).filter(([k]) => !['land_groups','deductible_text','extensions','currencies'].includes(k)).flatMap(([, v]) => typeof v === 'object' ? Object.values(v) : [v]);
      if(nums.some(v => !(v >= 0))){ body.querySelector('#ffErr').textContent = 'All number fields need a value of 0 or more.'; return; }
      busy(b, true);
      const now = new Date().toISOString();
      const { error } = gen ? await sb.from('settings').upsert(Object.entries(vals).map(([key, value]) => ({ key, value, updated_at: now })), { onConflict: 'key' })
        : await sb.from('scope_settings').upsert(Object.entries(vals).filter(([k]) => SCOPED_KEYS.includes(k)).map(([key, value]) => ({ scope_type: sc.t, scope_id: sc.id, key, value, updated_at: now })), { onConflict: 'scope_type,scope_id,key' });
      busy(b, false);
      if(error) return toast(error.message, 'error'); toast('Saved for ' + scName(sc) + '.'); await loadAll(); render();
    }));
    if(!gen && S.scopeSettings.some(x => inScope(x, sc))) body.querySelector('#ffSave').appendChild(btn(sc.t === 'policy' ? 'Reset to customer defaults' : 'Reset to the general pool', 'ghost', async b => {
      if(!(await FC.confirm('Remove the own factors of ' + scName(sc) + '?', 'The values above are then inherited again.', 'Reset', 'danger'))) return;
      busy(b, true); const { error } = await scoped(sb.from('scope_settings').delete(), sc); busy(b, false);
      if(error) return toast(error.message, 'error'); toast('Reset.'); await loadAll(); render(); }));
  }
  function rtTest(host){
    const sc = rScope, cu = scCust(sc), com = S.commodities.filter(c => c.active), cty = S.countries;
    const offs = cu ? S.offices.filter(o => o.customer_id === cu.id && o.active && (sc.t !== 'policy' || !o.policy_id || o.policy_id === sc.id)) : [];
    const curs = sc.t === 'one_off_general' ? allowedCurs(null, null, null) : allowedCurs(null, sc.t === 'policy' ? sc.id : null, cu.id);
    const body = FC.el(`<div class="card card-pad" style="max-width:760px"><p class="small muted" style="margin-top:0">Rates a shipment with the configuration of <b>${esc(scName(sc))}</b>${sc.t === 'customer' ? ' (through its first active policy)' : ''}. Nothing is saved.</p>
      <div class="grid2">
        <div class="field"><label>Cargo</label><select id="ttC">${com.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></div>
        <div class="field"><label>Conveyance</label><select id="ttV">${Object.entries(FC.CONVEYANCE).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('')}</select></div>
        <div class="field"><label>From</label><select id="ttO">${cty.map(c => `<option value="${c.iso2}" ${c.iso2 === 'DE' ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
        <div class="field"><label>To</label><select id="ttD">${cty.map(c => `<option value="${c.iso2}" ${c.iso2 === 'CN' ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
        <div class="field"><label>Invoice value</label><div class="grid2" style="grid-template-columns:1fr 90px"><input id="ttI" value="100000" inputmode="decimal"><select id="ttCur" aria-label="Currency">${curs.map(c => `<option>${c}</option>`).join('')}</select></div></div>
        <div class="field"><label>Cover</label><select id="ttK"><option value="icc_a">ICC A</option><option value="icc_b">ICC B</option><option value="icc_c">ICC C</option></select></div>
        ${offs.length ? `<div class="field"><label>As office</label><select id="ttOf"><option value="">- no office -</option>${offs.map(o => `<option value="${o.id}">${esc(o.name)}${o.location ? ' - ' + esc(o.location) : ''}</option>`).join('')}</select></div>` : ''}
        <div class="field"><label>Packaging</label><select id="ttP">${Object.keys(Object.assign({ '':1 }, setting('packing_factors', {}))).map(k => `<option value="${esc(k)}">${esc(k || 'Not stated')}</option>`).join('')}</select></div>
      </div><div class="small" style="margin-top:12px;display:flex;gap:18px;flex-wrap:wrap"><label><input type="checkbox" id="ttW" checked> War &amp; strikes</label><label><input type="checkbox" id="ttDk"> On deck</label><label><input type="checkbox" id="ttHs"> HSSC</label><label><input type="checkbox" id="ttLw"> LiW / DiW</label><label><input type="checkbox" id="ttIn"> Interest only</label></div>
      <div id="ttRun" style="margin-top:12px"></div><div id="ttOut" style="margin-top:14px"></div></div>`);
    host.appendChild(body);
    if(body.querySelector('#ttOf')) body.querySelector('#ttOf').addEventListener('change', e => { const o = ofcOf(Number(e.target.value)), was = body.querySelector('#ttCur').value;
      const list = allowedCurs(o && o.id, sc.t === 'policy' ? sc.id : o && o.policy_id, cu.id); body.querySelector('#ttCur').innerHTML = list.map(c => `<option ${c === was ? 'selected' : ''}>${c}</option>`).join(''); });
    body.querySelector('#ttRun').appendChild(btn('Calculate', 'primary', async b => {
      busy(b, true);
      const v = id => body.querySelector(id).value, c = id => body.querySelector(id).checked, of = body.querySelector('#ttOf');
      const p = { commodity_id:v('#ttC'), goods_description:'Rate test', conveyance:v('#ttV'), origin_country:v('#ttO'), dest_country:v('#ttD'), invoice_value:FC.parseNum(v('#ttI')), currency:v('#ttCur'), ext_hssc:c('#ttHs'), ext_liw:c('#ttLw'), uplift_pct:10, cover:v('#ttK'), packaging:v('#ttP'), war_strikes:c('#ttW'), on_deck:c('#ttDk'), interest_only:c('#ttIn') };
      const { data, error } = await sb.rpc('admin_indicate', { p, p_customer: cu ? cu.id : null, p_office: of && of.value ? Number(of.value) : null, p_policy: sc.t === 'policy' ? sc.id : null, p_one_off: sc.t === 'one_off_general', p_save: false });
      busy(b, false);
      if(error){ body.querySelector('#ttOut').innerHTML = `<div class="notice danger" style="margin:0">${esc(error.message)}</div>`; return; }
      body.querySelector('#ttOut').innerHTML = resultHtml(data, p.currency);
    }));
  }
  // result of admin_indicate as a card: status, figures, breakdown, alerts, war, out of cover
  function resultHtml(data, cur){
    const x = data.result, o = data.one_off, n = x.n || {};
    const one = (r, title) => { const d = r.detail || {};
      return `<div class="nq-res">${title ? `<h4>${esc(title)}</h4>` : ''}${r.status === 'quoted'
        ? `<div class="nq-fig"><div><span>Premium (excl. tax)</span><b>${esc(money2(r.net, cur))}</b>${r.min_hit ? '<i>minimum premium</i>' : ''}</div><div><span>Rate</span><b>${esc(FC.pct(r.rate))}</b><i>${esc(pm(d.rate_permille))} ‰</i></div><div><span>Sum insured</span><b>${esc(money2(n.sum_insured, cur))}</b></div><div><span>Minimum</span><b>${esc(r.min != null ? money2(r.min, cur) : '-')}</b></div></div>`
        : `<div class="notice ${r.status === 'sanctioned' ? 'danger' : 'warn'}" style="margin:0 0 10px"><b>${esc(FC.STATUS[r.status] || r.status)}</b>${esc((r.reasons || []).join('; '))}</div>`}
        ${breakdownRows(r.detail).length ? `<table class="tbl nq-bd"><tbody>${breakdownRows(r.detail).map(([a, b2, c2]) => `<tr><td>${esc(a)}</td><td class="muted">${esc(b2)}</td><td class="r num">${c2}</td></tr>`).join('')}</tbody></table>` : ''}
        ${r.war && (r.war.areas || []).length ? `<div class="nq-war"><b>War &amp; strikes excluded:</b> ${esc(r.war.areas.map(a => a.name).join(', '))} (rate not reduced)<br>${r.war.areas.map(a => esc(a.name) + ': ' + (a.buyback_permille != null ? 'buy-back ' + pm(a.buyback_permille) + ' ‰' + (Number(a.ncb_pct) ? ' less ' + esc(Number(a.ncb_pct)) + ' % NCB = ' + pm(a.net_permille) + ' ‰ net' : '') : 'no buy-back terms')).join('<br>')}${r.war.rate_pct_incl != null ? `<br>Re-included: <b>${esc(FC.pct(r.war.rate_pct_incl))}</b> = ${esc(money2(r.war.premium_incl, cur))}` : ''}</div>` : ''}
        ${(r.alerts || []).length ? `<div class="nq-al">${alertList(r)}</div>` : ''}
        ${(r.notes || []).length ? `<p class="xs muted">For the broker: ${esc(r.notes.join('; '))}</p>` : ''}
        <p class="xs muted" style="margin:6px 0 0">Deductible: ${esc(r.deductible || '-')}${r.conditions ? ' · Conditions: ' + esc(r.conditions) : ''}</p></div>`; };
    return (x.out_of_cover ? `<div class="al-row al-red"><i></i><span><b>Out of cover</b> - ${esc((x.ooc_reasons || []).join('; '))}. Not attached to the policy; quote it as a one-off.</span></div>` : '')
      + one(x, o ? 'Under ' + ((data.policy && polLabel(data.policy)) || 'the policy') : '') + (o ? one(o, 'As a one-off (general pool)') : '');
  }

  // =================================================================== NEW QUOTATION (staff indication & quote builder)
  const nq = { mode:'one_off', cust:null, office:null, policy:null, basis:'profile', user:'', p:null, last:null, transit:[] };
  function renderNewQuote(body){
    const cs = S.customers.filter(c => c.active);
    const p = nq.p || { commodity_id: (S.commodities.find(c => c.active) || {}).id, conveyance:'sea_container', origin_country:'DE', dest_country:'CN', invoice_value:'', currency:'', cover:'icc_a', war_strikes:true, uplift_pct: setting('uplift_pct', 10), packaging:'' };
    const cOpts = S.countries.map(c => `<option value="${c.iso2}">${esc(c.name)}</option>`).join('');
    body.innerHTML = `<div class="nq">
      <div class="nq-form card card-pad">
        <div class="seg nq-mode" id="nqMode" role="radiogroup" aria-label="Indication type"><button type="button" role="radio" data-v="one_off" aria-checked="${nq.mode === 'one_off'}">One-off indication</button><button type="button" role="radio" data-v="client" aria-checked="${nq.mode === 'client'}">Client / policy indication</button></div>
        <p class="xs muted" id="nqHint" style="margin:8px 0 12px"></p>
        <div class="grid3" id="nqCtx" ${nq.mode === 'client' ? '' : 'hidden'}>
          <div class="field"><label for="nqCust">Customer</label><select id="nqCust">${cs.map(c => `<option value="${c.id}" ${c.id === nq.cust ? 'selected' : ''}>${esc(c.name)}</option>`).join('') || '<option value="">No clients yet</option>'}</select></div>
          <div class="field"><label for="nqOff">Office</label><select id="nqOff"></select></div>
          <div class="field"><label for="nqPol">Policy</label><select id="nqPol"></select></div>
          <div class="field" style="grid-column:1/-1"><label for="nqBasis">Calculation basis</label><select id="nqBasis"><option value="profile" ${nq.basis === 'profile' ? 'selected' : ''}>The client's policy / client configuration</option><option value="standalone" ${nq.basis === 'standalone' ? 'selected' : ''}>Standalone one-off (unrelated to the client's policy / profile)</option></select><span class="hint">Standalone: linked to the client for history and invoicing, rated from the general one-off pool.</span></div>
        </div>
        <div class="grid2">
          <div class="field"><label for="nqCom">Cargo type</label><select id="nqCom">${S.commodities.filter(c => c.active).map(c => `<option value="${esc(c.id)}" ${c.id === p.commodity_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
          <div class="field"><label for="nqGoods">Description of goods</label><input id="nqGoods" maxlength="300" value="${esc(p.goods_description || '')}" placeholder="e.g. Spare parts in cartons, 1 x 40ft"></div>
          <div class="field"><label for="nqConv">Conveyance</label><select id="nqConv">${Object.entries(FC.CONVEYANCE).map(([k, v]) => `<option value="${k}" ${k === p.conveyance ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select></div>
          <div class="field"><label for="nqPack">Packaging</label><select id="nqPack">${Object.keys(Object.assign({ '':1 }, setting('packing_factors', {}))).map(k => `<option value="${esc(k)}" ${k === (p.packaging || '') ? 'selected' : ''}>${esc(k || 'Not stated')}</option>`).join('')}</select></div>
          <div class="field"><label for="nqO">From</label><div class="grid2" style="grid-template-columns:1fr 1fr"><select id="nqO">${cOpts}</select><input id="nqOP" maxlength="100" placeholder="Place / port" value="${esc(p.origin_place || '')}" aria-label="From place"></div></div>
          <div class="field"><label for="nqD">To</label><div class="grid2" style="grid-template-columns:1fr 1fr"><select id="nqD">${cOpts}</select><input id="nqDP" maxlength="100" placeholder="Place / port" value="${esc(p.dest_place || '')}" aria-label="To place"></div></div>
          <div class="field"><label for="nqVia">Transit countries</label><select id="nqVia"><option value="">+ Add transit country</option>${cOpts}</select><div class="tchips" id="nqChips"></div></div>
          <div class="field"><label for="nqRed">Routing via Suez / Red Sea</label><select id="nqRed"><option value="auto">Not stated (assume Suez for Europe ↔ Asia)</option><option value="yes">Yes, via Suez</option><option value="no">No, e.g. via the Cape</option></select></div>
          <div class="field"><label for="nqInv">Invoice value</label><div class="grid2" style="grid-template-columns:1fr 90px"><input id="nqInv" inputmode="decimal" value="${esc(p.invoice_value || '')}"><select id="nqCur" aria-label="Currency"></select></div></div>
          <div class="field"><label for="nqFr">Freight <span class="muted">(optional)</span></label><input id="nqFr" inputmode="decimal" value="${esc(p.freight_value || '')}"></div>
          <div class="field"><label for="nqUp">Uplift %</label><input id="nqUp" inputmode="decimal" value="${esc(p.uplift_pct)}"></div>
          <div class="field"><label for="nqCov">Cover</label><select id="nqCov">${['icc_a','icc_b','icc_c'].map(k => `<option value="${k}" ${k === p.cover ? 'selected' : ''}>${esc(FC.COVER[k].clause)}</option>`).join('')}</select></div>
          <div class="field"><label for="nqDep">Departure date / ETA of loading</label><input id="nqDep" type="date" min="${FC.today()}" value="${esc(p.departure_date || '')}"></div>
          <div class="field"><label for="nqInco">Incoterm</label><select id="nqInco"><option value="">Not known</option>${Object.keys(FC.INCOTERMS || {}).map(k => `<option ${k === p.incoterm ? 'selected' : ''}>${k}</option>`).join('')}</select></div>
          <div class="field"><label for="nqParty">Client / assured role</label><select id="nqParty">${FC.partyOptions(p.insured_party || 'seller')}</select><input id="nqPartyO" maxlength="100" placeholder="Specify the role" aria-label="Role (other)" value="${esc(p.party_role_other || '')}" ${p.insured_party === 'other' ? '' : 'hidden'} style="margin-top:6px"></div>
          <div class="field"><label for="nqIns">Assured <span class="muted">(optional)</span></label><input id="nqIns" maxlength="150" value="${esc(p.insured_name || '')}"></div>
          <div class="field"><label for="nqVes">Vessel <span class="muted">(sea)</span></label><input id="nqVes" maxlength="100" value="${esc(p.vessel || '')}"></div>
        </div>
        <div class="small nq-flags"><label><input type="checkbox" id="nqWar" ${p.war_strikes !== false ? 'checked' : ''}> War &amp; strikes</label><label><input type="checkbox" id="nqDeck" ${p.on_deck ? 'checked' : ''}> On deck</label><label><input type="checkbox" id="nqInt" ${p.interest_only ? 'checked' : ''}> Interest only</label><label><input type="checkbox" id="nqHs" ${p.ext_hssc ? 'checked' : ''}> HSSC</label><label><input type="checkbox" id="nqLw" ${p.ext_liw ? 'checked' : ''}> LiW / DiW</label></div>
        <div class="toolbar" style="margin-top:12px"><span style="flex:1"></span><button type="button" class="btn btn-ghost btn-sm" id="nqClear">Clear</button><button type="button" class="btn btn-primary" id="nqCalc"><span class="spin"></span>Calculate</button></div>
        <div class="err-msg" id="nqErr"></div>
      </div>
      <div class="nq-out card card-pad" id="nqOut" aria-live="polite"><div class="empty" style="padding:30px 10px"><h3>Indication</h3><p>Fill in the shipment and calculate. Alerts, war &amp; strikes extras and the full rate breakdown show here before you log anything.</p></div></div></div>`;
    const $q = s => body.querySelector(s);
    $q('#nqO').value = p.origin_country || 'DE'; $q('#nqD').value = p.dest_country || 'CN'; $q('#nqRed').value = p.red_sea || 'auto'; if(p.incoterm) $q('#nqInco').value = p.incoterm;
    nq.transit = (p.transit_countries || nq.transit || []).slice();
    $q('#nqParty').addEventListener('change', e => { $q('#nqPartyO').hidden = e.target.value !== 'other'; });
    const paintChips = () => { $q('#nqChips').innerHTML = nq.transit.map(cc => `<span class="tchip">${esc(cName(cc))}<button type="button" data-rm="${cc}" aria-label="Remove ${esc(cName(cc))}">×</button></span>`).join(''); };
    $q('#nqVia').addEventListener('change', e => { const cc = e.target.value; if(cc && !nq.transit.includes(cc) && nq.transit.length < 8){ nq.transit.push(cc); paintChips(); } e.target.value = ''; });
    $q('#nqChips').addEventListener('click', e => { const b = e.target.closest('[data-rm]'); if(b){ nq.transit = nq.transit.filter(x => x !== b.dataset.rm); paintChips(); } });
    paintChips();
    const paintCtx = () => {
      const client = nq.mode === 'client'; $q('#nqCtx').hidden = !client;
      if(client && !nq.cust && cs.length) nq.cust = cs[0].id;
      const cu = client ? custOf(Number($q('#nqCust').value) || nq.cust) : null;
      if(client && cu){
        const offs = S.offices.filter(o => o.customer_id === cu.id && o.active), pols = S.policies.filter(po => po.customer_id === cu.id && po.active);
        $q('#nqOff').innerHTML = '<option value="">- no office -</option>' + offs.map(o => `<option value="${o.id}" ${o.id === nq.office ? 'selected' : ''}>${esc(o.name)}${o.location ? ' - ' + esc(o.location) : ''}</option>`).join('');
        const o = ofcOf(Number($q('#nqOff').value));
        $q('#nqPol').innerHTML = pols.map(po => `<option value="${po.id}" ${po.id === (o && o.policy_id ? o.policy_id : nq.policy) ? 'selected' : ''}>${esc(polLabel(po))}</option>`).join('') + `<option value="" ${!pols.length ? 'selected' : ''}>No policy (client configuration)</option>`;
        $q('#nqPol').disabled = nq.basis === 'standalone';
      }
      const o = client ? ofcOf(Number($q('#nqOff').value)) : null, po = client ? polOf(Number($q('#nqPol').value)) : null;
      const sa = client && nq.basis === 'standalone';
      const curs = client && cu && !sa ? allowedCurs(o && o.id, po && po.id, cu.id) : allowedCurs(null, null, null), was = $q('#nqCur').value || p.currency;
      $q('#nqCur').innerHTML = curs.map(c => `<option ${c === was ? 'selected' : ''}>${c}</option>`).join('');
      $q('#nqHint').textContent = !client ? 'Rated from the general one-off pool - never from a client’s terms.' : !cu ? 'Choose the client.' : sa ? 'Standalone one-off for ' + cu.name + ': rated from the general one-off pool, kept under the client.' : po ? 'Rated with the schedules, limits and rules of policy ' + polLabel(po) + ' (' + cu.name + '). Out-of-cover shipments are shown with the one-off rating as well.' : cu.cover_type === 'one_off' ? cu.name + ' is a one-off client: rated from the general one-off pool.' : 'Rated with the client configuration of ' + cu.name + ' (no policy).';
    };
    $$('#nqMode button', body).forEach(b => b.addEventListener('click', () => { nq.mode = b.dataset.v; $$('#nqMode button', body).forEach(x => x.setAttribute('aria-checked', String(x === b))); paintCtx(); }));
    $q('#nqCust').addEventListener('change', e => { nq.cust = Number(e.target.value); nq.office = null; nq.policy = null; paintCtx(); });
    $q('#nqOff').addEventListener('change', e => { nq.office = Number(e.target.value) || null; const o = ofcOf(nq.office); if(o && o.policy_id) nq.policy = o.policy_id; paintCtx(); });
    $q('#nqPol').addEventListener('change', e => { nq.policy = Number(e.target.value) || null; paintCtx(); });
    $q('#nqBasis').addEventListener('change', e => { nq.basis = e.target.value; paintCtx(); });
    spotClient($q('#nqCust'), () => '', (id, off) => { nq.cust = id; nq.office = off || null; nq.policy = null; paintCtx(); });
    paintCtx();
    $q('#nqClear').addEventListener('click', () => { nq.p = null; nq.last = null; nq.transit = []; render(); });
    const read = () => {
      const v = s => $q(s).value.trim(), c = s => $q(s).checked;
      return { commodity_id: v('#nqCom'), goods_description: v('#nqGoods'), conveyance: v('#nqConv'), packaging: v('#nqPack'), origin_country: v('#nqO'), origin_place: v('#nqOP'), dest_country: v('#nqD'), dest_place: v('#nqDP'),
        transit_countries: nq.transit.slice(), red_sea: v('#nqRed'), invoice_value: FC.parseNum(v('#nqInv')), currency: v('#nqCur'), freight_value: FC.parseNum(v('#nqFr')) || 0, uplift_pct: FC.parseNum(v('#nqUp')),
        cover: v('#nqCov'), departure_date: v('#nqDep') || null, incoterm: v('#nqInco') || null, insured_party: v('#nqParty') || null, party_role_other: v('#nqParty') === 'other' ? v('#nqPartyO') : '', insured_name: v('#nqIns'), vessel: v('#nqVes'),
        war_strikes: c('#nqWar'), on_deck: c('#nqDeck'), interest_only: c('#nqInt'), ext_hssc: c('#nqHs'), ext_liw: c('#nqLw') };
    };
    const ctxArgs = () => { if(nq.mode !== 'client') return { p_customer: null, p_office: null, p_policy: null, p_one_off: true, p_standalone: false };
      const cu = custOf(Number($q('#nqCust').value)), sa = nq.basis === 'standalone' || (cu && cu.cover_type === 'one_off');
      return { p_customer: cu ? cu.id : null, p_office: Number($q('#nqOff').value) || null, p_policy: sa ? null : Number($q('#nqPol').value) || null, p_one_off: false, p_standalone: !!sa }; };
    const run = async (save, b) => {
      const pp = read(), err = t => { $q('#nqErr').textContent = t; };
      if(pp.goods_description.length < 2) return err('Describe the goods.');
      if(!(pp.invoice_value > 0)) return err('Enter the invoice value.');
      if(nq.mode === 'client' && !ctxArgs().p_customer) return err('Choose the client (or add one on the spot).');
      err(''); busy(b, true);
      const { data, error } = await sb.rpc('admin_indicate', Object.assign({ p: pp, p_save: !!save }, ctxArgs()));
      busy(b, false);
      if(error) return err(error.message);
      nq.p = pp; nq.last = { data, args: ctxArgs() };
      paintOut();
      return data;
    };
    $q('#nqCalc').addEventListener('click', e => run(false, e.currentTarget));
    const rowOf = (x, ref) => { const pp = nq.p, n = x.n || {};
      return { ref: ref || '', goods_description: pp.goods_description, commodity_id: n.commodity_id, commodity_name: n.commodity_name, packaging: n.packaging, conveyance: n.conveyance, origin_country: n.origin_country, origin_place: pp.origin_place, origin_name: n.origin_name,
        dest_country: n.dest_country, dest_place: pp.dest_place, dest_name: n.dest_name, transit_countries: n.transit_countries, departure_date: n.departure_date, invoice_value: n.invoice_value, freight_value: n.freight_value, currency: n.currency, uplift_pct: n.uplift_pct, sum_insured: n.sum_insured,
        cover: n.cover, war_strikes: n.war_strikes, on_deck: n.on_deck, interest_only: n.interest_only, ext_hssc: n.ext_hssc, ext_liw: n.ext_liw, incoterm: n.incoterm, insured_party: n.insured_party, vessel: n.vessel, insured_name: pp.insured_name,
        status: x.status, rate_pct: x.rate, premium_gross: x.gross, premium: x.net, discount_pct: x.disc, min_applied: x.min_hit, reasons: x.reasons, conditions: x.conditions, deductible_text: x.deductible, issued_at: new Date().toISOString(), company: pp.insured_name || '' }; };
    const quoteData = (x, row) => { const n = x.n || {}, conv = (FC.CONVEYANCE[n.conveyance] || {}).label || '';
      const net = Number(x.net), lines = [{ label: 'Cargo, ' + ((FC.COVER[n.cover] || {}).clause || '') + (n.war_strikes ? ', incl. war & strikes' : ''), sum: Number(n.sum_insured), rate: Number(x.rate), premium: Math.round(Number(n.sum_insured) * Number(x.rate)) / 100 }];
      return { client: row.insured_name || '', goods: row.goods_description, packaging: row.packaging || '', conveyance: n.conveyance, originCountry: n.origin_country, originPlace: row.origin_place || '', destCountry: n.dest_country, destPlace: row.dest_place || '',
        voyage: [row.origin_place, n.origin_name].filter(Boolean).join(', ') + ' to ' + [row.dest_place, n.dest_name].filter(Boolean).join(', ') + ((n.transit_countries || []).length ? ' via ' + n.transit_countries.map(cName).join(', ') : ''),
        period: n.departure_date ? 'Transit commencing on or about ' + FC.date(n.departure_date) : 'Single transit as per voyage', conditions: ((FC.COVER[n.cover] || {}).clause || '') + (n.war_strikes ? ', Institute War Clauses (Cargo), Institute Strikes Clauses (Cargo)' : '') + ', warehouse to warehouse',
        insurer: setting('default_insurer', ''), deductible: x.deductible || '', special: x.conditions || '', currency: n.currency, discountPct: 0, minPremium: Number(x.min) || 0, taxPct: 0, lines,
        subtotal: lines[0].premium, discountAmount: 0, net, minApplied: !!x.min_hit, tax: 0, total: net, sumInsured: Number(n.sum_insured), closing: setting('quote_closing', ''), issuedAt: new Date().toISOString(),
        handler: { name: me().full_name || '', email: me().email }, incoterm: n.incoterm || '', vessel: n.vessel || '', _conv: conv }; };
    const paintOut = () => {
      const out = $q('#nqOut'), L = nq.last; if(!L) return;
      const x = L.data.one_off || L.data.result, oneOff = L.args.p_one_off || L.args.p_standalone || !!L.data.one_off, saved = L.data.saved;
      out.innerHTML = `<div class="nq-head"><h3>${L.args.p_one_off ? 'One-off indication' : L.args.p_standalone ? 'Standalone one-off · ' + esc((L.data.customer || {}).name || '') : 'Indication · ' + esc(L.data.policy ? polLabel(L.data.policy) : ((L.data.customer || {}).name || '') + ' (client configuration)') + (L.data.one_off ? ' - out of cover' : '')}</h3>${saved ? chip('accepted', 'Logged as ' + saved.ref) : ''}</div>${L.data.policy && !L.args.p_standalone ? polCoverNote({ policy_id: L.data.policy.id, departure_date: nq.p.departure_date }) : ''}${resultHtml(L.data, nq.p.currency)}<div class="toolbar nq-acts" style="margin-top:12px"></div>`;
      const acts = out.querySelector('.nq-acts');
      if(nq.mode === 'client' && !saved){
        const us = liveUsers().filter(u => (userCust(u) || {}).id === L.args.p_customer && !u.is_admin);
        if(us.length){ const s = FC.el(`<select class="input" id="nqUser" aria-label="On behalf of" style="max-width:240px"><option value="">Logged as staff</option>${us.map(u => `<option value="${u.id}" ${u.id === nq.user ? 'selected' : ''}>For ${esc(u.full_name || u.email)}</option>`).join('')}</select>`); s.addEventListener('change', () => { nq.user = s.value; }); acts.appendChild(s); }
      }
      if(!saved) acts.appendChild(btn('Add to Requests', 'primary', async b => {
        busy(b, true);
        const { data, error } = await sb.rpc('admin_indicate', Object.assign({ p: nq.p, p_save: true, p_user: (out.querySelector('#nqUser') || {}).value || null }, L.args));
        busy(b, false);
        if(error) return toast(error.message, 'error');
        nq.last.data = data; toast('Logged as ' + data.saved.ref + ' in Requests.'); await loadAll(); paintOut();
      }));
      else acts.appendChild(btn('Open in Requests', 'primary', () => openCase(saved.id)));
      // direct certificate: case created now (retroactively, stage bound), certificate data file straight away
      const dcu = nq.mode === 'client' ? custOf(L.args.p_customer) : null;
      if(!saved && dcu && dcu.direct_certificate_enabled && dcu.fdf_certificate_enabled) acts.appendChild(btn('Issue certificate directly', 'ok', async b => {
        const al = (x.alerts || []).filter(a => a.level === 'red' || a.level === 'orange');
        if(x.status !== 'quoted' || al.length || L.data.one_off){
          const why = [x.status !== 'quoted' ? 'no automatic rate (' + (FC.STATUS[x.status] || x.status) + ')' : '', L.data.one_off ? 'out of cover' : ''].concat(al.map(a => a.text)).filter(Boolean);
          if(!(await FC.confirm('Issue the certificate anyway?', 'Check first: ' + why.join('; ') + '.', 'Issue anyway', 'danger'))) return;
        }
        busy(b, true);
        const { data, error } = await sb.rpc('admin_indicate', Object.assign({ p: nq.p, p_save: true, p_user: (out.querySelector('#nqUser') || {}).value || null, p_direct: true }, L.args));
        busy(b, false);
        if(error) return toast(error.message, 'error');
        nq.last.data = data; await loadAll(); paintOut();
        const r = S.rows.find(z => z.id === data.saved.id);
        if(r) certificateDialog(r, null, { direct:true }).then(async ok => { if(ok){ toast('Case ' + data.saved.ref + ' recorded as bound with its certificate.'); await loadAll(); } });
      }));
      acts.appendChild(btn('Text to insurer', 'ghost', () => { const sr = saved && S.rows.find(z => z.id === saved.id); insurerText(sr || Object.assign(rowOf(x, saved && saved.ref), { red_sea: nq.p.red_sea, party_role_other: nq.p.party_role_other, details: {} })); }));
      if(oneOff){
        const row = rowOf(x, saved && saved.ref);
        acts.appendChild(btn('Copy text for customer', 'ghost', async () => { const h = indicationHtml(row); const ok = await FC.copyRich(FC.emailHtml(h), FC.htmlText(h)); toast(ok ? 'Copied - paste it into your e-mail.' : 'Copy failed.', ok ? undefined : 'error'); }));
        acts.appendChild(btn('Download quotation', 'ghost', async b => { busy(b, true);
          try{ if(x.status === 'quoted') FC.saveBlob(await FCPDF.quotation({ data: quoteData(x, row), valid_until: new Date(Date.now() + 3 * 864e5).toISOString(), version:1, created_at: new Date().toISOString() }, { ref: row.ref }), FCPDF.fileName('MARINCON_Quotation', row.ref || 'one-off'));
            else FC.saveBlob(await FCPDF.indication(row), FCPDF.fileName('MARINCON_Indication', row.ref || 'one-off')); }
          catch(e){ console.error(e); toast('PDF failed.', 'error'); } busy(b, false); }));
      }
      if(saved) acts.appendChild(btn('Create quotation', 'ghost', () => { const r = S.rows.find(z => z.id === saved.id); if(r) quotationEditor(r).then(async ok => { if(ok){ await loadAll(); tab = 'quotations'; $$('[data-atab]', root).forEach(z => z.setAttribute('aria-selected', String(z.dataset.atab === 'quotations'))); render(); } }); }));
    };
    if(nq.last) paintOut();
  }

  // =================================================================== QUOTATIONS
  const qtSel = new Set();
  let qtFilter = 'live';
  // the quotation as text for the client (respects rate / premium display), wrapped in the client e-mail template
  function quoteTextHtml(q, r){
    const d = q.data || {}, mode = q.display_mode || d.displayMode || 'both', sR = FC.showRate(mode), sP = FC.showPremium(mode), tax = Number(d.taxPct) > 0;
    const doc = d.doc ? (() => { const x = document.createElement('div'); x.innerHTML = FC.cleanHtml(d.doc); x.querySelectorAll('section[data-cat="pricing"]').forEach(e => e.remove()); return x.innerHTML; })() : '';
    const lines = (d.lines || []).map(l => `<p><b>${esc(l.label)}:</b> sum insured ${esc(money2(l.sum, d.currency))}${sR ? ', rate ' + esc(FC.pct(l.rate)) : ''}${sP ? ', premium ' + esc(money2(l.premium, d.currency)) : ''}</p>`).join('');
    const prem = sP ? (tax ? `<p><b>Net premium:</b> ${esc(money2(d.net, d.currency))}<br><b>German IPT (${esc(Number(d.taxPct))}%):</b> ${esc(money2(d.tax, d.currency))}<br><b>Gross total incl. IPT:</b> ${esc(money2(d.total, d.currency))}</p>` : `<p><b>Total premium payable:</b> ${esc(money2(d.total, d.currency))}</p>`) : (tax ? `<p>German IPT (${esc(Number(d.taxPct))}%) is added to the premium.</p>` : '');
    const quote = `<h4>Quotation ${esc(r.ref || '')}${q.version > 1 ? ' / v' + q.version : ''}</h4><p><b>Assured:</b> ${esc(d.client || '')}</p><p><b>Goods:</b> ${esc(d.goods || '')}</p><p><b>Voyage:</b> ${esc(d.voyage || '')}</p><p><b>Conditions:</b> ${esc(d.conditions || '')}</p>${lines}${prem}${Number(d.minPremium) > 0 ? '<p><b>Minimum premium:</b> ' + esc(money2(d.minPremium, d.currency)) + '</p>' : ''}<p><b>Deductible:</b> ${esc(d.deductible || '-')}</p><p><b>Valid until:</b> ${esc(FC.dateTime(q.valid_until))}</p>${doc}${d.closing ? '<p>' + esc(d.closing) + '</p>' : ''}`;
    const lv = caseLevel(r), t = tplFor('client_text', lv.custId, lv.polId), body = t && String(t.body || '').trim() ? t.body : '[[quotation]]';
    const ctx = mergeCtx(r, Object.assign({}, d, { validUntil: q.valid_until }));
    if(!sP) ['premium_amount', 'ipt_amount', 'total_amount'].forEach(k => ctx[k] = '');
    if(!sR) ctx.rate_pct = '';
    const merged = FC.merge(body, ctx);
    return /\[\[quotation\]\]/.test(merged) ? merged.replace(/<p>\s*\[\[quotation\]\]\s*<\/p>|\[\[quotation\]\]/, quote) : merged + quote;
  }
  async function copyQuoteText(q, r){ const lv = caseLevel(r), h = quoteTextHtml(q, r), f = (q.data || {}).fmt || fmtFor(lv.custId, lv.polId); const ok = await FC.copyRich(FC.emailHtml(h, f), FC.htmlText(h)); toast(ok ? 'Copied - paste it into your e-mail.' : 'Copy failed.', ok ? undefined : 'error'); }
  A.quoteTextHtml = quoteTextHtml;
  function renderQuotations(body){
    const all = [].concat(...Object.values(S.quotes)).map(q => ({ q, r: S.rows.find(x => x.id === q.indication_id) })).filter(x => x.r).sort((a, b) => new Date(b.q.sent_at || b.q.created_at) - new Date(a.q.sent_at || a.q.created_at));
    const stOf = q => q.status === 'open' && new Date(q.valid_until) < Date.now() ? 'expired' : q.status;
    const match = (x, k) => k === 'all' || (k === 'live' ? stOf(x.q) === 'open' && x.q.send_status !== 'saved' : k === 'saved' ? stOf(x.q) === 'open' && x.q.send_status === 'saved' : stOf(x.q) === k);
    body.appendChild(FC.el(`<div class="stats">${[['saved','Saved - not sent'],['live','Sent, open'],['accepted','Accepted'],['declined','Declined'],['expired','Expired'],['superseded','Revised (older versions)'],['all','All']].map(([k, l]) => `<button type="button" class="stat stat-btn${k === 'saved' && all.some(x => match(x, 'saved')) ? ' alert' : ''}" data-qf="${k}" aria-pressed="${qtFilter === k}"><b>${all.filter(x => match(x, k)).length}</b><span>${l}</span></button>`).join('')}</div>`));
    body.querySelectorAll('[data-qf]').forEach(b => b.addEventListener('click', () => { qtFilter = b.dataset.qf; render(); }));
    const rows = all.filter(x => match(x, qtFilter));
    const pdf = async x => { try{ FC.saveBlob(await FCPDF.quotation(x.q, x.r), FCPDF.fileName('MARINCON_Quotation', x.r.ref, 'v' + x.q.version)); }catch(e){ console.error(e); toast('PDF failed.', 'error'); } };
    const after = async ok => { if(ok){ await loadAll(); render(); } };
    const edit = x => x.q.status === 'open' && x.q.send_status === 'saved' ? quotationEditor(x.r, x.q.data, x.q.id, { draft: x.q }).then(after) : quotationEditor(x.r, x.q.data, x.q.id).then(after);
    // copy as a new reference: a new case with the same shipment, customer, office and policy; the quotation opens prefilled
    const copyNewRef = async x => {
      const r = x.r, og = orgOfCase(r);
      const p = { commodity_id: r.commodity_id, goods_description: r.goods_description, packaging: r.packaging, conveyance: r.conveyance, origin_country: r.origin_country, origin_place: r.origin_place, dest_country: r.dest_country, dest_place: r.dest_place,
        transit_countries: r.transit_countries || [], invoice_value: Number(r.invoice_value), currency: r.currency, freight_value: Number(r.freight_value || 0), uplift_pct: Number(r.uplift_pct), cover: r.cover, war_strikes: r.war_strikes, on_deck: r.on_deck, interest_only: r.interest_only,
        ext_hssc: r.ext_hssc, ext_liw: r.ext_liw, incoterm: r.incoterm, insured_party: r.insured_party, vessel: r.vessel, red_sea: r.red_sea || 'auto', details: r.details || {}, insured_country: r.insured_country, ftz: r.ftz, insured_name: r.insured_name, insured_address: r.insured_address, customer_ref: r.customer_ref, company: r.company,
        departure_date: r.departure_date && r.departure_date >= FC.today() ? r.departure_date : null };
      const { data, error } = await sb.rpc('admin_indicate', { p, p_customer: r.customer_id || null, p_office: r.office_id || null, p_policy: og.policy ? og.policy.id : null, p_one_off: !og.policy, p_save: true, p_user: r.user_id });
      if(error) return toast(error.message, 'error');
      await loadAll();
      const nr = S.rows.find(z => z.id === data.saved.id); if(!nr) return;
      toast('New reference ' + data.saved.ref + ' - the quotation opens as a copy.');
      const d = JSON.parse(JSON.stringify(x.q.data || {})); delete d.issuedAt;
      quotationEditor(nr, d, x.q.id).then(async ok => { await loadAll(); render(); });
    };
    const certOf = x => S.certs.filter(c => c.indication_id === x.r.id).pop();
    selList({ host: body, rows, id: x => x.q.id, sel: qtSel, search: x => [x.r.ref, (x.q.data || {}).client, who(x.r).company, (x.q.data || {}).goods, x.r.origin_country, x.r.dest_country].join(' '), placeholder:'Search reference, assured, customer, goods',
      empty: 'No quotations here yet. Create one from a request or from New quotation.',
      cols:[ { l:'Reference', html: x => `<button type="button" class="linkbtn qt-open"><b>${esc(x.r.ref || '#' + x.r.id)}</b></button>${x.q.version > 1 ? ' <span class="xs muted">v' + x.q.version + '</span>' : ''}` },
        { l:'Customer / assured', html: x => `${esc(who(x.r).company)}<br><span class="xs muted">${esc((x.q.data || {}).client || '')}</span>` },
        { l:'Route', html: x => `<b>${esc(x.r.origin_country)} → ${esc(x.r.dest_country)}</b><br><span class="xs muted">${esc((FC.CONVEYANCE[x.r.conveyance] || {}).short || '')}</span>` },
        { l:'Total', cls:'r num', html: x => esc(money2((x.q.data || {}).total, (x.q.data || {}).currency)) + `<br><span class="xs muted">${esc((FC.DISPLAY[x.q.display_mode || (x.q.data || {}).displayMode] || FC.DISPLAY.both).toLowerCase())}</span>` },
        { l:'Status', html: x => chip(stOf(x.q), stOf(x.q) === 'superseded' ? 'revised' : stOf(x.q)) + ' ' + sendChip(x.q) },
        { l:'Sent', cls:'xs', html: x => x.q.send_status === 'saved' ? '<span class="muted">not sent</span>' : esc(FC.dateTime(x.q.sent_at || x.q.created_at)) }, { l:'Valid until', cls:'xs', html: x => esc(FC.dateTime(x.q.valid_until)) } ],
      onRow: (tr, x) => tr.querySelector('.qt-open').addEventListener('click', () => openCase(x.r.id)),
      menu: x => [
        x.q.status === 'open' ? [x.q.send_status === 'saved' ? 'Send to client' : 'Resend to client', () => sendDialog(x.q, x.r)] : null,
        ['Edit quotation' + (x.q.status === 'open' && x.q.send_status === 'saved' ? '' : ' (new version)'), () => edit(x)],
        ['Copy / duplicate as new version', () => quotationEditor(x.r, x.q.data, x.q.id).then(after)], ['Copy / duplicate as new reference', () => copyNewRef(x)],
        ['View sending history', () => historyDialog(x.r, x.q)], '-',
        certOf(x) ? ['Download certificate .fdf', () => fdfDownload(certOf(x))] : null,
        certOn(x.r) && ['accepted', 'open'].includes(x.q.status) ? ['Proceed to certificate', () => certificateDialog(x.r).then(after)] : null,
        ['Download quotation PDF', () => pdf(x)], ['Copy text for customer', () => copyQuoteText(x.q, x.r)], ['Text to insurer', () => insurerText(x.r)], ['Open case', () => openCase(x.r.id)],
        x.q.status === 'open' ? '-' : null, x.q.status === 'open' ? ['Withdraw', async () => { if(!(await FC.confirm('Withdraw this quotation?', 'The client can no longer accept it.', 'Withdraw', 'danger'))) return; const { error } = await sb.rpc('admin_withdraw_quotation', { p_quotation_id: x.q.id }); if(error) return toast(error.message, 'error'); await loadAll(); render(); }, 'danger'] : null ],
      bulk:[ ['Send selected', async rs => { const todo = rs.filter(x => x.q.status === 'open' && x.q.send_status === 'saved'); if(!todo.length) return toast('None of the selected quotations is saved and unsent.');
          if(!(await FC.confirm('Send ' + todo.length + ' quotation(s)?', 'Each client sees the quotation in the portal and gets an e-mail. Every sending is logged.', 'Send'))) return;
          for(const x of todo){ const { error } = await sb.rpc('admin_send_quotation', { p_quotation_id: x.q.id, p_method:'portal_email', p_note:null }); if(error) toast((x.r.ref || '') + ': ' + error.message, 'error'); } qtSel.clear(); await loadAll(); render(); }],
        ['Download PDFs', async rs => { for(const x of rs) await pdf(x); }],
        ['Export CSV', rs => csvSave('FREIGHTCON_quotations', ['Reference','Version','Customer','Assured','From','To','Goods','Currency','Total','Status','Sending','Sent','Valid until'], rs.map(x => [x.r.ref, x.q.version, who(x.r).company, (x.q.data || {}).client, x.r.origin_country, x.r.dest_country, (x.q.data || {}).goods, (x.q.data || {}).currency, (x.q.data || {}).total, stOf(x.q), x.q.send_status, x.q.sent_at || '', x.q.valid_until]))],
        ['Withdraw', async rs => { const open = rs.filter(x => x.q.status === 'open'); if(!open.length) return toast('None of the selected quotations is open.'); if(!(await FC.confirm('Withdraw ' + open.length + ' quotation(s)?', 'The clients can no longer accept them.', 'Withdraw', 'danger'))) return; for(const x of open) await sb.rpc('admin_withdraw_quotation', { p_quotation_id: x.q.id }); qtSel.clear(); await loadAll(); render(); }, 'danger'] ] });
  }

  // =================================================================== CERTIFICATES
  const ctSel = new Set();
  function renderCertificates(body){
    const rows = S.certs.map(c => ({ c, r: S.rows.find(x => x.id === c.indication_id) })).filter(x => x.r).sort((a, b) => new Date(b.c.created_at) - new Date(a.c.created_at));
    body.appendChild(FC.el(`<div class="notice info fdf-help" style="margin:0 0 12px"><b>Certificates and .fdf files</b>${esc(FC.FDF_HINT)} Every row has its own .fdf button; numbers come from the numbering matrix of the policy year.</div>`));
    selList({ host: body, rows, id: x => x.c.id, sel: ctSel, search: x => [x.c.number, x.r.ref, who(x.r).company, (x.c.data || {}).holder, (x.c.data || {}).goods].join(' '), placeholder:'Search number, reference, client, holder',
      empty:'No certificates yet. Issue one from an accepted quotation or with a direct certificate.',
      cols:[ { l:'Certificate', html: x => `<b>${esc(x.c.number)}</b> ${chip('neutral', CERT_MODE[x.c.numbering_mode] || 'number')}${(x.c.data || {}).issued_by_client ? ' ' + chip('pending', 'by client') : ''}` },
        { l:'Case', html: x => `<button type="button" class="linkbtn ct-open">${esc(x.r.ref || '#' + x.r.id)}</button>${x.r.is_direct_certificate ? ' ' + chip('accepted', 'direct') : ''}` },
        { l:'Client / holder', html: x => `${esc(who(x.r).company)}<br><span class="xs muted">${esc(((x.c.data || {}).holder || '').slice(0, 60))}</span>` },
        { l:'Policy year', cls:'xs', html: x => { const y = S.polYears.find(z => z.id === x.c.policy_year_id), po = y && polOf(y.policy_id); return y ? esc((po ? (po.policy_no || po.name) + ' · ' : '') + y.label) : '<span class="muted">-</span>'; } },
        { l:'Sum insured', cls:'r num', html: x => esc(((x.c.data || {}).curr || '') + ' ' + ((x.c.data || {}).sum || '')) },
        { l:'Issued', cls:'xs', html: x => esc(FC.dateTime(x.c.created_at)) },
        { l:'.fdf', html: () => '<button type="button" class="btn btn-ok btn-sm ct-fdf">Download .fdf</button>' } ],
      onRow: (tr, x) => { tr.querySelector('.ct-open').addEventListener('click', () => openCase(x.r.id)); tr.querySelector('.ct-fdf').addEventListener('click', () => fdfDownload(x.c)); },
      menu: x => [['Download .fdf', () => fdfDownload(x.c)], ['Open / edit certificate', () => certificateDialog(x.r, x.c).then(async ok => { if(ok){ await loadAll(); render(); } })], ['Open case', () => openCase(x.r.id)]],
      bulk:[ ['Download .fdf files', async rs => { for(const x of rs){ fdfDownload(x.c); await new Promise(res => setTimeout(res, 250)); } }],
        ['Export CSV', rs => csvSave('FREIGHTCON_certificates', ['Number','Mode','Case','Client','Holder','Currency','Sum insured','Policy year','Issued'], rs.map(x => [x.c.number, x.c.numbering_mode, x.r.ref, who(x.r).company, (x.c.data || {}).holder, (x.c.data || {}).curr, (x.c.data || {}).sum, (S.polYears.find(z => z.id === x.c.policy_year_id) || {}).label || '', x.c.created_at]))] ] });
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
      <div class="stat"><b class="num" style="font-size:20px">${esc(Object.keys(reserve).length ? Object.entries(reserve).map(([c, v]) => money2(v, c)).join(' · ') : '-')}</b><span>Reserves on open claims (internal)</span></div></div>`));
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
          <td class="r num">${c.estimated_amount != null ? esc(money2(c.estimated_amount, c.currency)) : '-'}</td>
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
          <dt>When / where</dt><dd>${esc([cc.incident_date ? 'incident ' + FC.date(cc.incident_date) : '', cc.discovered_date ? 'discovered ' + FC.date(cc.discovered_date) : '', cc.place].filter(Boolean).join(' · ') || '-')}</dd>
          <dt>Description</dt><dd style="white-space:pre-wrap">${esc(cc.description)}</dd>
          <dt>Estimated loss</dt><dd>${cc.estimated_amount != null ? esc(money2(cc.estimated_amount, cc.currency)) : 'Not stated'}</dd>
          <dt>Goods are at</dt><dd>${esc(cc.goods_location || '-')}</dd>
          <dt>Carrier</dt><dd>${cc.carrier_notified ? 'Notified in writing' : '<b style="color:var(--danger)">Not notified yet</b>'} · ${cc.receipt_remarks ? 'remarks on receipt' : 'no remarks on receipt'}</dd>
          <dt>Contact</dt><dd>${esc([cc.contact_name, cc.contact_phone].filter(Boolean).join(', '))}${p.email ? ', <a href="mailto:' + esc(p.email) + '">' + esc(p.email) + '</a>' : ''}</dd>
          <dt>Shipment</dt><dd>${esc(i.ref || '')} · ${esc(i.goods_description || '')}<br><span class="xs muted">${esc(i.origin_country || '')} → ${esc(i.dest_country || '')}, sum insured ${i.sum_insured ? esc(money2(i.sum_insured, i.currency)) : '-'}${cc.cover_note_no ? ', cover note ' + esc(cc.cover_note_no) : ''}${i.vessel ? ', vessel ' + esc(i.vessel) : ''}</span>${i.id ? ' <button type="button" class="linkbtn" id="cdCase">Open case</button>' : ''}</dd></dl></section>
        <section><h3>Files (${files.length})</h3><div class="cl-thumbs" id="cdFiles">${files.length ? '' : '<p class="xs muted" style="margin:0">No files.</p>'}</div>
          <label class="btn btn-ghost btn-sm" style="cursor:pointer;margin-top:10px">${FC.icon.upload}Add file for the client<input type="file" id="cdUp" multiple hidden></label></section>
        <section><h3>Update</h3><div class="grid2">
            <div class="field"><label for="cdSt">Status</label><select id="cdSt">${Object.entries(CLS()).map(([k, v]) => `<option value="${k}" ${k === cc.status ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></div>
            <div class="field"><label for="cdIns">Insurer's claim number</label><input id="cdIns" maxlength="60" value="${esc(cc.insurer_claim_no || '')}"></div>
            <div class="field"><label for="cdSet">Settled amount (${esc(cc.currency || 'EUR')})</label><input id="cdSet" inputmode="decimal" value="${cc.settled_amount != null ? esc(cc.settled_amount) : ''}"></div>
            <div class="field"><label for="cdInsr">Insurer</label><select id="cdInsr"><option value="">-</option>${S.insurers.map(x => `<option value="${x.id}" ${String(ci.insurer_id) === String(x.id) ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div></div>
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
    // German insurance premium tax and the default display of quotations
    const I = Object.assign({ default_rate:19, default_mode:'auto', rule_holder_de:true, rule_assured_de:true, rule_domestic:true, rule_from_de:false, rule_to_de:false, combine:'domicile_and_route' }, S.ipt || {});
    const ck = (id, on, label, hint) => `<label class="switch"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><span><b>${label}</b>${hint ? '<span>' + hint + '</span>' : ''}</span></label>`;
    const ic = FC.el(`<div class="card ipt-card"><h2 style="margin:0 0 4px">German IPT (Versicherungsteuer)</h2><p class="small muted" style="margin:0 0 12px">Default for the configuration. Clients and policies can switch it to on, auto or off; every quotation and indication can be switched by hand.</p>
      <div class="grid3"><div class="field"><label for="ipRate">Default rate %</label><input id="ipRate" inputmode="decimal" value="${esc(Number(I.default_rate))}"></div>
        <div class="field"><label for="ipMode">Default mode</label><select id="ipMode">${Object.entries(FC.IPT_MODE).map(([k, l]) => `<option value="${k}" ${k === I.default_mode ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
        <div class="field"><label for="ipComb">Auto: when does IPT apply</label><select id="ipComb"><option value="domicile_and_route" ${I.combine === 'domicile_and_route' ? 'selected' : ''}>German policyholder / assured AND a German route rule</option><option value="any" ${I.combine === 'any' ? 'selected' : ''}>Any single rule matches</option></select></div></div>
      <div class="grid2"><div><b class="xs">Domicile (policyholder / assured)</b>${ck('ipHolder', I.rule_holder_de, 'Policyholder in Germany', 'Country of the policy, else of the client, office or user')}${ck('ipAss', I.rule_assured_de, 'Assured in Germany', 'Holder of the policy / party domicile on the request')}</div>
        <div><b class="xs">Route (starting from / heading to)</b>${ck('ipDom', I.rule_domestic, 'Domestic German transport', 'Starting from and heading to Germany')}${ck('ipFrom', I.rule_from_de, 'Starting from Germany', '')}${ck('ipTo', I.rule_to_de, 'Heading to Germany', '')}</div></div>
      <div class="toolbar ipt-test"><span class="xs">Try it:</span><input class="input" id="itF" maxlength="2" placeholder="From" value="DE" aria-label="From country"><input class="input" id="itT" maxlength="2" placeholder="To" value="DE" aria-label="To country"><input class="input" id="itH" maxlength="2" placeholder="Holder" value="DE" aria-label="Policyholder country"><input class="input" id="itA" maxlength="2" placeholder="Assured" value="DE" aria-label="Assured country"><span class="ipt-badge" id="itOut"></span></div>
      <div class="toolbar" id="ipActs" style="margin-top:8px"></div>
      <h3 style="margin:18px 0 6px">Quotations: what clients see</h3><div class="toolbar" style="margin:0"><select class="input" id="dmDef" style="max-width:260px">${Object.entries(FC.DISPLAY).map(([k, l]) => `<option value="${k}" ${k === setting('quote_display_mode', 'both') ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select><span class="xs muted">Default of the configuration; clients, policies and each quotation can override it.</span></div></div>`);
    body.appendChild(ic);
    const readIpt = () => ({ default_rate: FC.parseNum(ic.querySelector('#ipRate').value), default_mode: ic.querySelector('#ipMode').value, combine: ic.querySelector('#ipComb').value, rule_holder_de: ic.querySelector('#ipHolder').checked, rule_assured_de: ic.querySelector('#ipAss').checked,
      rule_domestic: ic.querySelector('#ipDom').checked, rule_from_de: ic.querySelector('#ipFrom').checked, rule_to_de: ic.querySelector('#ipTo').checked });
    const tryIt = () => { const r2 = FC.iptEval(readIpt(), null, ic.querySelector('#itF').value, ic.querySelector('#itT').value, ic.querySelector('#itH').value, ic.querySelector('#itA').value); const o = ic.querySelector('#itOut'); o.textContent = r2.reason; o.className = 'ipt-badge' + (r2.applied ? ' on' : ''); };
    ic.addEventListener('input', tryIt); ic.addEventListener('change', tryIt); tryIt();
    const canEdit = isStaffAdmin(); if(!canEdit) ic.querySelectorAll('input:not(.ipt-test input), select').forEach(x => x.disabled = true);
    if(canEdit){
      ic.querySelector('#ipActs').appendChild(btn('Save IPT settings', 'primary', async b => {
        const x = readIpt(); if(!(x.default_rate >= 0 && x.default_rate <= 100)) return toast('The rate must be between 0 and 100 %.', 'error');
        busy(b, true); const res = S.ipt ? await sb.from('german_ipt_settings').update(Object.assign({ updated_by: me().id, updated_at: new Date().toISOString() }, x)).eq('id', 1) : await sb.from('german_ipt_settings').insert(Object.assign({ id:1 }, x)); busy(b, false);
        if(res.error) return toast(res.error.message, 'error'); toast('IPT settings saved.'); await loadAll(); }));
      ic.querySelector('#dmDef').addEventListener('change', async e => { const { error } = await sb.from('settings').update({ value: e.target.value, updated_at: new Date().toISOString() }).eq('key', 'quote_display_mode'); if(error) return toast(error.message, 'error'); toast('Default display saved.'); await loadAll(); });
    }
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
    body.appendChild(FC.el('<h2 style="margin:12px 0 6px">Recent alerts</h2><p class="small muted" style="margin:0 0 10px">Each event the system sends via Telegram and e-mail. "Not sent" means the alert function has not run - check the webhook (see README).</p>'));
    const { data: ob } = await sb.from('outbox').select('*').order('id', { ascending:false }).limit(40);
    const ow = FC.el('<div class="tbl-wrap"></div>'); body.appendChild(ow);
    ow.innerHTML = `<table class="tbl"><thead><tr><th>When</th><th>Event</th><th>Details</th><th>Result</th></tr></thead><tbody>${(ob || []).map(o => `<tr><td class="xs">${esc(FC.dateTime(o.created_at))}</td><td>${esc(o.kind)}</td><td class="xs">${esc([o.payload.ref, o.payload.company, o.payload.email].filter(Boolean).join(', '))}</td><td class="xs">${o.processed_at ? esc(o.result || 'sent') : chip('pending', 'Not sent')}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No alerts yet.</td></tr>'}</tbody></table>`;
  }

  // poll for new work every 2 minutes while the page is open
  setInterval(async () => { if(document.hidden || !loaded) return; await loadAll(); if(root && !root.hidden && tab === 'requests' && !document.querySelector('.drawer, .dlg-back')) render(); }, 120000);
  // first badge paint even before the area is opened
  (async () => { try{ const { data } = await sb.rpc('admin_overview', { p_days: 1 }); const ib = document.getElementById('adminBadge'); const n = data ? data.open_requests + data.pending_users : 0; if(ib){ ib.hidden = !n; ib.textContent = n; } }catch(e){} })();
})();
