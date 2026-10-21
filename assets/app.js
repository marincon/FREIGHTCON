/* FREIGHTCON — customer area */
(async function(){
  'use strict';
  const { $, $$, sb, esc, money, money2, busy, toast } = FC;
  if(!sb){ document.body.innerHTML = '<p style="padding:40px">config.js is missing or incomplete. See README.</p>'; return; }
  // app.html and app.js must come from the same release; a stale app.html would break the form
  { const m = document.querySelector('meta[name="fc-version"]');
    if(!m || m.content !== '2026-10-21t'){ document.body.insertAdjacentHTML('afterbegin', '<div class="banner" style="position:relative;z-index:500">This page is out of date (app.html does not match the scripts). Upload the latest app.html to the top of the repository and reload.</div>'); return; } }

  // ---------- session & profile ----------
  const { data: { session } } = await sb.auth.getSession();
  if(!session){ location.replace('index.html'); return; }
  const { data: profile } = await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
  if(!profile || !profile.approved || profile.rejected){ await sb.auth.signOut(); location.replace('index.html'); return; }
  FC.profile = profile;
  let settings = {};
  try{ const r = await sb.rpc('public_settings'); settings = r.data || {}; }catch(e){}
  if(settings.brand_name) FC.brand = settings.brand_name;

  // ---------- header ----------
  $('#wm').innerHTML = FC.wordmarkHtml();
  $('#icBox').innerHTML = FC.icon.box; $('#icRoute').innerHTML = FC.icon.route; $('#icCoin').innerHTML = FC.icon.coin; $('#icShield').innerHTML = FC.icon.shield; $('#icDoc').innerHTML = FC.icon.doc; $('#icUser').innerHTML = FC.icon.user;
  $('#inviteBtn').innerHTML = FC.icon.gift; $('#feedbackBtn').innerHTML = FC.icon.chat;
  $$('[data-ic]').forEach(s => s.outerHTML = FC.icon[s.dataset.ic]);
  const paintTheme = () => { $('#themeBtn').innerHTML = FC.isDark() ? FC.icon.sun : FC.icon.moon; };
  FC.onTheme = paintTheme; paintTheme(); $('#themeBtn').addEventListener('click', e => FC.toggleTheme(e.currentTarget));
  // animations: auto (system setting) → on → off
  const paintMotion = () => { $('#motionBtn').textContent = 'Animations: ' + FC.motionPref(); };
  paintMotion(); $('#motionBtn').addEventListener('click', e => { e.stopPropagation(); const n = { auto:'on', on:'off', off:'auto' }[FC.motionPref()]; FC.setMotion(n); paintMotion(); toast(n === 'auto' ? 'Animations follow your system setting.' : n === 'on' ? 'Animations are on.' : 'Animations are off.'); });
  $('#avatarBtn').textContent = FC.initials(profile.full_name || profile.email);
  $('#whoName').textContent = profile.full_name || profile.email; $('#whoCo').textContent = profile.company || '';
  const menu = $('#accMenu'), av = $('#avatarBtn');
  const setMenu = on => { menu.hidden = !on; av.setAttribute('aria-expanded', String(on)); };
  av.addEventListener('click', e => { e.stopPropagation(); setMenu(menu.hidden); });
  document.addEventListener('click', e => { if(!menu.contains(e.target)) setMenu(false); });
  document.addEventListener('keydown', e => { if(e.key === 'Escape') setMenu(false); });
  $('#logoutBtn').addEventListener('click', async () => { await sb.auth.signOut(); location.replace('index.html'); });
  if(settings.maintenance === true) $('#maintBanner').hidden = false;

  // ---------- Terms of Use gate ----------
  if(settings.terms_version && profile.terms_version !== settings.terms_version){
    const ok = await FC.dialog({
      title: 'Terms of Use', dismissible: false,
      body: `<p style="margin-top:0">Please confirm the current Terms of Use to continue. Indications are non-binding; rates are confidential and must not be passed on.</p>
             <label class="check" style="display:flex;gap:10px;align-items:flex-start"><input type="checkbox" id="tgCb" style="margin-top:4px"><span>I accept the <a href="terms.html" target="_blank" rel="noopener">Terms of Use</a> and have read the <a href="privacy.html" target="_blank" rel="noopener">Privacy Notice</a>.</span></label>
             <div class="err-msg" id="tgErr"></div>`,
      actions: [
        { label:'Log out', kind:'ghost', onClick: async () => { await sb.auth.signOut(); location.replace('index.html'); return false; } },
        { label:'Accept and continue', kind:'primary', onClick: async (close, box) => {
            if(!box.querySelector('#tgCb').checked){ box.querySelector('#tgErr').textContent = 'Please tick the box to accept.'; return; }
            const { error } = await sb.rpc('accept_terms', { p_version: settings.terms_version });
            if(error){ box.querySelector('#tgErr').textContent = 'Could not save. Please try again.'; return; }
            return true;
        } }
      ]
    });
    if(!ok) return;
  }

  // ---------- idle log-out after 60 minutes (shared across tabs) ----------
  (function(){
    const LIMIT = 3600e3, WARN = 120e3, KEY = 'freightcon_last_activity';
    let last = Date.now(), lastWrite = 0, warnEl = null, done = false;
    const shared = () => { try{ return Number(localStorage.getItem(KEY)) || 0; }catch(e){ return 0; } };
    const touch = () => { const n = Date.now(); if(n - last < 1000) return; last = n; if(warnEl){ warnEl.remove(); warnEl = null; } if(n - lastWrite > 15000){ lastWrite = n; try{ localStorage.setItem(KEY, String(n)); }catch(e){} } };
    ['mousemove','mousedown','keydown','wheel','touchstart','scroll'].forEach(ev => window.addEventListener(ev, touch, { passive:true, capture:true }));
    const check = () => {
      if(done) return;
      const idle = Date.now() - Math.max(last, shared());
      if(idle >= LIMIT){ done = true; sb.auth.signOut().finally(() => location.replace('index.html?idle=1')); }
      else if(idle >= LIMIT - WARN && !warnEl){ warnEl = document.createElement('div'); warnEl.className = 'banner'; warnEl.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:400'; warnEl.textContent = 'You will be logged out in 2 minutes for inactivity. Move the mouse or press a key to stay.'; document.body.appendChild(warnEl); }
    };
    setInterval(check, 15000); document.addEventListener('visibilitychange', () => { if(!document.hidden) check(); });
  })();

  // ---------- reference data ----------
  let commodities = [], countries = [];
  {
    const [c1, c2] = await Promise.all([ sb.rpc('list_commodities'), sb.from('countries').select('iso2,name,sanctioned,on_request').order('name') ]);
    commodities = c1.data || []; countries = c2.data || [];
    if(c1.error || c2.error) toast('Could not load the cargo and country lists. Please reload the page.', 'error');
  }
  const countryName = iso => (countries.find(c => c.iso2 === iso) || {}).name || iso || '';
  FC.countryName = countryName;

  // ---------- form ----------
  const form = $('#shipForm');
  const fill = (sel, items, first) => { sel.innerHTML = (first ? `<option value="">${esc(first)}</option>` : '') + items.join(''); };
  { const groups = []; commodities.forEach(c => { const g = c.group_name || 'Other'; let x = groups.find(y => y[0] === g); if(!x){ x = [g, []]; groups.push(x); } x[1].push(c); });
    fill($('#fCommodity'), groups.map(([g, list]) => `<optgroup label="${esc(g)}">` + list.map(c => `<option value="${esc(c.id)}">${esc(c.name)}${c.on_request ? ' (quoted individually)' : ''}</option>`).join('') + '</optgroup>'), 'Choose…'); }
  const countryOpts = countries.map(c => `<option value="${esc(c.iso2)}">${esc(c.name)}</option>`);
  fill($('#fOrigin'), countryOpts, 'Choose…'); fill($('#fDest'), countryOpts, 'Choose…');
  $('#fDep').min = FC.today();
  FC.groupInput($('#fValue'));
  if(settings.uplift_pct != null) $('#fUplift').value = settings.uplift_pct;
  { const ex = settings.extensions || {}; if(ex.hssc && ex.hssc.label) $('#hsscLbl').textContent = ex.hssc.label; if(ex.liw && ex.liw.label) $('#liwLbl').textContent = ex.liw.label;
    if(ex.liw && ex.liw.deductible) $('#liwTxt').textContent = 'Covers shortage between the weight loaded and the weight delivered. Deductible ' + ex.liw.deductible + '. Small surcharge on the rate.'; }

  // end customers insured before → suggestions; picking one fills in the address
  let insureds = [];
  const loadInsureds = async () => { try{ const r = await sb.rpc('my_insureds'); insureds = r.data || []; $('#insList').innerHTML = insureds.map(x => `<option value="${esc(x.name)}">`).join(''); }catch(e){} };
  loadInsureds(); FC.loadInsureds = loadInsureds;
  $('#fInsName').addEventListener('change', () => { const x = insureds.find(i => i.name.toLowerCase() === $('#fInsName').value.trim().toLowerCase()); if(x && x.address && !$('#fInsAddr').value.trim()) $('#fInsAddr').value = x.address; });
  $('#fInco').insertAdjacentHTML('beforeend', Object.entries(FC.INCOTERMS).map(([k, t]) => `<option value="${k}">${k} — ${esc(t.name)}</option>`).join(''));
  const partyHost = $('#fParty');
  const convHost = $('#fConv');
  Object.entries(FC.CONVEYANCE).forEach(([k, v], i) => {
    const b = FC.el(`<button type="button" role="radio" data-v="${k}" aria-checked="${i === 0}">${FC.icon[k]}<span>${esc(v.label)}</span></button>`);
    convHost.appendChild(b);
  });
  const coverHost = $('#fCover');
  Object.entries(FC.COVER).forEach(([k, v], i) => {
    coverHost.appendChild(FC.el(`<label class="cover-opt" data-v="${k}"><input type="radio" name="cover" value="${k}" ${i === 0 ? 'checked' : ''}><div><b>${esc(v.clause)}</b><span>${esc(v.label)}: ${esc(v.text)}</span></div></label>`));
  });
  const segVal = host => (host.querySelector('[aria-checked="true"]') || {}).dataset.v;
  const segSet = (host, v) => host.querySelectorAll('button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.v === v)));
  [convHost, $('#fCur'), partyHost].forEach(h => h.addEventListener('click', e => { const b = e.target.closest('button'); if(b && !b.disabled){ segSet(h, b.dataset.v); onFormChange(); } }));
  // keyboard: arrows move within a radio group
  [convHost, $('#fCur'), partyHost].forEach(h => h.addEventListener('keydown', e => {
    if(!['ArrowLeft','ArrowRight'].includes(e.key)) return;
    const bs = Array.from(h.querySelectorAll('button')), i = bs.findIndex(b => b.getAttribute('aria-checked') === 'true');
    const n = bs[(i + (e.key === 'ArrowRight' ? 1 : bs.length - 1)) % bs.length]; segSet(h, n.dataset.v); n.focus(); onFormChange(); e.preventDefault();
  }));

  const isSea = c => c === 'sea_container' || c === 'sea_breakbulk';
  function readForm(){
    return {
      commodity_id: $('#fCommodity').value,
      goods_description: $('#fGoods').value.trim(),
      packaging: $('#fPacking').value,
      conveyance: segVal(convHost),
      origin_country: $('#fOrigin').value, origin_place: $('#fOriginPlace').value.trim(),
      dest_country: $('#fDest').value, dest_place: $('#fDestPlace').value.trim(),
      departure_date: $('#fDep').value || null,
      invoice_value: FC.parseNum($('#fValue').value),
      currency: segVal($('#fCur')),
      uplift_pct: FC.parseNum($('#fUplift').value),
      cover: (form.querySelector('input[name=cover]:checked') || {}).value,
      war_strikes: $('#fWar').checked,
      vessel: isSea(segVal(convHost)) ? $('#fVessel').value.trim() : '',
      incoterm: $('#fInco').value || null,
      insured_party: $('#fInco').value ? segVal(partyHost) : null,
      on_deck: segVal(convHost) === 'sea_breakbulk' && !$('#deckField').hidden && $('#fDeck').checked,
      interest_only: !$('#interestField').hidden && $('#fInterest').checked,
      insured_name: $('#fForCust').checked ? $('#fInsName').value.trim() : '',
      insured_address: $('#fForCust').checked ? $('#fInsAddr').value.trim() : '',
      customer_ref: $('#fCustRef').value.trim(),
      ext_hssc: !$('#extFields').hidden && !$('#hsscField').hidden && $('#fHssc').checked,
      ext_liw: !$('#extFields').hidden && !$('#liwField').hidden && $('#fLiw').checked
    };
  }
  function writeForm(r){
    $('#fCommodity').value = r.commodity_id || ''; $('#fGoods').value = r.goods_description || ''; $('#fPacking').value = r.packaging || '';
    segSet(convHost, r.conveyance || 'sea_container');
    $('#fOrigin').value = r.origin_country || ''; $('#fOriginPlace').value = r.origin_place || '';
    $('#fDest').value = r.dest_country || ''; $('#fDestPlace').value = r.dest_place || '';
    $('#fDep').value = r.departure_date && r.departure_date >= FC.today() ? r.departure_date : '';
    $('#fValue').value = r.invoice_value ? Number(r.invoice_value).toLocaleString('en-GB', { maximumFractionDigits:2 }) : '';
    segSet($('#fCur'), r.currency || 'EUR'); $('#fUplift').value = r.uplift_pct != null ? Number(r.uplift_pct) : (settings.uplift_pct || 10);
    const c = form.querySelector(`input[name=cover][value="${r.cover || 'icc_a'}"]`); if(c) c.checked = true;
    $('#fWar').checked = r.war_strikes !== false;
    $('#fVessel').value = r.vessel || ''; $('#fDeck').checked = !!r.on_deck; $('#fInterest').checked = !!r.interest_only; $('#fInco').value = r.incoterm || ''; segSet(partyHost, r.insured_party || 'seller');
    $('#fHssc').checked = !!r.ext_hssc; $('#fLiw').checked = !!r.ext_liw;
    $('#fForCust').checked = !!r.insured_name; $('#fInsName').value = r.insured_name || ''; $('#fInsAddr').value = r.insured_address || ''; $('#fCustRef').value = r.customer_ref || '';
    $$('.field.invalid', form).forEach(f => f.classList.remove('invalid'));
    onFormChange();
  }
  // sum insured glides to the new value instead of jumping
  let siShown = NaN, siRaf = 0;
  function tweenSi(to, cur){
    const el = $('#siOut'); cancelAnimationFrame(siRaf);
    if(!isFinite(to)){ siShown = NaN; el.textContent = '—'; return; }
    const from = isFinite(siShown) ? siShown : 0;
    if(FC.motionPref() === 'off' || from === to){ siShown = to; el.textContent = money2(to, cur); return; }
    const t0 = performance.now(), D = 380;
    const step = t => { const k = Math.min(1, (t - t0) / D), e = 1 - Math.pow(1 - k, 3); siShown = from + (to - from) * e; el.textContent = money2(Math.round(siShown * 100) / 100, cur); if(k < 1) siRaf = requestAnimationFrame(step); else siShown = to; };
    siRaf = requestAnimationFrame(step);
  }
  let liveReady = false;
  function onFormChange(){
    const v = readForm();
    const com = commodities.find(c => c.id === v.commodity_id);
    // covers allowed for this cargo
    $$('.cover-opt', coverHost).forEach(l => {
      const ok = !com || (com.allowed_covers || []).includes(l.dataset.v);
      l.classList.toggle('off', !ok); l.querySelector('input').disabled = !ok;
    });
    if(com && !(com.allowed_covers || []).includes(v.cover)){ const first = coverHost.querySelector('input:not(:disabled)'); if(first) first.checked = true; }
    $('#commodityHint').textContent = com ? (com.on_request ? 'This cargo is always quoted individually. You can still request a quotation.' : [com.description, com.deductible ? 'Deductible: ' + com.deductible : ''].filter(Boolean).join(' · ')) : '';
    $('#convHint').textContent = com && v.conveyance && !com.on_request && !(com.conveyances || []).includes(v.conveyance) ? 'This cargo is quoted individually for this conveyance.' : '';
    const land = v.conveyance === 'road' || v.conveyance === 'rail';
    $('#warLbl').textContent = land ? 'Strikes, riots & civil commotion' : 'War & strikes';
    $('#warTxt').textContent = land ? 'Institute Strikes Clauses (Cargo). War risks are not insurable on land transit.' : v.conveyance === 'air' || v.conveyance === 'air_charter' ? 'Institute War and Strikes Clauses (Air Cargo). Added to the premium.' : 'Institute War and Strikes Clauses (Cargo). Included in sea rates; untick to leave it out.';
    const si = isFinite(v.invoice_value) && v.invoice_value > 0 && isFinite(v.uplift_pct) ? v.invoice_value * (1 + v.uplift_pct / 100) : NaN;
    tweenSi(si, v.currency);
    $('#vesselField').hidden = !isSea(v.conveyance);
    $('#custFields').hidden = !$('#fForCust').checked;
    $('#hsscField').hidden = !(com && com.ext_hssc); $('#liwField').hidden = !(com && com.ext_liw); $('#extFields').hidden = $('#hsscField').hidden && $('#liwField').hidden;
    $('#deckField').hidden = !(v.conveyance === 'sea_breakbulk' && (!com || com.deck_allowed));
    const air = v.conveyance === 'air' || v.conveyance === 'air_charter';
    paintIncoterm(v);
    // contingency cover makes sense when the chosen party carries no risk on the main transit
    const t = FC.INCOTERMS[v.incoterm], party = v.insured_party || 'seller';
    const noMain = !!t && ((party === 'seller' && t.pt <= 2 && !t.insure) || (party === 'buyer' && t.pt === 3));
    $('#interestField').hidden = !noMain;
    if(noMain) $('#interestTxt').textContent = party === 'seller'
      ? `Under ${v.incoterm} the buyer insures the main transit. This cover protects the seller if the goods are damaged and the buyer does not pay or its insurance does not respond. Costs 40 % of full cover.`
      : `Under ${v.incoterm} the seller carries the transit risk. This cover protects the buyer if the goods arrive damaged and the seller's insurance does not respond. Costs 40 % of full cover.`;
    if(liveReady) paintLive(readForm());
  }
  // Incoterms: who carries the risk where, in plain words, with a small journey line
  function paintIncoterm(v){
    const host = $('#incoExplain'), t = FC.INCOTERMS[v.incoterm];
    partyHost.querySelectorAll('button').forEach(b => b.disabled = !t);
    if(!t){ host.innerHTML = `<div class="inco-head">Not sure which Incoterm applies?</div><p>It is in the sales contract or on the commercial invoice, e.g. "FOB Hamburg" or "CIF Shanghai". It decides who carries the transport risk and who has to insure. You can calculate without it.</p>`; return; }
    const party = v.insured_party || 'seller', other = party === 'seller' ? 'buyer' : 'seller';
    const pct = Math.round(t.pt / 3 * 100);
    const sellerMine = party === 'seller';
    const stops = FC.JOURNEY.filter(([x]) => t.sea || x !== 2).map(([x, l]) => `<i class="stop${x === 0 ? ' first' : x === 3 ? ' last' : ''}" style="left:${x / 3 * 100}%"><span>${esc(l)}</span></i>`).join('');
    const segA = pct > 0 ? `<div class="seg-a ${sellerMine ? 'mine' : 'theirs'}" style="width:${pct}%"></div><div class="lbl-a ${sellerMine ? 'mine-t' : 'theirs-t'}" style="left:${Math.max(pct / 2, 9)}%">Seller's risk</div>` : '';
    const segB = pct < 100 ? `<div class="seg-b ${sellerMine ? 'theirs' : 'mine'}" style="left:${pct}%;width:${100 - pct}%"></div><div class="lbl-b ${sellerMine ? 'theirs-t' : 'mine-t'}" style="left:${Math.min(pct + (100 - pct) / 2, 91)}%">Buyer's risk</div>` : '';
    const tips = [];
    if(t.sea && !(v.conveyance === 'sea_breakbulk'))
      tips.push(['warn', `${v.incoterm} is made for goods loaded directly on board a vessel (bulk, breakbulk). For ${v.conveyance === 'sea_container' ? 'containers' : 'air, road and rail'} the matching terms are FCA, CPT or CIP, because the risk should pass when the goods are handed to the carrier.`]);
    const com = commodities.find(c => c.id === v.commodity_id), aOk = !com || (com.allowed_covers || []).includes('icc_a');
    if(party === 'seller' && t.insure === 'A' && v.cover !== 'icc_a') tips.push(['warn', aOk ? 'Under CIP the seller must insure ICC (A). Please choose Institute Cargo Clauses (A) below.' : 'Under CIP the seller must insure ICC (A), which is not available online for this cargo. Request a quotation and we will find a solution.']);
    if(party === 'seller' && t.insure === 'C') tips.push(['', 'ICC (C) meets the minimum, but covers only major casualties. Most buyers expect ICC (A); it costs little more.']);
    if(party === 'seller' && t.insure && isFinite(v.uplift_pct) && v.uplift_pct < 10) tips.push(['warn', `Under ${v.incoterm} the sum insured must be at least 110 % of the invoice value. Set the uplift to 10 %.`]);
    if(FC.noRisk(v.incoterm, party)) tips.push(['', 'You can still calculate cover, e.g. to protect your own interest or because the other party asks for it.']);
    host.innerHTML = `<div class="inco-head">${esc(v.incoterm)}, ${esc(t.name)}</div><p class="xs muted" style="margin-top:2px">The risk passes from seller to buyer ${esc(t.point)}.</p>
      <div class="jr" role="img" aria-label="${esc(`Seller carries the risk up to ${t.point}, the buyer from there`)}">${segA}${segB}${stops}<b class="pass" style="left:${pct}%"></b></div>
      <p>${esc(t[party])}</p>${tips.map(([k, x]) => `<div class="inco-tip${k ? ' ' + k : ''}">${esc(x)}</div>`).join('')}`;
  }
  // ---------- live summary beside the form ----------
  const secs = Array.from(form.querySelectorAll('.form-sec'));
  secs.forEach((x, i) => { const h = x.querySelector('h2'); if(h) h.dataset.n = i + 1; });
  { const h = new Date().getHours(), first = (profile.first_name || (profile.full_name || '').split(' ')[0] || '').trim();
    $('#nsHi').textContent = (h < 11 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening') + (first ? ', ' + first : ''); }
  let laneKey = ''; liveReady = true;
  function paintLive(v){
    if(!document.getElementById('nsLive')) return;   // the result card is showing instead
    const com = commodities.find(c => c.id === v.commodity_id);
    const need = [!!v.commodity_id, v.goods_description.length >= 2, !!v.origin_country, !!v.dest_country, isFinite(v.invoice_value) && v.invoice_value > 0];
    const n = need.filter(Boolean).length;
    $('#nsProg').style.width = (n / need.length * 100) + '%'; $('#nsProgTxt').textContent = n === need.length ? 'Ready to calculate' : n + ' of ' + need.length + ' details';
    $('#nsLive').classList.toggle('ready', n === need.length); $('#nsCalc').disabled = n !== need.length;
    // section ticks
    const done = [need[0] && need[1], need[2] && need[3], need[4], !$('#fForCust').checked || v.insured_name.length >= 2, true, !!v.cover];
    secs.forEach((x, i) => x.classList.toggle('done', !!done[i] && (i < 3 || n === need.length)));
    // route: redraw only when it changes
    const key = [v.origin_country, v.dest_country, v.conveyance].join('|');
    if(key !== laneKey){
      const was = laneKey; laneKey = key; const conv = FC.CONVEYANCE[v.conveyance] || {};
      const end = (iso, place, to) => `<div class="end${to ? ' to' : ''}"><span class="iso${iso ? '' : ' ph'}">${esc(iso || '···')}</span><span class="place">${esc(place || (iso ? countryName(iso) : (to ? 'Destination' : 'Origin')))}</span></div>`;
      $('#nsLane').innerHTML = end(v.origin_country, '', false) + FC.routeArc(v.conveyance, FC.icon[v.conveyance], conv.label) + end(v.dest_country, '', true);
      FC.playRoute($('#nsLane .track'), !!(v.origin_country && v.dest_country) && was !== '' && was.split('|').slice(0, 2).join('|') !== key.split('|').slice(0, 2).join('|'));
    }
    const ph = t => `<span class="ph">${esc(t)}</span>`, cov = FC.COVER[v.cover] || {};
    const row = (l, val) => `<div><dt>${esc(l)}</dt><dd>${val}</dd></div>`;
    $('#nsFacts').innerHTML = row('Cargo', com ? esc(com.name) : ph('Choose the type of cargo'))
      + row('Goods', v.goods_description ? esc(v.goods_description) : ph('Describe the goods'))
      + row('Conveyance', esc((FC.CONVEYANCE[v.conveyance] || {}).label || '') + (v.vessel ? ' · ' + esc(v.vessel) : ''))
      + row('Cover', esc(cov.clause || '') + (v.war_strikes ? ' · war &amp; strikes' : '') + (v.ext_hssc ? ' · HSSC' : '') + (v.ext_liw ? ' · LiW/DiW' : ''))
      + (v.incoterm ? row('Incoterm', esc(v.incoterm) + ', for the ' + esc(v.insured_party || 'seller')) : '')
      + (v.insured_name ? row('Assured', esc(v.insured_name)) : '');
    const si = isFinite(v.invoice_value) && v.invoice_value > 0 && isFinite(v.uplift_pct) ? v.invoice_value * (1 + v.uplift_pct / 100) : NaN;
    $('#nsSi').textContent = isFinite(si) ? money2(si, v.currency) : '—';
  }
  $('#nsCalc').addEventListener('click', () => form.requestSubmit());
  $('#nsHelp').addEventListener('click', () => { const fb = $('#feedbackBtn'); if(fb) fb.click(); });
  // "ship it again": the last three different shipments
  (async () => {
    try{
      const { data } = await sb.rpc('my_history', { p_limit: 20 }); const seen = new Set(), list = [];
      (data || []).forEach(r => { const k = [r.commodity_id, r.origin_country, r.dest_country, r.conveyance].join('|'); if(!seen.has(k) && list.length < 3){ seen.add(k); list.push(r); } });
      if(!list.length) return;
      $('#nsRecentList').innerHTML = list.map((r, i) => `<button type="button" class="ns-again" data-i="${i}"><span class="mini-route"><b>${esc(r.origin_country)}</b><span class="mr-line"><i></i><em>${FC.icon[r.conveyance] || ''}</em><i></i></span><b>${esc(r.dest_country)}</b></span><span class="ns-again-t"><b>${esc(r.goods_description)}</b><span class="xs muted">${esc(money2(r.sum_insured, r.currency))} · ${esc(FC.date(r.created_at))}</span></span><span class="ns-again-go">Use</span></button>`).join('');
      $$('#nsRecentList .ns-again').forEach(b => b.addEventListener('click', () => { const r = list[+b.dataset.i]; writeForm(Object.assign({}, r, { departure_date: null })); toast('Details copied. Check value and date, then calculate.'); window.scrollTo({ top: 0, behavior: 'smooth' }); }));
      $('#nsAgainN').textContent = '(' + list.length + ')';
      const setOpen = on => { $('#nsAgainBtn').setAttribute('aria-expanded', String(on)); $('#nsRecentList').hidden = !on; try{ localStorage.setItem('freightcon-again', on ? '1' : '0'); }catch(e){} };
      let open0 = false; try{ open0 = localStorage.getItem('freightcon-again') === '1'; }catch(e){}
      setOpen(open0); $('#nsAgainBtn').addEventListener('click', () => setOpen($('#nsAgainBtn').getAttribute('aria-expanded') !== 'true'));
      $('#nsRecent').hidden = false;
    }catch(e){}
  })();
  form.addEventListener('input', onFormChange); form.addEventListener('change', onFormChange);
  form.addEventListener('input', e => { const f = e.target.closest('.field'); if(f) f.classList.remove('invalid'); });
  onFormChange();

  function validate(v){
    const bad = [];
    const mark = (id, cond) => { const f = $(id).closest('.field'); f.classList.toggle('invalid', !cond); if(!cond) bad.push(id); };
    mark('#fCommodity', !!v.commodity_id);
    mark('#fGoods', v.goods_description.length >= 2);
    mark('#fOrigin', !!v.origin_country); mark('#fDest', !!v.dest_country);
    mark('#fDep', !v.departure_date || v.departure_date >= FC.today());
    mark('#fValue', isFinite(v.invoice_value) && v.invoice_value > 0);
    mark('#fUplift', isFinite(v.uplift_pct) && v.uplift_pct >= 0 && v.uplift_pct <= 30);
    mark('#fInsName', !$('#fForCust').checked || v.insured_name.length >= 2);
    if(bad.length){ $(bad[0]).focus(); return false; }
    return true;
  }

  // ---------- calculation ----------
  let current = null;       // last result row
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const v = readForm(); if(!validate(v)) return;
    const b = $('#calcBtn'); busy(b, true); $('#formMsg').textContent = '';
    const { data, error } = await sb.rpc('calc_indication', { p: v });
    busy(b, false);
    if(error){ $('#formMsg').textContent = FC.errText(error, 'The indication could not be calculated. Check the details and try again.'); return; }
    current = data; renderResult(current, true); if(v.insured_name) loadInsureds();
    { const rh = $('#resultHost'); rh.scrollTop = 0; if(rh.getBoundingClientRect().top < 70 || window.matchMedia('(max-width: 1040px)').matches) rh.scrollIntoView({ behavior:'smooth', block:'start' }); }
  });
  $('#clearBtn').addEventListener('click', () => { current = null; $('#resultHost').innerHTML = ''; $('#resultHost').appendChild(howto); form.reset(); laneKey = ''; writeForm({}); window.scrollTo({ top: 0, behavior: 'smooth' }); });
  const howto = $('#howto');

  function decorate(r){
    r.origin_name = r.origin_name || countryName(r.origin_country);
    r.dest_name = r.dest_name || countryName(r.dest_country);
    r.commodity_name = r.commodity_name || ((commodities.find(c => c.id === r.commodity_id) || {}).name) || '';
    r.deductible_text = r.deductible_text || ((commodities.find(c => c.id === r.commodity_id) || {}).deductible) || settings.deductible_text || '';
    r.company = r.company || profile.company;
    return r;
  }

  function renderResult(r, animate){
    decorate(r);
    const conv = FC.CONVEYANCE[r.conveyance] || {}, cov = FC.COVER[r.cover] || {};
    const land = r.conveyance === 'road' || r.conveyance === 'rail';
    let body = '';
    if(r.status === 'quoted'){
      body = `<div class="premium">
          <div><div class="xs muted">Indicative premium</div><div class="amount">${esc(money2(r.premium, r.currency))}</div><div class="sub">excl. insurance tax${r.min_applied ? ', minimum premium' : ''}</div></div>
          <div class="rate">Rate on sum insured<b>${esc(FC.pct(r.rate_pct))}</b></div>
        </div>
        ${Number(r.discount_pct) > 0 ? `<p class="breakdown">Includes your discount of ${esc(Number(r.discount_pct))} % (${esc(money2(r.premium_gross, r.currency))} before discount).</p>` : ''}
        ${r.conditions ? `<div class="notice info"><b>Special conditions</b>${esc(r.conditions)}</div>` : ''}`;
    }else if(r.status === 'on_request'){
      body = `<div class="notice warn"><b>We quote this shipment individually</b>It cannot be priced automatically because:<ul>${(r.reasons || []).map(x => `<li>${esc(x)}</li>`).join('')}</ul>Request a quotation and we come back to you.</div>`;
    }else{
      body = `<div class="notice danger"><b>Compliance review required</b>${esc((r.reasons || []).join('. '))}. We cannot give an indication. Please contact us before shipping.</div>`;
    }
    const requested = !!r.quote_requested_at;
    const card = FC.el(`<article class="card consign" aria-live="polite">
      <div class="consign-top"><span class="ref">${esc(r.ref || FC.STATUS[r.status] || 'Indication')}</span><span class="when">${esc(FC.dateTime(r.created_at))}</span></div>
      <div class="lane${animate ? ' drawn' : ''}">
        <div class="end"><span class="iso">${esc(r.origin_country)}</span><span class="place">${esc(r.origin_place || r.origin_name)}</span><span class="cty">${esc(r.origin_place ? r.origin_name : '')}</span></div>
        ${FC.routeArc(r.conveyance, FC.icon[r.conveyance], conv.label)}
        <div class="end to"><span class="iso">${esc(r.dest_country)}</span><span class="place">${esc(r.dest_place || r.dest_name)}</span><span class="cty">${esc(r.dest_place ? r.dest_name : '')}</span></div>
      </div>
      <dl class="facts">
        ${r.insured_name ? `<div><dt>Assured</dt><dd>${esc(r.insured_name)}<span class="xs muted" style="display:block">You are the policyholder</span></dd></div>` : ''}
        ${r.customer_ref ? `<div><dt>Your reference</dt><dd>${esc(r.customer_ref)}</dd></div>` : ''}
        <div><dt>Goods</dt><dd>${esc(r.goods_description)}</dd></div>
        <div><dt>Cargo type</dt><dd>${esc(r.commodity_name)}</dd></div>
        <div><dt>Sum insured</dt><dd class="num">${esc(money2(r.sum_insured, r.currency))}</dd></div>
        <div><dt>Conveyance</dt><dd>${esc(conv.label || '')}${r.departure_date ? ', departs ' + esc(FC.date(r.departure_date)) : ''}</dd></div>
        <div><dt>Cover</dt><dd>${esc(cov.clause || '')}</dd></div>
        <div><dt>${land ? 'Strikes' : 'War & strikes'}</dt><dd>${r.war_strikes ? 'Included' : 'Not included'}</dd></div>
        ${r.on_deck || r.interest_only ? `<div><dt>Special</dt><dd>${[r.on_deck ? 'Shipped on deck' : '', r.interest_only ? "Own interest only (contingency)" : ''].filter(Boolean).join(', ')}</dd></div>` : ''}
        ${r.ext_hssc || r.ext_liw ? `<div><dt>Extensions</dt><dd>${[r.ext_hssc ? 'HSSC' : '', r.ext_liw ? 'Loss / difference in weight' : ''].filter(Boolean).join(', ')}</dd></div>` : ''}
        ${isSea(r.conveyance) ? `<div><dt>Vessel</dt><dd>${esc(r.vessel || 'To be declared')}</dd></div>` : ''}
        ${r.incoterm ? `<div><dt>Incoterm</dt><dd>${esc(r.incoterm)}, cover for the ${esc(r.insured_party || 'seller')}</dd></div>` : ''}
      </dl>
      ${body}
      <div class="consign-actions">
        ${requested ? '' : `<label class="lbl" for="qComment">Message to us <span class="muted">(optional)</span></label><textarea id="qComment" maxlength="1000" placeholder="e.g. vessel name, packing details, preferred insurer, deadline"></textarea>`}
        <div class="row">
          ${requested ? `<div class="notice ok" style="margin:0;flex:1"><b>${FC.tick}Quotation requested</b>We received your request ${esc(r.ref ? 'under ' + r.ref : '')}. You find the quotation in My quotations as soon as it is ready.</div>`
                      : `<button class="btn btn-primary" id="reqBtn" type="button" ${r.status === 'sanctioned' ? '' : ''}><span class="spin"></span>${FC.icon.send}Request quotation</button>`}
          <button class="btn btn-ghost" id="pdfBtn" type="button"><span class="spin"></span>${FC.icon.download}Download PDF</button>
        </div>
      </div>
      <p class="fine">Indications are non-binding. Cover is only in place once a quotation has been accepted and confirmed in writing. Deductible: ${esc(r.deductible_text)}.${isSea(r.conveyance) ? ' Sea transport is subject to the Institute Classification Clause: older or unclassed vessels may carry an additional premium. We check the vessel before we quote.' : ''}</p>
    </article>`);
    const host = $('#resultHost'); host.innerHTML = ''; host.appendChild(card);
    FC.playRoute(card.querySelector('.track'), animate);
    if(animate && r.status === 'quoted') FC.countUp(card.querySelector('.premium .amount'), Number(r.premium), v => money2(Math.round(v * 100) / 100, r.currency), 800);
    const rb = card.querySelector('#reqBtn');
    if(rb) rb.addEventListener('click', async () => {
      busy(rb, true);
      const { data, error } = await sb.rpc('request_quotation', { p_id: r.id, p_comment: (card.querySelector('#qComment') || {}).value || '' });
      busy(rb, false);
      if(error){ toast(FC.errText(error, 'The request did not go through. Please try again.'), 'error'); return; }
      r.ref = data; r.quote_requested_at = new Date().toISOString();
      toast('Quotation requested — reference ' + data);
      renderResult(r, false); refreshBadges();
    });
    card.querySelector('#pdfBtn').addEventListener('click', async e => {
      const b = e.currentTarget; busy(b, true);
      try{
        const { data: ref, error } = await sb.rpc('mark_pdf_downloaded', { p_id: r.id });
        if(error) throw error;
        r.ref = ref; card.querySelector('.consign-top .ref').textContent = ref;
        const bytes = await FCPDF.indication(Object.assign({}, r, { issued_at: new Date().toISOString() }));
        FC.saveBlob(bytes, FCPDF.fileName('FREIGHTCON_Indication', ref, r.goods_description.slice(0, 24)));
      }catch(err){ console.error(err); toast(FC.errText(err, 'The PDF could not be created. Please try again.'), 'error'); }
      busy(b, false);
    });
  }

  // ---------- bulk upload (Excel / CSV) ----------
  const UP_MAX = 200;
  const UP_COLS = [
    ['customer_ref', 'Your reference', 'JOB-26-1187'],
    ['commodity', 'Cargo type', 'Machinery & equipment (new)'],
    ['goods_description', 'Description of goods', '2 CNC lathes in wooden crates'],
    ['packaging', 'Packaging', 'Wooden crates / cases'],
    ['conveyance', 'Conveyance', 'Sea, container'],
    ['origin_country', 'From country', 'DE'], ['origin_place', 'From city / port', 'Hamburg'],
    ['dest_country', 'To country', 'CN'], ['dest_place', 'To city / port', 'Shanghai'],
    ['departure_date', 'Departure date', ''],
    ['invoice_value', 'Invoice value', 120000], ['currency', 'Currency', 'EUR'], ['uplift_pct', 'Uplift %', 10],
    ['cover', 'Cover (A/B/C)', 'A'], ['war_strikes', 'War & strikes (yes/no)', 'yes'],
    ['ext_hssc', 'HSSC (yes/no)', ''], ['ext_liw', 'LiW / DiW (yes/no)', ''],
    ['vessel', 'Vessel or IMO', ''], ['incoterm', 'Incoterm', 'CIF'], ['insured_party', 'Cover is for (seller/buyer)', 'seller'],
    ['insured_name', 'Assured: your customer', 'Müller Maschinenbau GmbH'], ['insured_address', 'Assured address', 'Industriestr. 5, 20095 Hamburg, Germany']
  ];
  const norm = x => String(x == null ? '' : x).trim().toLowerCase().replace(/[^a-z0-9äöüß]+/g, ' ').trim();
  const packOpts = () => Array.from($('#fPacking').options).map(o => o.value).filter(Boolean);
  let upRows = [], upInit = false;
  async function needXlsx(){ if(!window.XLSX) await FC.loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'); return window.XLSX; }
  function initUpload(){
    if(upInit) return; upInit = true;
    $('#upTpl').addEventListener('click', async e => {
      const b = e.currentTarget; busy(b, true);
      try{
        const X = await needXlsx(), wb = X.utils.book_new();
        const ex2 = { customer_ref:'JOB-26-1188', commodity:'agri_bagged', goods_description:'Coffee beans in jute bags, 1 x 20ft', packaging:'Bags / big bags', conveyance:'Sea, container', origin_country:'Brazil', origin_place:'Santos', dest_country:'DE', dest_place:'Hamburg', departure_date:'', invoice_value:45000, currency:'USD', uplift_pct:10, cover:'A', war_strikes:'yes', ext_hssc:'yes', ext_liw:'no', vessel:'', incoterm:'FOB', insured_party:'buyer', insured_name:'', insured_address:'' };
        const ws = X.utils.aoa_to_sheet([UP_COLS.map(c => c[1]), UP_COLS.map(c => c[2]), UP_COLS.map(c => ex2[c[0]])]);
        ws['!cols'] = UP_COLS.map(c => ({ wch: Math.max(14, c[1].length + 2) }));
        X.utils.book_append_sheet(wb, ws, 'Shipments');
        const codes = [['Cargo types (name or ID)', 'ID', '', 'Conveyance', '', 'Packaging', '', 'Incoterms', '', 'Country', 'ISO code']];
        const conv = Object.values(FC.CONVEYANCE).map(c => c.label), pk = packOpts(), inc = Object.entries(FC.INCOTERMS).map(([k, t]) => k + ' (' + t.name + ')');
        const n = Math.max(commodities.length, countries.length);
        for(let i = 0; i < n; i++) codes.push([(commodities[i] || {}).name || '', (commodities[i] || {}).id || '', '', conv[i] || '', '', pk[i] || '', '', inc[i] || '', '', (countries[i] || {}).name || '', (countries[i] || {}).iso2 || '']);
        const ws2 = X.utils.aoa_to_sheet(codes); ws2['!cols'] = [{ wch:44 }, { wch:16 }, { wch:2 }, { wch:24 }, { wch:2 }, { wch:24 }, { wch:2 }, { wch:34 }, { wch:2 }, { wch:34 }, { wch:9 }];
        X.utils.book_append_sheet(wb, ws2, 'Codes');
        const help = [['How to fill in the template'], [''], ['One row per shipment. Required: cargo type, description of goods, from country, to country, invoice value.'],
          ['Countries: ISO code (DE) or English name (Germany).'], ['Cargo type: name or ID from the sheet "Codes".'], ['Conveyance: Sea, container / Sea, breakbulk / Air freight / Air charter / Road / Rail. Empty = sea container.'],
          ['Cover: A, B or C. Empty = A. War & strikes: yes or no. Empty = yes.'],
          ['HSSC (heating, sweating & spontaneous combustion) and LiW / DiW (loss / difference in weight): yes or no. Only for cargo types that offer them, e.g. agricultural products. Empty = no.'], ['Departure date: optional, e.g. 2026-11-15. Not in the past.'],
          ['Assured: fill in only if you insure on behalf of your customer. You remain the policyholder.'], ['Up to ' + UP_MAX + ' shipments per file.']];
        X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(help), 'Help');
        X.writeFile(wb, 'FREIGHTCON_bulk_template.xlsx');
      }catch(err){ console.error(err); toast('The template could not be created.', 'error'); }
      busy(b, false);
    });
    const drop = $('#upDrop'), file = $('#upFile');
    drop.addEventListener('keydown', e => { if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); file.click(); } });
    ['dragenter','dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave','drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if(f) readUpload(f); });
    file.addEventListener('change', () => { if(file.files[0]) readUpload(file.files[0]); file.value = ''; });
  }
  async function readUpload(f){
    $('#upDropTxt').textContent = 'Reading ' + f.name + '…';
    try{
      const X = await needXlsx();
      const isCsv = /\.csv$/i.test(f.name), wb = X.read(await f.arrayBuffer(), isCsv ? { type:'array', raw:true } : { type:'array', cellDates:true });  // CSV: keep text, we parse 1.234,50 ourselves
      const sh = wb.Sheets[wb.SheetNames.find(n => norm(n) === 'shipments') || wb.SheetNames[0]];
      const aoa = X.utils.sheet_to_json(sh, { header:1, raw:true, defval:'' });
      const hi = aoa.findIndex(r => r.some(c => norm(c).includes('description')) || r.some(c => norm(c) === 'cargo type'));
      if(hi < 0) throw new Error('No header row found. Please use the template.');
      const head = aoa[hi].map(norm);
      const idx = {}; UP_COLS.forEach(([k, l]) => { const j = head.findIndex(h => h === norm(l) || h === norm(k) || (h && norm(l).startsWith(h))); if(j >= 0) idx[k] = j; });
      if(idx.goods_description == null) throw new Error('Column "Description of goods" is missing.');
      const data = aoa.slice(hi + 1).filter(r => r.some(c => String(c).trim() !== ''));
      if(!data.length) throw new Error('The file has no shipments.');
      if(data.length > UP_MAX) throw new Error('The file has ' + data.length + ' shipments. Please split it into files of up to ' + UP_MAX + '.');
      upRows = data.map((r, i) => parseRow(Object.fromEntries(Object.entries(idx).map(([k, j]) => [k, r[j]])), i + hi + 2));
      $('#upDropTxt').textContent = f.name + ' · ' + upRows.length + ' shipment' + (upRows.length > 1 ? 's' : '') + '. Drop another file to replace it.';
      paintUpload();
    }catch(err){ console.error(err); $('#upDropTxt').textContent = 'Drop the file here or choose a file'; upRows = []; $('#upBody').innerHTML = `<div class="notice danger"><b>The file could not be read</b>${esc(err.message || 'Please use the template.')}</div>`; }
  }
  function parseRow(c, line){
    const err = [], s = k => String(c[k] == null ? '' : c[k]).trim();
    const country = k => { const v = s(k), n = norm(v); if(!v) return ''; const m = countries.find(x => x.iso2.toLowerCase() === n || norm(x.name) === n); if(!m) err.push('Unknown country "' + v + '"'); return m ? m.iso2 : ''; };
    const comv = norm(s('commodity')), com = commodities.find(x => norm(x.id) === comv || norm(x.name) === comv) || (comv ? commodities.find(x => norm(x.name).startsWith(comv)) : null);
    if(!comv) err.push('Cargo type missing'); else if(!com) err.push('Unknown cargo type "' + s('commodity') + '"');
    const convv = norm(s('conveyance')); let conv = 'sea_container';
    if(convv){ const m = Object.entries(FC.CONVEYANCE).find(([k, v]) => norm(k) === convv || norm(v.label) === convv || norm(v.short) === convv)
        || (/charter/.test(convv) ? ['air_charter'] : /air|luft/.test(convv) ? ['air'] : /break|roro|bulk/.test(convv) ? ['sea_breakbulk'] : /sea|see|container|ocean/.test(convv) ? ['sea_container'] : /road|lkw|truck|stra/.test(convv) ? ['road'] : /rail|bahn|train/.test(convv) ? ['rail'] : null);
      if(m) conv = m[0]; else err.push('Unknown conveyance "' + s('conveyance') + '"'); }
    let val = c.invoice_value; if(typeof val !== 'number'){ let t = String(val || '').replace(/[^\d.,-]/g, ''); if(/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, ''); val = FC.parseNum(t); }  // "120.000" in a German CSV means 120,000
    if(!(val > 0)) err.push('Invoice value missing');
    const cur = (s('currency') || 'EUR').toUpperCase(); if(!['EUR','USD'].includes(cur)) err.push('Currency must be EUR or USD');
    let up = c.uplift_pct === '' || c.uplift_pct == null ? Number(settings.uplift_pct || 10) : (typeof c.uplift_pct === 'number' ? (c.uplift_pct < 1 && c.uplift_pct > 0 ? c.uplift_pct * 100 : c.uplift_pct) : FC.parseNum(String(c.uplift_pct).replace('%', '')));
    if(!(up >= 0 && up <= 30)) err.push('Uplift must be 0–30 %');
    const cv = norm(s('cover')).replace(/^icc /, ''), cover = !cv ? 'icc_a' : ({ a:'icc_a', b:'icc_b', c:'icc_c', icc_a:'icc_a', icc_b:'icc_b', icc_c:'icc_c' })[cv.replace(' ', '_')];
    if(!cover) err.push('Cover must be A, B or C');
    const yn = (k, label) => { const v = norm(s(k)); if(!v) return false; if(['yes','y','ja','j','true','1','x'].includes(v)) return true; if(!['no','n','nein','false','0'].includes(v)) err.push(label + ' must be yes or no'); return false; };
    const hssc = yn('ext_hssc', 'HSSC'), liw = yn('ext_liw', 'LiW / DiW');
    if(com && hssc && !com.ext_hssc) err.push('HSSC is not available for this cargo'); if(com && liw && !com.ext_liw) err.push('LiW / DiW is not available for this cargo');
    const wv = norm(s('war_strikes')), war = !wv || ['yes','y','ja','j','true','1','x'].includes(wv); if(wv && !war && !['no','n','nein','false','0'].includes(wv)) err.push('War & strikes must be yes or no');
    let dep = c.departure_date, depS = '';
    if(dep instanceof Date && !isNaN(dep)) depS = new Date(dep.getTime() - dep.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    else if(String(dep || '').trim()){ const t = String(dep).trim(), m = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/); depS = m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : t; if(!/^\d{4}-\d{2}-\d{2}$/.test(depS) || isNaN(new Date(depS))){ err.push('Departure date not readable'); depS = ''; } }
    if(depS && depS < FC.today()) err.push('Departure date lies in the past');
    const inc = s('incoterm').toUpperCase().slice(0, 3); if(inc && !FC.INCOTERMS[inc]) err.push('Unknown Incoterm "' + s('incoterm') + '"');
    const pv = norm(s('insured_party')), party = !pv ? 'seller' : /buy|käuf|kaeuf|import/.test(pv) ? 'buyer' : /sell|verk|export/.test(pv) ? 'seller' : null; if(!party) err.push('Cover is for: seller or buyer');
    const pkv = norm(s('packaging')), pk = pkv ? (packOpts().find(o => norm(o) === pkv) || packOpts().find(o => norm(o).includes(pkv) || pkv.includes(norm(o).split(' ')[0])) || 'Other') : '';
    const goods = s('goods_description'); if(goods.length < 2) err.push('Description of goods missing');
    const p = { customer_ref: s('customer_ref').slice(0, 60), commodity_id: com ? com.id : '', goods_description: goods.slice(0, 300), packaging: pk, conveyance: conv,
      origin_country: country('origin_country'), origin_place: s('origin_place').slice(0, 100), dest_country: country('dest_country'), dest_place: s('dest_place').slice(0, 100),
      departure_date: depS || null, invoice_value: val, currency: cur, uplift_pct: up, cover: cover || 'icc_a', war_strikes: war,
      vessel: isSea(conv) ? s('vessel').slice(0, 100) : '', incoterm: inc || null, insured_party: inc ? party : null, on_deck: false, interest_only: false,
      insured_name: s('insured_name').slice(0, 150), insured_address: s('insured_address').slice(0, 250), ext_hssc: hssc, ext_liw: liw, source: 'upload' };
    if(!s('origin_country')) err.push('From country missing');
    if(!s('dest_country')) err.push('To country missing');
    if(com && cover && !(com.allowed_covers || []).includes(cover)) err.push('Cover ' + cover.slice(-1).toUpperCase() + ' not available for this cargo (allowed: ' + (com.allowed_covers || []).map(x => x.slice(-1).toUpperCase()).join(', ') + ')');
    return { line, p, err, res:null, sel:false };
  }
  function paintUpload(){
    const host = $('#upBody'); host.innerHTML = '';
    if(!upRows.length) return;
    const ok = upRows.filter(r => !r.err.length), bad = upRows.length - ok.length, done = upRows.filter(r => r.res), todo = ok.filter(r => !r.res);
    const tot = {}; done.filter(r => r.res.status === 'quoted').forEach(r => { tot[r.res.currency] = (tot[r.res.currency] || 0) + Number(r.res.premium); });
    const head = FC.el(`<div class="card card-pad" style="margin-bottom:14px">
      <div class="toolbar" style="margin:0;flex-wrap:wrap">
        <div style="flex:1;min-width:220px"><b>${ok.length} of ${upRows.length} shipments ready</b>${bad ? `<span class="up-err" style="display:block">${bad} row${bad > 1 ? 's have' : ' has'} errors and ${bad > 1 ? 'are' : 'is'} skipped. Fix the file and upload it again.</span>` : ''}
          ${done.length ? `<span class="small muted" style="display:block">${done.length} calculated · ${done.filter(r => r.res.status === 'quoted').length} with premium${Object.keys(tot).length ? ' · total ' + Object.entries(tot).map(([c, v]) => money2(v, c)).join(' + ') : ''} · ${done.filter(r => r.res.status !== 'quoted').length} quoted individually</span>` : ''}</div>
        <span id="upActs" class="toolbar" style="margin:0"></span></div><div class="up-bar" id="upBar" hidden><i></i></div></div>`);
    host.appendChild(head);
    const acts = $('#upActs', head);
    if(todo.length) acts.appendChild(btn('Calculate ' + todo.length + ' shipment' + (todo.length > 1 ? 's' : ''), 'primary', b => runUpload(b, todo)));
    if(done.length){
      const sel = done.filter(r => r.sel && !r.res.quote_requested_at);
      acts.appendChild(btn('Request quotation for selected' + (sel.length ? ' (' + sel.length + ')' : ''), sel.length ? 'primary' : 'ghost', b => requestUpload(b)));
      acts.appendChild(btn('Download results (.xlsx)', 'ghost', b => exportUpload(b)));
    }
    const wrap = FC.el('<div class="tbl-wrap"></div>'); host.appendChild(wrap);
    wrap.innerHTML = `<table class="tbl"><thead><tr><th style="width:28px">${done.length ? '<input type="checkbox" id="upAll" aria-label="Select all" style="width:auto;min-width:0">' : ''}</th><th>Row</th><th>Your ref.</th><th>Goods</th><th>Route</th><th class="r">Sum insured</th><th>Result</th></tr></thead><tbody></tbody></table>`;
    const tb = wrap.querySelector('tbody');
    upRows.forEach(r => {
      const p = r.p, si = p.invoice_value > 0 ? p.invoice_value * (1 + (p.uplift_pct || 0) / 100) : null, x = r.res;
      const result = r.err.length ? `<span class="up-err">${esc(r.err.join('; '))}</span>`
        : !x ? '<span class="xs muted">Ready</span>'
        : x.error ? `<span class="up-err">${esc(x.error)}</span>`
        : `<span class="chip ${esc(x.status)}">${esc(FC.STATUS[x.status])}</span>${x.status === 'quoted' ? ' <b class="num">' + esc(money2(x.premium, x.currency)) + '</b> <span class="xs muted">' + esc(FC.pct(x.rate_pct)) + '</span>' : x.status === 'on_request' ? '<span class="xs muted" style="display:block">' + esc((x.reasons || []).join('; ')) + '</span>' : ''}${x.quote_requested_at ? ' <span class="chip neutral">Requested ' + esc(x.ref || '') + '</span>' : ''}`;
      const tr = FC.el(`<tr><td>${x && !x.error ? `<input type="checkbox" class="upSel" ${r.sel ? 'checked' : ''} ${x.quote_requested_at || x.status === 'sanctioned' ? 'disabled' : ''} aria-label="Select row ${r.line}" style="width:auto;min-width:0">` : ''}</td>
        <td class="xs muted">${r.line}</td><td>${esc(p.customer_ref || '')}</td>
        <td>${esc(p.goods_description || '—')}${p.insured_name ? '<br><span class="xs muted">for ' + esc(p.insured_name) + '</span>' : ''}<br><span class="xs muted">${esc(((commodities.find(c => c.id === p.commodity_id) || {}).name) || '')}</span></td>
        <td><b>${esc(p.origin_country || '?')} → ${esc(p.dest_country || '?')}</b><br><span class="xs muted">${esc((FC.CONVEYANCE[p.conveyance] || {}).short || '')}, ICC ${esc((p.cover || '').slice(-1).toUpperCase())}${p.ext_hssc ? ' + HSSC' : ''}${p.ext_liw ? ' + LiW' : ''}</span></td>
        <td class="r num">${si ? esc(money2(si, p.currency)) : '—'}</td><td>${result}</td></tr>`);
      const cb = tr.querySelector('.upSel'); if(cb) cb.addEventListener('change', () => { r.sel = cb.checked; paintUpload(); });
      tb.appendChild(tr);
    });
    const all = $('#upAll', wrap);
    if(all){ const able = done.filter(r => !r.res.error && !r.res.quote_requested_at && r.res.status !== 'sanctioned'); all.checked = able.length && able.every(r => r.sel); all.addEventListener('change', () => { able.forEach(r => r.sel = all.checked); paintUpload(); }); }
  }
  // while calculating, each row flips to its result as soon as it is back
  function liveRow(r){
    const tr = Array.from(document.querySelectorAll('#upBody tbody tr')).find(x => x.children[1] && x.children[1].textContent.trim() === String(r.line));
    if(!tr) return; const x = r.res, td = tr.lastElementChild;
    td.innerHTML = x.error ? `<span class="up-err">${esc(x.error)}</span>` : `<span class="chip ${esc(x.status)}">${esc(FC.STATUS[x.status])}</span>${x.status === 'quoted' ? ' <b class="num">' + esc(money2(x.premium, x.currency)) + '</b>' : ''}`;
    tr.classList.remove('flash'); void tr.offsetWidth; tr.classList.add('flash');
  }
  async function pool(items, n, fn, onStep){ let i = 0, k = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while(i < items.length){ const it = items[i++]; await fn(it); onStep(++k); } })); }
  async function runUpload(b, todo){
    busy(b, true); const bar = $('#upBar'); bar.hidden = false;
    await pool(todo, 4, async r => {
      const { data, error } = await sb.rpc('calc_indication', { p: r.p });
      r.res = error ? { error: FC.errText(error, 'Could not be calculated') } : data; r.flash = true;
      liveRow(r);
    }, k => { bar.firstChild.style.width = Math.round(k / todo.length * 100) + '%'; });
    upRows.forEach(r => r.flash = false);
    loadInsureds(); paintUpload(); toast('Calculated ' + todo.length + ' shipment' + (todo.length > 1 ? 's' : '') + '.');
  }
  async function requestUpload(b){
    const sel = upRows.filter(r => r.sel && r.res && !r.res.error && !r.res.quote_requested_at);
    if(!sel.length){ toast('Tick the shipments you want quoted first.'); return; }
    if(!(await FC.confirm('Request ' + sel.length + ' quotation' + (sel.length > 1 ? 's' : '') + '?', 'We receive the shipments and come back to you with quotations under My quotations.', 'Request quotations'))) return;
    busy(b, true); let fails = 0;
    await pool(sel, 3, async r => {
      const { data, error } = await sb.rpc('request_quotation', { p_id: r.res.id, p_comment: 'Bulk upload' + (r.p.customer_ref ? ', ref. ' + r.p.customer_ref : '') });
      if(error) fails++; else { r.res.ref = data; r.res.quote_requested_at = new Date().toISOString(); r.sel = false; }
    }, () => {});
    paintUpload(); refreshBadges();
    toast(fails ? (sel.length - fails) + ' requested, ' + fails + ' failed. Please try those again.' : sel.length + ' quotation' + (sel.length > 1 ? 's' : '') + ' requested.', fails ? 'error' : undefined);
  }
  async function exportUpload(b){
    busy(b, true);
    try{
      const X = await needXlsx();
      const head = ['Row', 'Your reference', 'FREIGHTCON reference', 'Assured', 'Cargo type', 'Description of goods', 'Conveyance', 'From', 'To', 'Departure', 'Invoice value', 'Currency', 'Sum insured', 'Cover', 'War & strikes', 'HSSC', 'LiW / DiW', 'Result', 'Rate %', 'Premium (excl. tax)', 'Notes'];
      const rows = upRows.map(r => { const p = r.p, x = r.res || {};
        return [r.line, p.customer_ref, x.ref || '', p.insured_name, ((commodities.find(c => c.id === p.commodity_id) || {}).name) || '', p.goods_description, (FC.CONVEYANCE[p.conveyance] || {}).label || '',
          [p.origin_place, countryName(p.origin_country)].filter(Boolean).join(', '), [p.dest_place, countryName(p.dest_country)].filter(Boolean).join(', '), p.departure_date || '',
          p.invoice_value, p.currency, x.sum_insured != null ? Number(x.sum_insured) : '', (FC.COVER[p.cover] || {}).clause || '', p.war_strikes ? 'yes' : 'no', p.ext_hssc ? 'yes' : 'no', p.ext_liw ? 'yes' : 'no',
          r.err.length ? 'Error' : x.error ? 'Error' : x.status ? FC.STATUS[x.status] : 'Not calculated', x.rate_pct != null ? Number(x.rate_pct) : '', x.premium != null ? Number(x.premium) : '',
          r.err.length ? r.err.join('; ') : x.error || (x.reasons || []).join('; ') + (x.quote_requested_at ? (x.reasons && x.reasons.length ? '; ' : '') + 'Quotation requested' : '')]; });
      const ws = X.utils.aoa_to_sheet([head].concat(rows)); ws['!cols'] = head.map(h => ({ wch: Math.max(12, h.length + 2) }));
      const wb = X.utils.book_new(); X.utils.book_append_sheet(wb, ws, 'Results');
      X.writeFile(wb, 'FREIGHTCON_bulk_results_' + FC.today() + '.xlsx');
    }catch(err){ console.error(err); toast('The file could not be created.', 'error'); }
    busy(b, false);
  }

  // ---------- views & routing ----------
  const views = ['new', 'quotes', 'history', 'upload', 'admin'];
  async function go(v){
    if(v === 'shipments' || v === 'claims'){ if(v === 'claims') qTab = 'claims'; v = 'quotes'; }
    if(!views.includes(v) || (v === 'admin' && !profile.is_admin)) v = 'new';
    if(v !== 'admin') FC.lastExternal = v;
    const inAdm = v === 'admin', il = document.getElementById('internalLbl'), ml = document.getElementById('mobInternalLbl');
    if(il) il.textContent = inAdm ? 'External' : 'Internal'; if(ml) ml.textContent = inAdm ? 'External' : 'Internal';
    $('#internalBtn').title = inAdm ? 'Back to the client view' : 'Internal area';
    $$('[data-view-panel]').forEach(p => p.hidden = p.dataset.viewPanel !== v);
    $$('[data-view]').forEach(b => { if(b.classList.contains('internal-pill')) b.setAttribute('aria-pressed', String(v === 'admin')); else if(b.dataset.view === v) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    if(location.hash !== '#' + v) history.replaceState(null, '', '#' + v);
    if(v === 'quotes') loadQuotes();
    if(v === 'history') loadHistory();
    if(v === 'upload') initUpload();
    if(v === 'admin'){
      if(!window.FCAdmin) await FC.loadScript('assets/admin.js?v=2026-10-21t');
      window.FCAdmin.open($('#view-admin'));
    }
    window.scrollTo({ top: 0 });
  }
  FC.go = go;
  const curView = () => { const p = $$('[data-view-panel]').find(x => !x.hidden); return p ? p.dataset.viewPanel : 'new'; };
  // the Internal pill toggles: in the internal area it reads "External" and takes you back to where you were
  $$('[data-view]').forEach(b => b.addEventListener('click', () => go(b.dataset.view === 'admin' && curView() === 'admin' ? (FC.lastExternal || 'new') : b.dataset.view)));
  window.addEventListener('hashchange', () => go(location.hash.slice(1)));
  if(profile.is_admin){ $('#internalBtn').hidden = false; $('#mobInternal').hidden = false; FC.loadScript('assets/admin.js?v=2026-10-21t').catch(() => {}); }

  // ---------- my quotations ----------
  let qTab = 'quotations', quotes = [], waiting = [], invoices = [], claims = [];
  const setQTab = t => { qTab = t; $$('[data-qtab]').forEach(x => x.setAttribute('aria-selected', String(x.dataset.qtab === t))); renderQuotes(); };
  $$('[data-qtab]').forEach(b => b.addEventListener('click', () => setQTab(b.dataset.qtab)));
  $('#claimBtn').addEventListener('click', () => claimWizard(null));
  async function loadQuotes(){
    $('#qList').innerHTML = '<div class="empty">Loading…</div>';
    const [a, w, inv, cl] = await Promise.all([sb.rpc('my_quotations'), sb.rpc('my_pending_requests'), sb.from('invoices').select('*').order('created_at', { ascending:false }), sb.rpc('my_claims')]);
    if(a.error || w.error){ $('#qList').innerHTML = '<div class="empty">Could not load your shipments. Please reload the page.</div>'; return; }
    quotes = a.data || []; waiting = w.data || []; invoices = inv.data || []; claims = cl.error ? [] : (cl.data || []);
    paintHub(); renderQuotes();
    sb.rpc('mark_quotations_seen').then(() => refreshBadges());
  }
  // ---- hub header: greeting and key figures ----
  function paintHub(){
    const h = new Date().getHours(), first = (profile.first_name || (profile.full_name || '').split(' ')[0] || '').trim();
    $('#hubHi').textContent = (h < 11 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening') + (first ? ', ' + first : '');
    const covered = quotes.filter(q => q.cover_note), open = quotes.filter(q => q.status === 'open'), openCl = claims.filter(c => !['settled','rejected','closed'].includes(c.status));
    const val = {}; covered.forEach(q => { const d = q.data || {}; val[d.currency] = (val[d.currency] || 0) + Number(d.sumInsured || 0); });
    const tile = (n, label, sub, tab, ic) => `<button type="button" class="kpi" data-kpi="${tab}"><span class="kpi-ic">${FC.icon[ic]}</span><b data-count="${n}">${n}</b><span>${esc(label)}</span>${sub ? `<i>${esc(sub)}</i>` : ''}</button>`;
    $('#hubKpis').innerHTML = tile(covered.length, 'Covered shipments', Object.keys(val).length ? Object.entries(val).map(([c, v]) => money(v, c)).join(' · ') + ' insured' : '', 'quotations', 'shield')
      + tile(open.length, 'Quotations to review', open.length ? 'Accept them before they expire' : '', 'quotations', 'doc')
      + tile(waiting.length, 'Waiting for quotation', '', 'waiting', 'clock')
      + tile(openCl.length, 'Open claims', claims.length ? claims.length + ' reported in total' : '', 'claims', 'claim');
    $$('#hubKpis [data-kpi]').forEach(b => b.addEventListener('click', () => setQTab(b.dataset.kpi)));
    $$('#hubKpis b[data-count]').forEach(b => FC.countUp(b, Number(b.dataset.count), null, 600));
    $('#claimBadge').hidden = !openCl.length; $('#claimBadge').textContent = openCl.length;
  }
  const qStatusLabel = { open:'Open', accepted:'Accepted', declined:'Declined', expired:'Expired', withdrawn:'Withdrawn' };
  let justStamped = null;
  const stampSeen = id => { try{ const s = JSON.parse(localStorage.getItem('freightcon-stamps') || '[]'); if(s.includes(id)) return true; s.push(id); localStorage.setItem('freightcon-stamps', JSON.stringify(s.slice(-200))); }catch(e){} return false; };
  // small route strip used on shipment and claim cards
  const miniRoute = (o, d, conv) => `<div class="mini-route"><b>${esc(o || '')}</b><span class="mr-line"><i></i><em>${FC.icon[conv] || FC.icon.sea_container}</em><i></i></span><b>${esc(d || '')}</b></div>`;
  const shipSteps = (q) => {
    const st = q.cover_note ? 3 : q.status === 'accepted' ? 2 : ['declined','withdrawn','expired'].includes(q.status) ? -1 : 1;
    if(st < 0) return `<div class="steps off"><span class="on">Quoted</span><span class="x">${esc(qStatusLabel[q.status] || q.status)}</span></div>`;
    return `<div class="steps">${['Quoted','Accepted','Covered'].map((l, i) => `<span class="${i < st ? 'on' : ''}${i === st - 1 ? ' cur' : ''}">${l}</span>`).join('')}</div>`;
  };
  const coverable = q => q.cover_note || q.status === 'accepted';
  function renderQuotes(){
    const host = $('#qList'); host.innerHTML = '';
    $('#waitBadge').hidden = !waiting.length; $('#waitBadge').textContent = waiting.length;
    if(qTab === 'quotations'){
      if(!quotes.length){ host.innerHTML = `<div class="empty card">${FC.shipArt}<h3>No shipments yet</h3><p>Calculate a shipment and request a quotation. It appears here when it is ready.</p><button class="btn btn-primary" data-go-new>New shipment</button></div>`; }
      quotes.forEach(q => {
        const d = q.data || {}, st = q.cover_note ? 'bound' : q.status, cls = claims.filter(c => c.indication_id === q.indication_id);
        const it = FC.el(`<div class="item ship${!q.seen_at ? ' new' : ''}">
          <div class="ship-main">${miniRoute(d.originCountry, d.destCountry, d.conveyance)}
            <div><div class="t">${esc(d.goods || '')}</div>
            <div class="meta">${esc(q.ref || '')}${q.version > 1 ? ' (version ' + q.version + ')' : ''} · <b class="num">${esc(money2(d.total, d.currency))}</b>${q.status === 'open' ? ' · valid until ' + esc(FC.dateTime(q.valid_until)) : ''}${q.cover_note ? ' · cover note ' + esc(q.cover_note.number) : ''}${cls.length ? ' · <span class="chip pending">' + cls.length + ' claim' + (cls.length > 1 ? 's' : '') + '</span>' : ''}</div>
            ${shipSteps(q)}</div></div>
          <div class="acts"></div></div>`);
        if(st === 'bound' || st === 'accepted'){
          const key = st + ':' + q.id, fresh = justStamped === q.id || !stampSeen(key);
          if(justStamped === q.id) stampSeen(key);
          it.classList.add('has-stamp'); it.insertAdjacentHTML('beforeend', `<span class="stamp ${st}${fresh ? ' fresh' : ''}" aria-hidden="true">${st === 'bound' ? 'Covered' : 'Accepted'}</span>`);
        }
        const acts = it.querySelector('.acts');
        acts.appendChild(btn(q.status === 'open' ? 'Review & accept' : 'View', q.status === 'open' ? 'primary' : 'ghost', () => openQuote(q)));
        acts.appendChild(btn('Quotation PDF', 'ghost', b => pdfQuote(q, b)));
        if(q.cover_note) acts.appendChild(btn('Cover note PDF', 'ghost', b => pdfCover(q, b)));
        if(coverable(q)) acts.appendChild(btn('Report a claim', 'claim', () => claimWizard(q)));
        host.appendChild(it);
      });
    }else if(qTab === 'waiting'){
      if(!waiting.length) host.innerHTML = '<div class="empty card">' + FC.shipArt + '<h3>Nothing waiting</h3><p>Requests you send appear here until the quotation is ready.</p></div>';
      waiting.forEach(r => {
        const it = FC.el(`<div class="item ship"><div class="ship-main">${miniRoute(r.origin_country, r.dest_country, r.conveyance)}<div><div class="t">${esc(r.goods_description)} <span class="chip waiting">Waiting</span></div>
          <div class="meta">${esc(r.ref || '')} · sum insured ${esc(money2(r.sum_insured, r.currency))} · requested ${esc(FC.ago(r.quote_requested_at))}</div>
          <div class="steps"><span class="on cur">Requested</span><span>Quoted</span><span>Accepted</span><span>Covered</span></div></div></div><div class="acts"></div></div>`);
        it.querySelector('.acts').appendChild(btn('Open', 'ghost', () => { go('new'); writeForm(r); current = r; renderResult(r, false); }));
        host.appendChild(it);
      });
    }else if(qTab === 'claims'){
      renderClaims(host);
    }else{
      if(!invoices.length) host.innerHTML = '<div class="empty card">' + FC.shipArt + '<h3>No invoices</h3><p>Premium invoices for bound shipments appear here.</p></div>';
      invoices.forEach(inv => {
        const it = FC.el(`<div class="item"><div><div class="t">Invoice ${esc(inv.number)} <span class="chip ${inv.paid_at ? 'paid' : 'pending'}">${inv.paid_at ? 'Paid' : 'Open'}</span></div>
          <div class="meta">${esc(money2(inv.amount, inv.currency))}${inv.due_date ? ', due ' + esc(FC.date(inv.due_date)) : ''}, issued ${esc(FC.date(inv.created_at))}</div></div><div class="acts"></div></div>`);
        if(inv.file_path) it.querySelector('.acts').appendChild(btn('Download', 'ghost', async b => {
          busy(b, true);
          const { data, error } = await sb.storage.from('invoices').createSignedUrl(inv.file_path, 60);
          busy(b, false);
          if(error){ toast('The invoice file could not be opened.', 'error'); return; }
          window.open(data.signedUrl, '_blank', 'noopener');
        }));
        host.appendChild(it);
      });
    }
    const gn = host.querySelector('[data-go-new]'); if(gn) gn.addEventListener('click', () => go('new'));
  }

  // =================================================================== CLAIMS (customer)
  const LOSS = {
    damage:      { label:'Damage',               hint:'Broken, dented, crushed, scratched', ic:'<path d="M4 7l8-4 8 4v10l-8 4-8-4z"/><path d="M9 9l2 3-2 3M13 8l1 4 2 1"/>' },
    wet:         { label:'Wet damage',           hint:'Rain, sea water, condensation', ic:'<path d="M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11z"/>' },
    theft:       { label:'Theft / missing',      hint:'Packages or whole load missing', ic:'<rect x="4" y="10" width="16" height="10" rx="1.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/><path d="M12 14v2"/>' },
    shortage:    { label:'Shortage',             hint:'Less weight or quantity delivered', ic:'<path d="M4 18h16M7 18V9M12 18V6M17 18v-4"/><path d="M17 8l2 2-2 2"/>' },
    temperature: { label:'Temperature',          hint:'Reefer failure, spoiled goods', ic:'<path d="M10 14V5a2 2 0 0 1 4 0v9a4 4 0 1 1-4 0z"/><path d="M12 10v6"/>' },
    total_loss:  { label:'Total loss',           hint:'Fire, sinking, accident, overboard', ic:'<path d="M12 3c2 3 5 5 5 9a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-5 1-8z"/>' },
    other:       { label:'Something else',       hint:'Describe it in your own words', ic:'<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.5M12 16.5h.01"/>' }
  };
  const lossIc = k => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${(LOSS[k] || LOSS.other).ic}</svg>`;
  const CL_STATUS = { reported:'Reported', in_review:'In review', documents_requested:'Documents requested', surveyor_appointed:'Surveyor appointed', with_insurer:'With insurer', settled:'Settled', rejected:'Declined by insurer', closed:'Closed' };
  FC.CL_STATUS = CL_STATUS; FC.LOSS = LOSS; FC.lossIc = lossIc;
  const CL_FLOW = ['reported','in_review','with_insurer','settled'];
  const clStep = s => s === 'documents_requested' || s === 'surveyor_appointed' ? 1 : s === 'rejected' || s === 'closed' ? 3 : Math.max(0, CL_FLOW.indexOf(s));
  const STAGES = { loading:'At loading', transit:'During transport', transhipment:'At transhipment', storage:'In storage', delivery:'At delivery', unknown:'Not sure' };
  const fmtSize = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
  function renderClaims(host){
    const intro = FC.el(`<div class="claim-intro card"><div><h3>Something went wrong with a shipment?</h3><p class="small muted" style="margin:4px 0 0">Report it here in a few minutes, with photos. We guide you through the next steps and keep you updated.</p></div></div>`);
    intro.appendChild(btn('Report a claim', 'claim', () => claimWizard(null)));
    host.appendChild(intro);
    if(!claims.length){ host.appendChild(FC.el(`<div class="empty card">${FC.shipArt}<h3>No claims</h3><p>Good news: nothing reported so far.</p></div>`)); return; }
    claims.forEach(c => {
      const s = c.shipment || {}, step = clStep(c.status), done = ['settled','rejected','closed'].includes(c.status), last = (c.events || []).slice(-1)[0];
      const it = FC.el(`<div class="item claim-card click" tabindex="0">
        <div class="cl-ic t-${esc(c.loss_type)}">${lossIc(c.loss_type)}</div>
        <div><div class="t">${esc((LOSS[c.loss_type] || {}).label || 'Claim')} · ${esc(s.goods || '')} <span class="chip ${done ? (c.status === 'settled' ? 'paid' : 'neutral') : 'pending'}">${esc(CL_STATUS[c.status] || c.status)}</span></div>
          <div class="meta">${esc(c.ref)} · ${esc(s.origin || '')} → ${esc(s.dest || '')}${c.cover_note_no ? ' · cover note ' + esc(c.cover_note_no) : ''} · reported ${esc(FC.date(c.created_at))}${last ? ' · last update ' + esc(FC.ago(last.created_at)) : ''}</div>
          <div class="cl-track"><i style="width:${[8, 40, 72, 100][step]}%"></i>${['Reported','In review','With insurer', c.status === 'rejected' ? 'Declined' : c.status === 'closed' ? 'Closed' : 'Settled'].map((l, i) => `<span class="${i <= step ? 'on' : ''}" style="left:${[0, 34, 67, 100][i]}%">${l}</span>`).join('')}</div></div>
        <div class="acts"></div></div>`);
      it.querySelector('.acts').appendChild(btn('Open', 'ghost', () => openClaim(c.id)));
      it.addEventListener('click', e => { if(!e.target.closest('button')) openClaim(c.id); });
      it.addEventListener('keydown', e => { if(e.key === 'Enter' && e.target === it) openClaim(c.id); });
      host.appendChild(it);
    });
  }
  // upload files to storage and register them on the claim
  async function uploadClaimFiles(claimId, files, onProgress){
    let ok = 0;
    for(let i = 0; i < files.length; i++){
      const f = files[i], safe = f.name.replace(/[^\w.\-]+/g, '_').slice(-80), path = `${profile.id}/${claimId}/${Date.now()}_${i}_${safe}`;
      const up = await sb.storage.from('claims').upload(path, f, { contentType: f.type || 'application/octet-stream', upsert:false });
      if(!up.error){ const r = await sb.rpc('add_claim_file', { p_claim_id: claimId, p_path: path, p_name: f.name, p_size: f.size, p_mime: f.type || '' }); if(!r.error) ok++; }
      if(onProgress) onProgress(i + 1, files.length);
    }
    return ok;
  }
  const fileDrop = (onAdd) => {
    const el = FC.el(`<label class="up-drop cl-drop" tabindex="0"><input type="file" multiple accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.msg,.eml,.txt,.heic" hidden>
      <span class="cl-drop-ic">${FC.icon.upload}</span><b>Add photos and documents</b><span class="xs muted">Drop files here or tap to choose · photos of the damage, packing and labels, delivery receipt with remarks, bill of lading / CMR / AWB, invoice, survey report · max. 20 MB each</span></label>`);
    const inp = el.querySelector('input');
    el.addEventListener('keydown', e => { if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); inp.click(); } });
    ['dragenter','dragover'].forEach(ev => el.addEventListener(ev, e => { e.preventDefault(); el.classList.add('over'); }));
    ['dragleave','drop'].forEach(ev => el.addEventListener(ev, e => { e.preventDefault(); el.classList.remove('over'); }));
    el.addEventListener('drop', e => onAdd(Array.from(e.dataTransfer.files)));
    inp.addEventListener('change', () => { onAdd(Array.from(inp.files)); inp.value = ''; });
    return el;
  };
  const thumbs = (files, onRemove) => {
    const g = FC.el('<div class="cl-thumbs"></div>');
    files.forEach((f, i) => {
      const isImg = /^image\//.test(f.type) && !/heic/i.test(f.type);
      const t = FC.el(`<div class="cl-thumb">${isImg ? '<img alt="">' : `<span class="cl-doc">${esc((f.name.split('.').pop() || 'file').toUpperCase().slice(0, 4))}</span>`}<span class="cl-fn">${esc(f.name)}</span><span class="xs muted">${esc(fmtSize(f.size))}</span>${onRemove ? '<button type="button" class="cl-x" aria-label="Remove">&times;</button>' : ''}</div>`);
      if(isImg){ const u = URL.createObjectURL(f); const img = t.querySelector('img'); img.src = u; img.onload = () => URL.revokeObjectURL(u); }
      if(onRemove) t.querySelector('.cl-x').addEventListener('click', () => onRemove(i));
      g.appendChild(t);
    });
    return g;
  };
  // ---- the claim wizard ----
  function claimWizard(preQ){
    const eligible = quotes.filter(coverable);
    if(!eligible.length){
      FC.dialog({ title:'Report a claim', body:`<div class="empty" style="padding:10px 0">${FC.shipArt}<h3>No covered shipment yet</h3><p>Claims can be reported for shipments with an accepted quotation or a cover note. If your shipment was insured another way, write to us via the feedback button and we help right away.</p></div>`, actions:[{ label:'Close', kind:'primary', value:null }] });
      return;
    }
    const st = { step: preQ ? 1 : 0, q: preQ || (eligible.length === 1 ? eligible[0] : null), loss_type:'', transit_stage:'', incident_date:'', discovered_date:FC.today(), place:'',
      description:'', estimated_amount:'', currency: ((preQ || eligible[0]).data || {}).currency || 'EUR', goods_location:'', carrier_notified:false, receipt_remarks:false,
      contact_name: profile.full_name || '', contact_phone: profile.phone || '', files:[] };
    if(!preQ && st.q) st.step = 1;
    const STEPS = ['Shipment', 'What happened', 'Details', 'Photos & documents', 'Review'];
    const body = FC.el('<div class="wiz"></div>');
    let box, closeFn, foot;
    const err = t => { const e = body.querySelector('.wiz-err'); if(e) e.textContent = t || ''; return !t; };
    const val = id => (body.querySelector('#' + id) || {}).value;
    const save = () => {
      const g = id => body.querySelector('#' + id);
      if(st.step === 1){ st.incident_date = val('wzInc') || ''; st.discovered_date = val('wzDis') || ''; st.place = (val('wzPlace') || '').trim(); }
      if(st.step === 2){ st.description = (val('wzDesc') || '').trim(); st.estimated_amount = val('wzAmt') ? FC.parseNum(val('wzAmt')) : ''; st.currency = val('wzCur') || st.currency;
        st.goods_location = (val('wzLoc') || '').trim(); st.carrier_notified = g('wzCarr').checked; st.receipt_remarks = g('wzRem').checked;
        st.contact_name = (val('wzCN') || '').trim(); st.contact_phone = (val('wzCP') || '').trim(); }
    };
    const check = () => {
      if(st.step === 0 && !st.q) return err('Choose the shipment.');
      if(st.step === 1){ if(!st.loss_type) return err('Choose what happened.'); if(st.incident_date && st.incident_date > FC.today()) return err('The date of the incident cannot lie in the future.'); }
      if(st.step === 2){ if(st.description.length < 10) return err('Please describe in a few words what happened.'); if(st.estimated_amount !== '' && !(st.estimated_amount >= 0)) return err('Check the estimated amount.'); }
      return err('');
    };
    const paint = () => {
      const q = st.q, d = (q && q.data) || {};
      const head = `<ol class="wiz-steps">${STEPS.map((l, i) => `<li class="${i < st.step ? 'done' : i === st.step ? 'cur' : ''}"><span>${i < st.step ? '✓' : i + 1}</span><em>${l}</em></li>`).join('')}</ol>`;
      let inner = '';
      if(st.step === 0){
        inner = `<h3>Which shipment is affected?</h3><div class="wiz-ships">${eligible.map(x => { const dd = x.data || {}; return `<button type="button" class="wiz-ship${st.q && st.q.id === x.id ? ' sel' : ''}" data-q="${x.id}">${miniRoute(dd.originCountry, dd.destCountry, dd.conveyance)}<span><b>${esc(dd.goods || '')}</b><span class="xs muted">${esc(x.ref || '')}${x.cover_note ? ' · cover note ' + esc(x.cover_note.number) : ' · accepted'}</span></span></button>`; }).join('')}</div>`;
      }else if(st.step === 1){
        inner = `<div class="wiz-ctx">${miniRoute(d.originCountry, d.destCountry, d.conveyance)}<span><b>${esc(d.goods || '')}</b><span class="xs muted">${esc(q.ref || '')}${q.cover_note ? ' · cover note ' + esc(q.cover_note.number) : ''}</span></span></div>
          <h3>What happened?</h3><div class="loss-grid">${Object.entries(LOSS).map(([k, v]) => `<button type="button" class="loss${st.loss_type === k ? ' sel' : ''}" data-loss="${k}"><span class="loss-ic t-${k}">${lossIc(k)}</span><b>${esc(v.label)}</b><span>${esc(v.hint)}</span></button>`).join('')}</div>
          <h3 style="margin-top:18px">When and where?</h3>
          <div class="grid3"><div class="field"><label for="wzInc">Date of the incident <span class="muted">(if known)</span></label><input id="wzInc" type="date" max="${FC.today()}" value="${esc(st.incident_date)}"></div>
            <div class="field"><label for="wzDis">Discovered on</label><input id="wzDis" type="date" max="${FC.today()}" value="${esc(st.discovered_date)}"></div>
            <div class="field"><label for="wzPlace">Place</label><input id="wzPlace" maxlength="200" placeholder="e.g. Port of Hamburg, consignee's warehouse" value="${esc(st.place)}"></div></div>
          <div class="field"><span class="lbl">Stage of the transport</span><div class="seg" id="wzStage">${Object.entries(STAGES).map(([k, l]) => `<button type="button" role="radio" data-v="${k}" aria-checked="${st.transit_stage === k}">${esc(l)}</button>`).join('')}</div></div>`;
      }else if(st.step === 2){
        inner = `<h3>Tell us more</h3>
          <div class="field"><label for="wzDesc">What happened, and what is affected?</label><textarea id="wzDesc" rows="5" maxlength="4000" placeholder="e.g. On unloading at the consignee 3 of 12 crates showed fork-lift damage, one machine has a broken housing. Remarks were noted on the CMR.">${esc(st.description)}</textarea><span class="hint">Short and factual is perfect. You can add more later.</span></div>
          <div class="grid3"><div class="field" style="grid-column:span 2"><label for="wzAmt">Estimated loss <span class="muted">(rough figure is fine)</span></label><input id="wzAmt" inputmode="decimal" placeholder="e.g. 12,500" value="${st.estimated_amount !== '' ? esc(st.estimated_amount) : ''}"></div>
            <div class="field"><label for="wzCur">Currency</label><select id="wzCur"><option ${st.currency === 'EUR' ? 'selected' : ''}>EUR</option><option ${st.currency === 'USD' ? 'selected' : ''}>USD</option></select></div></div>
          <div class="field"><label for="wzLoc">Where are the goods now?</label><input id="wzLoc" maxlength="300" placeholder="Address where a surveyor can inspect them" value="${esc(st.goods_location)}"></div>
          <label class="switch"><input type="checkbox" id="wzCarr" ${st.carrier_notified ? 'checked' : ''}><span><b>The carrier has been notified in writing</b><span>Shipping line, trucker, airline or forwarder who had the goods.</span></span></label>
          <label class="switch"><input type="checkbox" id="wzRem" ${st.receipt_remarks ? 'checked' : ''}><span><b>Remarks were noted on the delivery receipt</b><span>e.g. "3 crates damaged" on the CMR, POD or interchange.</span></span></label>
          <div class="grid2" style="margin-top:12px"><div class="field"><label for="wzCN">Contact person</label><input id="wzCN" maxlength="120" value="${esc(st.contact_name)}"></div>
            <div class="field"><label for="wzCP">Phone</label><input id="wzCP" maxlength="60" value="${esc(st.contact_phone)}" placeholder="for the surveyor"></div></div>`;
      }else if(st.step === 3){
        inner = `<h3>Photos and documents</h3><p class="small muted" style="margin:2px 0 12px">The more we see, the faster the insurer can decide. You can also add files later.</p>`;
      }else{
        const t = LOSS[st.loss_type] || {};
        inner = `<h3>Check and send</h3><div class="wiz-review">
          <div class="wiz-ctx">${miniRoute(d.originCountry, d.destCountry, d.conveyance)}<span><b>${esc(d.goods || '')}</b><span class="xs muted">${esc(q.ref || '')}${q.cover_note ? ' · cover note ' + esc(q.cover_note.number) : ''}</span></span></div>
          <dl class="kv"><dt>What happened</dt><dd>${esc(t.label || '')}${st.transit_stage ? ', ' + esc(STAGES[st.transit_stage].toLowerCase()) : ''}</dd>
          <dt>When / where</dt><dd>${esc([st.incident_date ? FC.date(st.incident_date) : '', st.discovered_date ? 'discovered ' + FC.date(st.discovered_date) : '', st.place].filter(Boolean).join(' · ') || '—')}</dd>
          <dt>Description</dt><dd>${esc(st.description)}</dd>
          <dt>Estimated loss</dt><dd>${st.estimated_amount !== '' ? esc(money2(st.estimated_amount, st.currency)) : 'Not known yet'}</dd>
          ${st.goods_location ? `<dt>Goods are at</dt><dd>${esc(st.goods_location)}</dd>` : ''}
          <dt>Carrier / receipt</dt><dd>${st.carrier_notified ? 'Carrier notified' : '<span class="warn-t">Carrier not yet notified</span>'} · ${st.receipt_remarks ? 'remarks on receipt' : 'no remarks noted'}</dd>
          <dt>Contact</dt><dd>${esc([st.contact_name, st.contact_phone].filter(Boolean).join(', '))}</dd>
          <dt>Files</dt><dd>${st.files.length ? st.files.length + ' file' + (st.files.length > 1 ? 's' : '') : 'None yet'}</dd></dl></div>
          ${!st.carrier_notified ? '<div class="notice warn" style="margin:14px 0 0"><b>Please notify the carrier in writing today</b>Hold them liable for the loss. Time limits are short: sea 3 days, road (CMR) 7 days, air 14 days after delivery for damage that was not visible.</div>' : ''}`;
      }
      body.innerHTML = head + `<div class="wiz-pane">${inner}</div><div class="wiz-err err-msg"></div>`;
      if(st.step === 3){
        const pane = body.querySelector('.wiz-pane');
        pane.appendChild(fileDrop(fs => { const big = fs.filter(f => f.size > 20971520); st.files = st.files.concat(fs.filter(f => f.size <= 20971520)).slice(0, 30); paint(); if(big.length) err(big.length + ' file(s) larger than 20 MB were skipped.'); }));
        if(st.files.length) pane.appendChild(thumbs(st.files, i => { st.files.splice(i, 1); paint(); }));
      }
      body.querySelectorAll('[data-q]').forEach(b => b.addEventListener('click', () => { st.q = eligible.find(x => String(x.id) === b.dataset.q); st.currency = (st.q.data || {}).currency || st.currency; paint(); }));
      body.querySelectorAll('[data-loss]').forEach(b => b.addEventListener('click', () => { save(); st.loss_type = b.dataset.loss; body.querySelectorAll('[data-loss]').forEach(x => x.classList.toggle('sel', x === b)); err(''); }));
      const sg = body.querySelector('#wzStage'); if(sg) sg.addEventListener('click', e => { const b = e.target.closest('button'); if(!b) return; st.transit_stage = st.transit_stage === b.dataset.v ? '' : b.dataset.v; sg.querySelectorAll('button').forEach(x => x.setAttribute('aria-checked', String(x.dataset.v === st.transit_stage))); });
      const amt = body.querySelector('#wzAmt'); if(amt) FC.groupInput(amt);
      paintFoot();
    };
    const paintFoot = () => {
      if(!foot) return; foot.innerHTML = '';
      const mk = (l, k, fn) => { const b = FC.el(`<button type="button" class="btn btn-${k}"><span class="spin"></span>${esc(l)}</button>`); b.addEventListener('click', () => fn(b)); foot.appendChild(b); return b; };
      if(st.step > (preQ ? 1 : 0)) mk('Back', 'ghost', () => { save(); st.step--; paint(); });
      else mk('Cancel', 'ghost', () => closeFn(null));
      if(st.step < 4) mk(st.step === 3 ? (st.files.length ? 'Continue' : 'Skip for now') : 'Continue', 'primary', () => { save(); if(!check()) return; st.step++; paint(); box.querySelector('.dlg-body').scrollTop = 0; });
      else mk('Send claim report', 'claim', submit);
    };
    const submit = async (b) => {
      busy(b, true);
      const p = { indication_id: st.q.indication_id, loss_type: st.loss_type, transit_stage: st.transit_stage, incident_date: st.incident_date, discovered_date: st.discovered_date, place: st.place,
        description: st.description, estimated_amount: st.estimated_amount === '' ? '' : st.estimated_amount, currency: st.currency, goods_location: st.goods_location,
        carrier_notified: st.carrier_notified, receipt_remarks: st.receipt_remarks, contact_name: st.contact_name, contact_phone: st.contact_phone };
      const { data, error } = await sb.rpc('report_claim', { p });
      if(error){ busy(b, false); err(FC.errText(error, 'The claim could not be sent. Please try again.')); return; }
      let up = 0;
      if(st.files.length){ b.lastChild.textContent = 'Uploading files…'; up = await uploadClaimFiles(data.id, st.files, (k, n) => { b.lastChild.textContent = `Uploading ${k} / ${n}…`; }); }
      busy(b, false);
      body.innerHTML = `<div class="wiz-done"><svg class="tick big" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M7.5 12.5l3 3 6-6.5"/></svg>
        <h2>Claim reported</h2><p>Your reference is <b>${esc(data.ref)}</b>${st.files.length ? ` · ${up} of ${st.files.length} file${st.files.length > 1 ? 's' : ''} uploaded` : ''}. We are on it and get back to you shortly.</p>
        <ol class="next-steps"><li><b>Keep the goods and the packing</b><span>Do not dispose of or repair anything before the surveyor or we agree.</span></li>
          <li><b>Hold the carrier liable in writing</b><span>Short letter or e-mail to the carrier that had the goods. We can send you a template.</span></li>
          <li><b>We appoint a surveyor if needed</b><span>You see every step and message under My shipments → Claims.</span></li></ol></div>`;
      foot.innerHTML = '';
      const cb = FC.el('<button type="button" class="btn btn-primary">View my claim</button>'); cb.addEventListener('click', async () => { closeFn(true); await loadQuotes(); setQTab('claims'); openClaim(data.id); }); foot.appendChild(cb);
    };
    FC.dialog({ title:'Report a claim', wide:true, body, actions:[], onOpen: (b, c) => { box = b; closeFn = c; foot = b.querySelector('.dlg-foot'); b.classList.add('wiz-dlg'); paint(); } })
      .then(v => { if(v) return; if(qTab === 'claims') loadQuotes(); });
  }
  // ---- claim detail with messages and files ----
  async function openClaim(id){
    const c = claims.find(x => x.id === id); if(!c) return;
    const s = c.shipment || {}, step = clStep(c.status);
    const body = FC.el('<div class="claim-view"></div>');
    let extra = [];
    const paint = async () => {
      const files = c.files || [];
      body.innerHTML = `<div class="cv-head"><div class="cl-ic big t-${esc(c.loss_type)}">${lossIc(c.loss_type)}</div><div><b>${esc((LOSS[c.loss_type] || {}).label || 'Claim')}</b> · ${esc(s.goods || '')}<div class="xs muted">${esc(c.ref)} · ${esc(s.origin || '')} → ${esc(s.dest || '')}${c.cover_note_no ? ' · cover note ' + esc(c.cover_note_no) : ''}${c.insurer_claim_no ? ' · insurer claim no. ' + esc(c.insurer_claim_no) : ''}</div></div><span class="chip ${c.status === 'settled' ? 'paid' : ['rejected','closed'].includes(c.status) ? 'neutral' : 'pending'}">${esc(CL_STATUS[c.status])}</span></div>
        <ol class="cv-steps">${['Reported','In review','With insurer', c.status === 'rejected' ? 'Declined' : c.status === 'closed' ? 'Closed' : 'Settled'].map((l, i) => `<li class="${i < step ? 'done' : i === step ? 'cur' : ''}"><span></span>${l}</li>`).join('')}</ol>
        ${c.settled_amount != null ? `<div class="notice ok" style="margin:0 0 14px"><b>Settled: ${esc(money2(c.settled_amount, c.currency))}</b>The insurer has agreed the claim.</div>` : ''}
        <div class="cv-grid"><div><h3>Messages</h3><div class="chat">${(c.events || []).map(e => e.author_role === 'system' ? `<div class="sys">${esc(e.body || '')} · ${esc(FC.dateTime(e.created_at))}</div>`
            : `<div class="msg ${e.author_role === 'client' ? 'me' : 'them'}">${e.status ? `<span class="chip pending">${esc(CL_STATUS[e.status] || e.status)}</span>` : ''}${e.body ? `<p>${esc(e.body)}</p>` : ''}<span class="xs">${esc(e.author_role === 'client' ? 'You' : (e.author_name || 'FREIGHTCON'))} · ${esc(FC.dateTime(e.created_at))}</span></div>`).join('')}</div>
          ${['closed','rejected','settled'].includes(c.status) ? '' : `<div class="composer"><textarea id="cvMsg" rows="2" maxlength="4000" placeholder="Write to us, e.g. new information or the survey date"></textarea><div class="composer-row"><label class="btn btn-ghost btn-sm" style="cursor:pointer">${FC.icon.upload}Attach<input type="file" id="cvFiles" multiple hidden accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.msg,.eml,.txt,.heic"></label><span class="xs muted" id="cvPicked"></span><span style="flex:1"></span><button type="button" class="btn btn-primary btn-sm" id="cvSend"><span class="spin"></span>${FC.icon.send}Send</button></div></div>`}</div>
          <div><h3>Details</h3><dl class="kv"><dt>Reported</dt><dd>${esc(FC.dateTime(c.created_at))}</dd>
            ${c.incident_date ? `<dt>Incident</dt><dd>${esc(FC.date(c.incident_date))}</dd>` : ''}${c.place ? `<dt>Place</dt><dd>${esc(c.place)}</dd>` : ''}
            ${c.transit_stage ? `<dt>Stage</dt><dd>${esc(STAGES[c.transit_stage] || c.transit_stage)}</dd>` : ''}
            <dt>Description</dt><dd>${esc(c.description)}</dd>
            <dt>Estimated loss</dt><dd>${c.estimated_amount != null ? esc(money2(c.estimated_amount, c.currency)) : 'Not stated'}</dd>
            ${c.goods_location ? `<dt>Goods at</dt><dd>${esc(c.goods_location)}</dd>` : ''}</dl>
            <h3 style="margin-top:14px">Files (${files.length})</h3><div class="cl-thumbs" id="cvThumbs">${files.length ? '' : '<p class="xs muted" style="margin:0">No files yet.</p>'}</div></div></div>`;
      // thumbnails with signed links
      const th = body.querySelector('#cvThumbs');
      if(files.length){
        const signed = await sb.storage.from('claims').createSignedUrls(files.map(f => f.path), 600).catch(() => ({ data:[] }));
        files.forEach((f, i) => {
          const u = ((signed.data || [])[i] || {}).signedUrl, img = /^image\//.test(f.mime || '') && !/heic/i.test(f.mime || '');
          const a = FC.el(`<a class="cl-thumb" target="_blank" rel="noopener" ${u ? `href="${esc(u)}"` : ''}>${img && u ? `<img alt="" src="${esc(u)}">` : `<span class="cl-doc">${esc((f.name.split('.').pop() || 'file').toUpperCase().slice(0, 4))}</span>`}<span class="cl-fn">${esc(f.name)}</span><span class="xs muted">${f.uploaded_by === 'staff' ? 'from us · ' : ''}${f.size ? esc(fmtSize(f.size)) : ''}</span></a>`);
          th.appendChild(a);
        });
      }
      const chat = body.querySelector('.chat'); if(chat) chat.scrollTop = chat.scrollHeight;
      const fin = body.querySelector('#cvFiles'); if(fin) fin.addEventListener('change', () => { extra = Array.from(fin.files).filter(f => f.size <= 20971520); body.querySelector('#cvPicked').textContent = extra.length ? extra.length + ' file(s) ready' : ''; });
      const sendB = body.querySelector('#cvSend');
      if(sendB) sendB.addEventListener('click', async () => {
        const msg = body.querySelector('#cvMsg').value.trim(); if(!msg && !extra.length) return;
        busy(sendB, true);
        let n = 0; if(extra.length) n = await uploadClaimFiles(c.id, extra);
        const { error } = await sb.rpc('add_claim_message', { p_claim_id: c.id, p_body: msg, p_files: n });
        busy(sendB, false);
        if(error){ toast(FC.errText(error, 'Could not send.'), 'error'); return; }
        extra = []; const r = await sb.rpc('my_claims'); claims = r.data || claims; Object.assign(c, claims.find(x => x.id === c.id) || {}); paint(); toast('Sent.');
      });
    };
    FC.dialog({ title: 'Claim ' + c.ref, wide:true, body, actions:[{ label:'Close', kind:'ghost', value:null }], onOpen: () => paint() }).then(() => { if(qTab === 'claims') renderQuotes(); });
  }
  function btn(label, kind, fn){
    const b = FC.el(`<button type="button" class="btn btn-${kind} btn-sm"><span class="spin"></span>${esc(label)}</button>`);
    b.addEventListener('click', () => fn(b)); return b;
  }
  async function pdfQuote(q, b){
    busy(b, true);
    try{ FC.saveBlob(await FCPDF.quotation(q, { ref:q.ref }), FCPDF.fileName('FREIGHTCON_Quotation', q.ref, 'v' + q.version)); }
    catch(e){ console.error(e); toast('The PDF could not be created.', 'error'); }
    busy(b, false);
  }
  async function pdfCover(q, b){
    busy(b, true);
    try{ FC.saveBlob(await FCPDF.coverNote(q.cover_note, { ref:q.ref }), FCPDF.fileName('FREIGHTCON_CoverNote', q.cover_note.number)); }
    catch(e){ console.error(e); toast('The PDF could not be created.', 'error'); }
    busy(b, false);
  }
  function quoteBody(q){
    const d = q.data || {};
    const lines = (d.lines || []).map(l => `<tr><td>${esc(l.label)}<br><span class="xs muted">${esc(money2(l.sum, d.currency))} at ${esc(FC.pct(l.rate))}</span></td><td class="r">${esc(money2(l.premium, d.currency))}</td></tr>`).join('');
    return `<dl class="kv">
        <dt>Reference</dt><dd>${esc(q.ref || '')}${q.version > 1 ? ' (version ' + q.version + ')' : ''}</dd>
        <dt>Assured</dt><dd>${esc(d.client || '')}</dd>
        <dt>Goods</dt><dd>${esc(d.goods || '')}</dd>
        <dt>Voyage</dt><dd>${esc(d.voyage || '')}</dd>
        <dt>Conditions</dt><dd>${esc(d.conditions || '')}</dd>
        ${d.insurer ? `<dt>Insurer</dt><dd>${esc(d.insurer)}</dd>` : ''}
        ${d.deductible ? `<dt>Deductible</dt><dd>${esc(d.deductible)}</dd>` : ''}
        ${d.special ? `<dt>Special conditions</dt><dd>${esc(d.special)}</dd>` : ''}
        <dt>Valid until</dt><dd>${esc(FC.dateTime(q.valid_until))}</dd>
      </dl>
      <table class="qtable">${lines}
        ${Number(d.discountPct) > 0 ? `<tr><td>Client discount ${esc(Number(d.discountPct))} %</td><td class="r">− ${esc(money2(d.discountAmount, d.currency))}</td></tr>` : ''}
        ${Number(d.taxPct) > 0 ? `<tr><td>Insurance tax ${esc(Number(d.taxPct))} %</td><td class="r">${esc(money2(d.tax, d.currency))}</td></tr>` : ''}
        <tr class="tot"><td>Total premium payable</td><td class="r">${esc(money2(d.total, d.currency))}</td></tr></table>
      ${(d.subjectivities || []).length ? `<h3 style="margin:14px 0 6px">Subject to</h3><ul class="small" style="margin:0;padding-left:18px">${d.subjectivities.map(s => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
      ${d.note ? `<div class="notice info" style="margin:14px 0 0"><b>Note</b>${esc(d.note)}</div>` : ''}
      ${q.response_note ? `<div class="notice ok" style="margin:14px 0 0"><b>Your message</b>${esc(q.response_note)}</div>` : ''}`;
  }
  function openQuote(q){
    const open = q.status === 'open';
    const actions = [{ label:'Download PDF', kind:'ghost', onClick: async () => { await pdfQuote(q); } }];
    if(open){
      actions.push({ label:'Decline', kind:'danger', onClick: async (close, box) => respond(q, false, box, close) });
      actions.push({ label:'Accept quotation', kind:'ok', onClick: async (close, box) => respond(q, true, box, close) });
    }
    FC.dialog({ title: open ? 'Quotation' : 'Quotation (' + (qStatusLabel[q.status] || q.status) + ')', wide:true,
      body: quoteBody(q) + (open ? `<div class="field" style="margin-top:16px"><label for="qrNote">Message <span class="muted">(optional)</span></label><textarea id="qrNote" maxlength="1000" placeholder="e.g. B/L number, vessel, or reason for declining"></textarea></div>${q.data && q.data.closing ? `<p class="xs muted">${esc(q.data.closing)}</p>` : ''}<div class="err-msg" id="qrErr"></div>` : ''),
      actions });
  }
  async function respond(q, accept, box, close){
    if(accept && !(await FC.confirm('Accept this quotation?', 'You instruct us to place cover on these terms for ' + money2(q.data.total, q.data.currency) + '. We confirm in writing and send the cover note.', 'Accept quotation', 'ok'))) return;
    const { error } = await sb.rpc('respond_to_quotation', { p_quotation_id: q.id, p_accept: accept, p_note: box.querySelector('#qrNote').value });
    if(error){ box.querySelector('#qrErr').textContent = FC.errText(error); return; }
    if(accept) justStamped = q.id;
    close(true); toast(accept ? 'Accepted. We confirm the cover shortly.' : 'Quotation declined.'); loadQuotes();
  }

  // ---------- history ----------
  let hist = [];
  async function loadHistory(){
    $('#hList').innerHTML = '<div class="empty">Loading…</div>';
    const { data, error } = await sb.rpc('my_history', { p_limit: 300 });
    if(error){ $('#hList').innerHTML = '<div class="empty">Could not load your history.</div>'; return; }
    hist = data || []; renderHistory();
  }
  $('#hSearch').addEventListener('input', () => renderHistory());
  function renderHistory(){
    const s = $('#hSearch').value.trim().toLowerCase();
    const rows = hist.filter(r => !s || [r.goods_description, r.ref, r.customer_ref, r.insured_name, r.origin_country, r.dest_country, countryName(r.origin_country), countryName(r.dest_country), r.origin_place, r.dest_place].join(' ').toLowerCase().includes(s));
    const host = $('#hList'); host.innerHTML = '';
    if(!rows.length){ host.innerHTML = `<div class="empty card">${hist.length ? '' : FC.shipArt}<h3>${hist.length ? 'No matches' : 'No indications yet'}</h3><p>${hist.length ? 'Try another search term.' : 'Your calculations appear here.'}</p></div>`; return; }
    rows.forEach(r => {
      const it = FC.el(`<div class="item"><div>
          <div class="route">${esc(r.origin_country)} → ${esc(r.dest_country)} <span class="chip ${esc(r.status)}">${esc(FC.STATUS[r.status])}</span>${r.quote_requested_at ? ' <span class="chip neutral">Requested</span>' : ''}</div>
          <div class="t">${esc(r.goods_description)}${r.insured_name ? ' <span class="muted">for ' + esc(r.insured_name) + '</span>' : ''}</div>
          <div class="meta">${esc(FC.dateTime(r.created_at))}${r.ref ? ', ' + esc(r.ref) : ''}${r.customer_ref ? ', your ref. ' + esc(r.customer_ref) : ''}, sum insured ${esc(money2(r.sum_insured, r.currency))}${r.status === 'quoted' ? ', premium ' + esc(money2(r.premium, r.currency)) : ''}</div>
        </div><div class="acts"></div></div>`);
      const a = it.querySelector('.acts');
      a.appendChild(btn('Open', 'ghost', () => { go('new'); writeForm(r); current = Object.assign({}, r); renderResult(current, false); }));
      a.appendChild(btn('Recalculate', 'ghost', () => { go('new'); writeForm(r); $('#shipForm').requestSubmit(); }));
      a.appendChild(btn('Remove', 'ghost', async () => {
        if(!(await FC.confirm('Remove from history?', 'The calculation disappears from your list. Requests already sent are not affected.', 'Remove', 'danger'))) return;
        const { error } = await sb.rpc('hide_my_indication', { p_id: r.id });
        if(error){ toast('Could not remove it.', 'error'); return; }
        hist = hist.filter(x => x.id !== r.id); renderHistory();
      }));
      host.appendChild(it);
    });
  }

  // ---------- badges ----------
  async function refreshBadges(){
    const { data } = await sb.rpc('my_quotations');
    const n = (data || []).filter(q => !q.seen_at || q.status === 'open').length;
    $('#quoteBadge').hidden = !n; $('#quoteBadge').textContent = n;
  }
  refreshBadges(); setInterval(refreshBadges, 120000);

  // ---------- account dialogs ----------
  async function openAccount(kind){
    setMenu(false);
    if(kind === 'profile'){
      FC.dialog({ title:'My profile', body:`
        <div class="field"><label for="acName">Name</label><input id="acName" maxlength="100" value="${esc(profile.full_name || '')}"></div>
        <div class="field"><label>Company</label><input readonly value="${esc(profile.company || '')}"></div>
        <div class="field"><label for="acAddr">Street and number</label><input id="acAddr" maxlength="150" value="${esc(profile.address_line || '')}"></div>
        <div class="grid2" style="margin-top:12px;grid-template-columns:110px 1fr"><div class="field"><label for="acZip">Postcode</label><input id="acZip" maxlength="20" value="${esc(profile.postcode || '')}"></div><div class="field"><label for="acCity">City</label><input id="acCity" maxlength="80" value="${esc(profile.city || '')}"></div></div>
        <div class="grid2" style="margin-top:12px"><div class="field"><label for="acCountry">Country</label><input id="acCountry" maxlength="80" value="${esc(profile.country || '')}"></div><div class="field"><label for="acPhone">Phone</label><input id="acPhone" maxlength="40" value="${esc(profile.phone || '')}"></div></div>
        <div class="field"><label>E-mail</label><input readonly value="${esc(profile.email)}"><span class="hint">To change company or e-mail, please contact us.</span></div>
        ${Number(profile.client_discount_pct) > 0 ? `<div class="notice ok" style="margin:14px 0 0"><b>Client discount ${esc(Number(profile.client_discount_pct))} %</b>Applied to all your indications.</div>` : ''}
        <div class="err-msg" id="acErr"></div>`,
        actions:[{ label:'Cancel', kind:'ghost', value:null }, { label:'Save', kind:'primary', onClick: async (close, box) => {
          const nm = box.querySelector('#acName').value.trim();
          if(nm.length < 2){ box.querySelector('#acErr').textContent = 'Please enter your name.'; return; }
          const { error } = await sb.rpc('update_my_name', { p_name: nm });
          if(error){ box.querySelector('#acErr').textContent = 'Could not save.'; return; }
          const ad = { p_address: box.querySelector('#acAddr').value, p_postcode: box.querySelector('#acZip').value, p_city: box.querySelector('#acCity').value, p_country: box.querySelector('#acCountry').value, p_phone: box.querySelector('#acPhone').value };
          const r2 = await sb.rpc('update_my_address', ad);
          if(r2.error){ box.querySelector('#acErr').textContent = 'The name was saved, the address could not be saved.'; return; }
          Object.assign(profile, { address_line: ad.p_address.trim(), postcode: ad.p_postcode.trim(), city: ad.p_city.trim(), country: ad.p_country.trim(), phone: ad.p_phone.trim() });
          profile.full_name = nm; $('#whoName').textContent = nm; $('#avatarBtn').textContent = FC.initials(nm); toast('Saved.'); return true;
        } }] });
    }else if(kind === 'password'){
      FC.dialog({ title:'Change password', body:`
        <div class="field"><label for="pw0">Current password</label><input id="pw0" type="password" autocomplete="current-password"></div>
        <div class="field"><label for="pw1">New password</label><input id="pw1" type="password" autocomplete="new-password"><span class="hint">At least 8 characters.</span></div>
        <div class="field"><label for="pw2">Repeat new password</label><input id="pw2" type="password" autocomplete="new-password"></div>
        <div class="err-msg" id="pwErr"></div>`,
        actions:[{ label:'Cancel', kind:'ghost', value:null }, { label:'Change password', kind:'primary', onClick: async (close, box) => {
          const e = t => { box.querySelector('#pwErr').textContent = t; }, o = box.querySelector('#pw0').value, a = box.querySelector('#pw1').value, c = box.querySelector('#pw2').value;
          if(!o) return e('Enter your current password.'); if(a.length < 8) return e('The new password needs at least 8 characters.'); if(a !== c) return e('The new passwords do not match.');
          const chk = await sb.auth.signInWithPassword({ email: profile.email, password: o }); if(chk.error) return e('The current password is not correct.');
          const { error } = await sb.auth.updateUser({ password: a }); if(error) return e('Could not change the password.');
          toast('Password changed.'); return true;
        } }] });
    }else if(kind === 'invite'){
      const { data } = await sb.rpc('my_referrals');
      const code = data && data.code, link = code ? location.origin + location.pathname.replace(/app\.html$/, '') + 'index.html?ref=' + encodeURIComponent(code) : '';
      const reward = data && data.reward_pct != null ? Number(data.reward_pct) : 5;
      const subject = 'Cargo insurance online — ' + FC.brand;
      const text = 'Hello,\n\nI use ' + FC.brand + ' to get cargo insurance indications and quotations online in a few minutes, and thought it could be useful for you as well.\n\nYou can register here: ' + link + '\n\nBest regards\n' + (profile.full_name || '');
      FC.dialog({ title:'Invite a client', body:`
        <p style="margin-top:0">Know a forwarder, trader or shipper who could use ${esc(FC.brand)}? Share your personal link. When they become a customer, you receive a <b>${esc(reward)} % client discount</b> on all your future requests.</p>
        <div class="field"><label for="invLink">Your personal link</label><input id="invLink" readonly value="${esc(link || 'Not available yet')}"></div>
        <p class="xs muted">${data ? esc(data.count) + ' registered with your link, ' + esc(data.approved) + ' confirmed.' : ''}</p>
        <div class="ok-msg" id="invMsg"></div>`,
        actions:[
          { label:'Open in e-mail', kind:'ghost', onClick: async () => { location.href = 'mailto:?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(text); } },
          { label:'Copy invitation text', kind:'ghost', onClick: async (c, box) => { await copy(subject + '\n\n' + text); box.querySelector('#invMsg').textContent = 'Invitation text copied.'; } },
          { label:'Copy link', kind:'primary', onClick: async (c, box) => { await copy(link); box.querySelector('#invMsg').textContent = 'Link copied.'; } }
        ] });
    }else if(kind === 'data'){
      FC.dialog({ title:'My data', body:`<p style="margin-top:0">Download everything we hold about you in ${esc(FC.brand)} as an Excel file. You can also ask us to delete your account; we confirm by e-mail. Quotation and policy records may have to be kept for statutory reasons.</p><div class="ok-msg" id="dMsg"></div><div class="err-msg" id="dErr"></div>`,
        actions:[
          { label:'Request account deletion', kind:'danger', onClick: async (c, box) => {
            if(!(await FC.confirm('Request account deletion?', 'We delete your account and confirm by e-mail. You can no longer log in afterwards.', 'Request deletion', 'danger'))) return;
            const { error } = await sb.rpc('request_account_deletion');
            if(error){ box.querySelector('#dErr').textContent = 'Could not send the request.'; return; }
            box.querySelector('#dMsg').textContent = 'Request received. We confirm by e-mail.';
          } },
          { label:'Download my data', kind:'primary', onClick: async (c, box) => {
            try{ await exportData(); box.querySelector('#dMsg').textContent = 'Download started.'; }
            catch(e){ console.error(e); box.querySelector('#dErr').textContent = 'Could not prepare the download.'; }
          } }
        ] });
    }
  }
  $$('[data-acc]').forEach(b => b.addEventListener('click', () => openAccount(b.dataset.acc)));
  $('#inviteBtn').addEventListener('click', () => openAccount('invite'));
  async function copy(t){ try{ await navigator.clipboard.writeText(t); }catch(e){ const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); } }
  FC.copy = copy;

  async function exportData(){
    const { data, error } = await sb.rpc('export_my_data'); if(error) throw error;
    if(!window.ExcelJS) await FC.loadScript('https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js');
    const wb = new ExcelJS.Workbook();
    const sheet = (name, cols, rows) => { const ws = wb.addWorksheet(name); ws.columns = cols.map(c => ({ header:c[0], key:c[1], width:c[2] })); rows.forEach(r => ws.addRow(r)); ws.getRow(1).font = { bold:true }; ws.views = [{ state:'frozen', ySplit:1 }]; };
    const p = data.profile || {};
    sheet('Profile', [['Field','k',22],['Value','v',50]], [{k:'Name',v:p.name},{k:'Company',v:p.company},{k:'E-mail',v:p.email},{k:'Country',v:p.country},{k:'Phone',v:p.phone},{k:'Registered',v:FC.dateTime(p.registered_at)},{k:'Exported',v:FC.dateTime(data.exported_at)}]);
    sheet('Indications', [['Date','d',18],['Reference','ref',16],['Goods','g',36],['From','o',8],['To','t',8],['Conveyance','c',16],['Sum insured','si',14],['Currency','cur',9],['Cover','cov',10],['Status','s',12],['Rate %','r',9],['Premium','p',12],['Requested','q',18]],
      (data.indications || []).map(r => ({ d:FC.dateTime(r.created_at), ref:r.ref || '', g:r.goods_description, o:r.origin_country, t:r.dest_country, c:(FC.CONVEYANCE[r.conveyance] || {}).short, si:Number(r.sum_insured), cur:r.currency, cov:r.cover, s:FC.STATUS[r.status], r:r.rate_pct == null ? '' : Number(r.rate_pct), p:r.premium == null ? '' : Number(r.premium), q:r.quote_requested_at ? FC.dateTime(r.quote_requested_at) : '' })));
    sheet('Quotations', [['Reference','ref',16],['Version','v',8],['Status','s',12],['Total','t',12],['Currency','c',9],['Valid until','u',18],['Cover note','cn',18]],
      (data.quotations || []).map(q => ({ ref:q.ref, v:q.version, s:q.status, t:Number((q.data || {}).total), c:(q.data || {}).currency, u:FC.dateTime(q.valid_until), cn:q.cover_note ? q.cover_note.number : '' })));
    sheet('Invoices', [['Number','n',16],['Amount','a',12],['Currency','c',9],['Due','d',14],['Paid','p',18]], (data.invoices || []).map(i => ({ n:i.number, a:Number(i.amount), c:i.currency, d:i.due_date || '', p:i.paid_at ? FC.dateTime(i.paid_at) : '' })));
    FC.saveBlob(await wb.xlsx.writeBuffer(), 'FREIGHTCON_My_Data_' + FC.today() + '.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  }

  // ---------- feedback ----------
  $('#feedbackMenu').addEventListener('click', () => { setMenu(false); $('#feedbackBtn').click(); });
  $('#feedbackBtn').addEventListener('click', () => FC.dialog({ title:'Send feedback',
    body:`<p style="margin-top:0">Tell us what works and what does not. We read every message.</p><div class="field"><label for="fbMsg">Your message</label><textarea id="fbMsg" rows="5" maxlength="3000"></textarea></div><div class="err-msg" id="fbErr"></div>`,
    actions:[{ label:'Cancel', kind:'ghost', value:null }, { label:'Send feedback', kind:'primary', onClick: async (close, box) => {
      const m = box.querySelector('#fbMsg').value.trim(); if(m.length < 2){ box.querySelector('#fbErr').textContent = 'Please write a short message.'; return; }
      const { error } = await sb.rpc('submit_feedback', { p_message: m, p_page: location.hash.slice(1) || 'new' });
      if(error){ box.querySelector('#fbErr').textContent = 'Could not send. Please try again.'; return; }
      toast('Feedback sent. Thank you.'); return true;
    } }] }));

  // ---------- start ----------
  writeForm({});
  go(location.hash.slice(1) || 'new');
})();
