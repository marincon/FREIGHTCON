/* FREIGHTCON — customer area */
(async function(){
  'use strict';
  const { $, $$, sb, esc, money, money2, busy, toast } = FC;
  if(!sb){ document.body.innerHTML = '<p style="padding:40px">config.js is missing or incomplete. See README.</p>'; return; }
  // app.html and app.js must come from the same release; a stale app.html would break the form
  { const m = document.querySelector('meta[name="fc-version"]');
    if(!m || m.content !== '2026-10-20c'){ document.body.insertAdjacentHTML('afterbegin', '<div class="banner" style="position:relative;z-index:500">This page is out of date (app.html does not match the scripts). Upload the latest app.html to the top of the repository and reload.</div>'); return; } }

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
  $('#icBox').innerHTML = FC.icon.box; $('#icRoute').innerHTML = FC.icon.route; $('#icCoin').innerHTML = FC.icon.coin; $('#icShield').innerHTML = FC.icon.shield; $('#icDoc').innerHTML = FC.icon.doc;
  $('#inviteBtn').innerHTML = FC.icon.gift; $('#feedbackBtn').innerHTML = FC.icon.chat;
  $$('[data-ic]').forEach(s => s.outerHTML = FC.icon[s.dataset.ic]);
  const paintTheme = () => { $('#themeBtn').innerHTML = FC.isDark() ? FC.icon.sun : FC.icon.moon; };
  paintTheme(); $('#themeBtn').addEventListener('click', () => { FC.toggleTheme(); paintTheme(); });
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
  fill($('#fCommodity'), commodities.map(c => `<option value="${esc(c.id)}">${esc(c.name)}${c.on_request ? ' (quoted individually)' : ''}</option>`), 'Choose…');
  const countryOpts = countries.map(c => `<option value="${esc(c.iso2)}">${esc(c.name)}</option>`);
  fill($('#fOrigin'), countryOpts, 'Choose…'); fill($('#fDest'), countryOpts, 'Choose…');
  $('#fDep').min = FC.today();
  FC.groupInput($('#fValue'));
  if(settings.uplift_pct != null) $('#fUplift').value = settings.uplift_pct;

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
      interest_only: !$('#interestField').hidden && $('#fInterest').checked
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
    $$('.field.invalid', form).forEach(f => f.classList.remove('invalid'));
    onFormChange();
  }
  function onFormChange(){
    const v = readForm();
    const com = commodities.find(c => c.id === v.commodity_id);
    // covers allowed for this cargo
    $$('.cover-opt', coverHost).forEach(l => {
      const ok = !com || (com.allowed_covers || []).includes(l.dataset.v);
      l.classList.toggle('off', !ok); l.querySelector('input').disabled = !ok;
    });
    if(com && !(com.allowed_covers || []).includes(v.cover)){ const first = coverHost.querySelector('input:not(:disabled)'); if(first) first.checked = true; }
    $('#commodityHint').textContent = com ? (com.on_request ? 'This cargo is always quoted individually. You can still request a quotation.' : (com.description || '')) : '';
    $('#convHint').textContent = com && v.conveyance && !com.on_request && !(com.conveyances || []).includes(v.conveyance) ? 'This cargo is quoted individually for this conveyance.' : '';
    const land = v.conveyance === 'road' || v.conveyance === 'rail';
    $('#warLbl').textContent = land ? 'Strikes, riots & civil commotion' : 'War & strikes';
    $('#warTxt').textContent = land ? 'Institute Strikes Clauses (Cargo). War risks are not insurable on land transit.' : v.conveyance === 'air' || v.conveyance === 'air_charter' ? 'Institute War and Strikes Clauses (Air Cargo). Added to the premium.' : 'Institute War and Strikes Clauses (Cargo). Included in sea rates; untick to leave it out.';
    const si = isFinite(v.invoice_value) && v.invoice_value > 0 && isFinite(v.uplift_pct) ? v.invoice_value * (1 + v.uplift_pct / 100) : NaN;
    $('#siOut').textContent = isFinite(si) ? money2(si, v.currency) : '—';
    $('#vesselField').hidden = !isSea(v.conveyance);
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
    current = data; renderResult(current, true);
    if(window.matchMedia('(max-width: 1040px)').matches) $('#resultHost').scrollIntoView({ behavior:'smooth', block:'start' });
  });
  $('#clearBtn').addEventListener('click', () => { form.reset(); writeForm({}); current = null; $('#resultHost').innerHTML = ''; $('#resultHost').appendChild(howto); });
  const howto = $('#howto');

  function decorate(r){
    r.origin_name = r.origin_name || countryName(r.origin_country);
    r.dest_name = r.dest_name || countryName(r.dest_country);
    r.commodity_name = r.commodity_name || ((commodities.find(c => c.id === r.commodity_id) || {}).name) || '';
    r.deductible_text = r.deductible_text || settings.deductible_text || '';
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
        <div class="track"><i></i><span class="mode" title="${esc(conv.label)}">${FC.icon[r.conveyance] || ''}</span><i></i></div>
        <div class="end to"><span class="iso">${esc(r.dest_country)}</span><span class="place">${esc(r.dest_place || r.dest_name)}</span><span class="cty">${esc(r.dest_place ? r.dest_name : '')}</span></div>
      </div>
      <dl class="facts">
        <div><dt>Goods</dt><dd>${esc(r.goods_description)}</dd></div>
        <div><dt>Cargo type</dt><dd>${esc(r.commodity_name)}</dd></div>
        <div><dt>Sum insured</dt><dd class="num">${esc(money2(r.sum_insured, r.currency))}</dd></div>
        <div><dt>Conveyance</dt><dd>${esc(conv.label || '')}${r.departure_date ? ', departs ' + esc(FC.date(r.departure_date)) : ''}</dd></div>
        <div><dt>Cover</dt><dd>${esc(cov.clause || '')}</dd></div>
        <div><dt>${land ? 'Strikes' : 'War & strikes'}</dt><dd>${r.war_strikes ? 'Included' : 'Not included'}</dd></div>
        ${r.on_deck || r.interest_only ? `<div><dt>Special</dt><dd>${[r.on_deck ? 'Shipped on deck' : '', r.interest_only ? "Own interest only (contingency)" : ''].filter(Boolean).join(', ')}</dd></div>` : ''}
        ${isSea(r.conveyance) ? `<div><dt>Vessel</dt><dd>${esc(r.vessel || 'To be declared')}</dd></div>` : ''}
        ${r.incoterm ? `<div><dt>Incoterm</dt><dd>${esc(r.incoterm)}, cover for the ${esc(r.insured_party || 'seller')}</dd></div>` : ''}
      </dl>
      ${body}
      <div class="consign-actions">
        ${requested ? '' : `<label class="lbl" for="qComment">Message to us <span class="muted">(optional)</span></label><textarea id="qComment" maxlength="1000" placeholder="e.g. vessel name, packing details, preferred insurer, deadline"></textarea>`}
        <div class="row">
          ${requested ? `<div class="notice ok" style="margin:0;flex:1"><b>Quotation requested</b>We received your request ${esc(r.ref ? 'under ' + r.ref : '')}. You find the quotation in My quotations as soon as it is ready.</div>`
                      : `<button class="btn btn-primary" id="reqBtn" type="button" ${r.status === 'sanctioned' ? '' : ''}><span class="spin"></span>${FC.icon.send}Request quotation</button>`}
          <button class="btn btn-ghost" id="pdfBtn" type="button"><span class="spin"></span>${FC.icon.download}Download PDF</button>
        </div>
      </div>
      <p class="fine">Indications are non-binding. Cover is only in place once a quotation has been accepted and confirmed in writing. Deductible: ${esc(r.deductible_text)}.${isSea(r.conveyance) ? ' Sea transport is subject to the Institute Classification Clause: older or unclassed vessels may carry an additional premium. We check the vessel before we quote.' : ''}</p>
    </article>`);
    const host = $('#resultHost'); host.innerHTML = ''; host.appendChild(card);
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

  // ---------- views & routing ----------
  const views = ['new', 'quotes', 'history', 'admin'];
  async function go(v){
    if(!views.includes(v) || (v === 'admin' && !profile.is_admin)) v = 'new';
    $$('[data-view-panel]').forEach(p => p.hidden = p.dataset.viewPanel !== v);
    $$('[data-view]').forEach(b => { if(b.classList.contains('internal-pill')) b.setAttribute('aria-pressed', String(v === 'admin')); else if(b.dataset.view === v) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    if(location.hash !== '#' + v) history.replaceState(null, '', '#' + v);
    if(v === 'quotes') loadQuotes();
    if(v === 'history') loadHistory();
    if(v === 'admin'){
      if(!window.FCAdmin) await FC.loadScript('assets/admin.js');
      window.FCAdmin.open($('#view-admin'));
    }
    window.scrollTo({ top: 0 });
  }
  FC.go = go;
  $$('[data-view]').forEach(b => b.addEventListener('click', () => go(b.dataset.view)));
  window.addEventListener('hashchange', () => go(location.hash.slice(1)));
  if(profile.is_admin){ $('#internalBtn').hidden = false; $('#mobInternal').hidden = false; FC.loadScript('assets/admin.js').catch(() => {}); }

  // ---------- my quotations ----------
  let qTab = 'quotations', quotes = [], waiting = [], invoices = [];
  $$('[data-qtab]').forEach(b => b.addEventListener('click', () => { qTab = b.dataset.qtab; $$('[data-qtab]').forEach(x => x.setAttribute('aria-selected', String(x === b))); renderQuotes(); }));
  async function loadQuotes(){
    $('#qList').innerHTML = '<div class="empty">Loading…</div>';
    const [a, w, inv] = await Promise.all([sb.rpc('my_quotations'), sb.rpc('my_pending_requests'), sb.from('invoices').select('*').order('created_at', { ascending:false })]);
    if(a.error || w.error){ $('#qList').innerHTML = '<div class="empty">Could not load your quotations. Please reload the page.</div>'; return; }
    quotes = a.data || []; waiting = w.data || []; invoices = inv.data || [];
    renderQuotes();
    sb.rpc('mark_quotations_seen').then(() => refreshBadges());
  }
  const qStatusLabel = { open:'Open', accepted:'Accepted', declined:'Declined', expired:'Expired', withdrawn:'Withdrawn' };
  function renderQuotes(){
    const host = $('#qList'); host.innerHTML = '';
    $('#waitBadge').hidden = !waiting.length; $('#waitBadge').textContent = waiting.length;
    if(qTab === 'quotations'){
      if(!quotes.length){ host.innerHTML = `<div class="empty card"><h3>No quotations yet</h3><p>Calculate a shipment and request a quotation. It appears here when it is ready.</p><button class="btn btn-primary" data-go-new>New shipment</button></div>`; }
      quotes.forEach(q => {
        const d = q.data || {}, st = q.cover_note ? 'bound' : q.status;
        const it = FC.el(`<div class="item${!q.seen_at ? ' new' : ''}">
          <div><div class="route">${esc(d.originCountry || '')} → ${esc(d.destCountry || '')} <span class="chip ${esc(st)}">${esc(q.cover_note ? 'Covered' : qStatusLabel[q.status] || q.status)}</span></div>
            <div class="t">${esc(d.goods || '')}</div>
            <div class="meta">${esc(q.ref || '')}${q.version > 1 ? ' (version ' + q.version + ')' : ''}, ${esc(money2(d.total, d.currency))}${q.status === 'open' ? ', valid until ' + esc(FC.dateTime(q.valid_until)) : ''}${q.cover_note ? ', cover note ' + esc(q.cover_note.number) : ''}</div></div>
          <div class="acts"></div></div>`);
        const acts = it.querySelector('.acts');
        acts.appendChild(btn(q.status === 'open' ? 'Review & accept' : 'View', q.status === 'open' ? 'primary' : 'ghost', () => openQuote(q)));
        acts.appendChild(btn('Quotation PDF', 'ghost', b => pdfQuote(q, b)));
        if(q.cover_note) acts.appendChild(btn('Cover note PDF', 'ghost', b => pdfCover(q, b)));
        host.appendChild(it);
      });
    }else if(qTab === 'waiting'){
      if(!waiting.length) host.innerHTML = '<div class="empty card"><h3>Nothing waiting</h3><p>Requests you send appear here until the quotation is ready.</p></div>';
      waiting.forEach(r => {
        const it = FC.el(`<div class="item"><div><div class="route">${esc(r.origin_country)} → ${esc(r.dest_country)} <span class="chip waiting">Waiting</span></div>
          <div class="t">${esc(r.goods_description)}</div>
          <div class="meta">${esc(r.ref || '')}, sum insured ${esc(money2(r.sum_insured, r.currency))}, requested ${esc(FC.ago(r.quote_requested_at))}</div></div><div class="acts"></div></div>`);
        it.querySelector('.acts').appendChild(btn('Open', 'ghost', () => { go('new'); writeForm(r); current = r; renderResult(r, false); }));
        host.appendChild(it);
      });
    }else{
      if(!invoices.length) host.innerHTML = '<div class="empty card"><h3>No invoices</h3><p>Premium invoices for bound shipments appear here.</p></div>';
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
    const rows = hist.filter(r => !s || [r.goods_description, r.ref, r.origin_country, r.dest_country, countryName(r.origin_country), countryName(r.dest_country), r.origin_place, r.dest_place].join(' ').toLowerCase().includes(s));
    const host = $('#hList'); host.innerHTML = '';
    if(!rows.length){ host.innerHTML = `<div class="empty card"><h3>${hist.length ? 'No matches' : 'No indications yet'}</h3><p>${hist.length ? 'Try another search term.' : 'Your calculations appear here.'}</p></div>`; return; }
    rows.forEach(r => {
      const it = FC.el(`<div class="item"><div>
          <div class="route">${esc(r.origin_country)} → ${esc(r.dest_country)} <span class="chip ${esc(r.status)}">${esc(FC.STATUS[r.status])}</span>${r.quote_requested_at ? ' <span class="chip neutral">Requested</span>' : ''}</div>
          <div class="t">${esc(r.goods_description)}</div>
          <div class="meta">${esc(FC.dateTime(r.created_at))}${r.ref ? ', ' + esc(r.ref) : ''}, sum insured ${esc(money2(r.sum_insured, r.currency))}${r.status === 'quoted' ? ', premium ' + esc(money2(r.premium, r.currency)) : ''}</div>
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
