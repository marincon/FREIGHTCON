/* FREIGHTCON — PDF documents (indication, quotation, cover note) with pdf-lib */
(function(){
  'use strict';
  const LIB = 'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js';
  const P = window.FCPDF = {};

  // Standard PDF fonts only cover WinAnsi: transliterate Cyrillic, map arrows, drop the rest
  const CYR = {'А':'A','Б':'B','В':'V','Г':'H','Ґ':'G','Д':'D','Е':'E','Є':'Ye','Ж':'Zh','З':'Z','И':'Y','І':'I','Ї':'Yi','Й':'Y','К':'K','Л':'L','М':'M','Н':'N','О':'O','П':'P','Р':'R','С':'S','Т':'T','У':'U','Ф':'F','Х':'Kh','Ц':'Ts','Ч':'Ch','Ш':'Sh','Щ':'Shch','Ь':'','Ю':'Yu','Я':'Ya','Ы':'Y','Э':'E','Ё':'Yo','Ъ':''};
  const T = s => String(s == null ? '' : s)
    .replace(/[Ѐ-ӿ]/g, ch => { const u = ch.toUpperCase(); const t = CYR[u]; if(t == null) return '?'; return ch === u ? t : t.toLowerCase(); })
    .replace(/[→⟶➔]/g, '>').replace(/[←]/g, '<').replace(/[≥]/g, '>=').replace(/[≤]/g, '<=').replace(/[   ]/g, ' ')
    .replace(/[^\x20-\x7E -ÿ€–—‘’“”•…·‰]/g, '');
  P.text = T;

  const C = { harbour:[10,64,39], teal:[30,107,60], amber:[144,194,71], steel:[94,110,117], ink:[18,35,42], line:[214,222,225], fog:[237,241,242], white:[255,255,255] };

  async function ensure(){ if(!window.PDFLib) await FC.loadScript(LIB); return window.PDFLib; }

  // A tiny layout engine: pages, cursor, wrapping
  async function newDoc(meta){
    const { PDFDocument, StandardFonts, rgb } = await ensure();
    const doc = await PDFDocument.create();
    doc.setTitle(T(meta.title)); doc.setAuthor(T(FC.brand)); doc.setCreator(T(FC.brand)); doc.setProducer(T(FC.brand));
    const f = { r: await doc.embedFont(StandardFonts.Helvetica), b: await doc.embedFont(StandardFonts.HelveticaBold) };
    const col = a => rgb(a[0]/255, a[1]/255, a[2]/255);
    const W = 595.28, H = 841.89, M = 46;
    const ctx = { doc, f, col, W, H, M, page:null, y:0, pages:[], meta };
    ctx.addPage = () => {
      const pg = doc.addPage([W, H]); ctx.page = pg; ctx.pages.push(pg);
      // header band
      pg.drawRectangle({ x:0, y:H-78, width:W, height:78, color:col(C.harbour) });
      pg.drawRectangle({ x:0, y:H-82, width:W, height:4, color:col(C.amber) });
      // official wordmark as vector paths: white letters, lime square
      const L = FC.LOGO, sc = 150 / L.w;
      pg.drawSvgPath(L.letters, { x: M, y: H - 30 + L.y0 * sc, scale: sc, color: col(C.white) });
      pg.drawSvgPath(L.square, { x: M, y: H - 30 + L.y0 * sc, scale: sc, color: col(C.amber) });
      pg.drawText(T('Cargo insurance indications, quotations & cover'), { x: M, y: H - 62, size: 7.5, font: f.r, color: rgb(.72, .85, .76) });
      const tt = T(meta.title).toUpperCase(), tw = f.b.widthOfTextAtSize(tt, 12);
      pg.drawText(tt, { x:W-M-tw, y:H-44, size:12, font:f.b, color:col(C.white) });
      if(meta.ref){ const rw = f.r.widthOfTextAtSize(T(meta.ref), 9); pg.drawText(T(meta.ref), { x:W-M-rw, y:H-58, size:9, font:f.r, color:rgb(.85,.92,.93) }); }
      ctx.y = H - 112;
      return pg;
    };
    ctx.need = h => { if(ctx.y - h < 70) ctx.addPage(); };
    ctx.wrap = (text, font, size, width) => {
      const out = [];
      String(T(text)).split('\n').forEach(par => {
        const words = par.split(/\s+/); let line = '';
        words.forEach(w => {
          const t = line ? line + ' ' + w : w;
          if(font.widthOfTextAtSize(t, size) <= width) line = t;
          else{
            if(line) out.push(line);
            // break very long words
            let ww = w; while(font.widthOfTextAtSize(ww, size) > width && ww.length > 1){ let k = ww.length; while(k > 1 && font.widthOfTextAtSize(ww.slice(0, k), size) > width) k--; out.push(ww.slice(0, k)); ww = ww.slice(k); }
            line = ww;
          }
        });
        out.push(line);
      });
      return out;
    };
    ctx.para = (text, o) => {
      o = o || {}; const size = o.size || 9.5, font = o.bold ? f.b : f.r, lh = size * 1.42, x = o.x || M, width = o.width || (W - 2*M);
      ctx.wrap(text, font, size, width).forEach(l => { ctx.need(lh); ctx.page.drawText(l, { x, y:ctx.y, size, font, color:col(o.color || C.ink) }); ctx.y -= lh; });
      ctx.y -= (o.after == null ? 4 : o.after);
    };
    ctx.heading = (text) => {
      ctx.need(34); ctx.y -= 6;
      ctx.page.drawText(T(text), { x:M, y:ctx.y, size:10.5, font:f.b, color:col(C.harbour) });
      ctx.y -= 7; ctx.page.drawRectangle({ x:M, y:ctx.y, width:W-2*M, height:.8, color:col(C.line) }); ctx.y -= 14;
    };
    // key/value rows in two columns of label + value
    ctx.kv = (rows, o) => {
      o = o || {}; const lw = o.labelWidth || 150, size = 9.5, lh = size * 1.42;
      rows.filter(r => r && r[1] != null && r[1] !== '').forEach(([k, v]) => {
        const lines = ctx.wrap(v, f.b, size, W - 2*M - lw);
        ctx.need(lines.length * lh + 2);
        ctx.page.drawText(T(k), { x:M, y:ctx.y, size, font:f.r, color:col(C.steel) });
        lines.forEach((l, i) => ctx.page.drawText(l, { x:M+lw, y:ctx.y - i*lh, size, font:f.b, color:col(C.ink) }));
        ctx.y -= lines.length * lh + 3;
      });
      ctx.y -= 4;
    };
    ctx.lane = (from, to, mode) => {
      ctx.need(70);
      const y = ctx.y - 26, pg = ctx.page;
      pg.drawText(T(from.iso), { x:M, y, size:26, font:f.b, color:col(C.harbour) });
      pg.drawText(T(from.place), { x:M, y:y-14, size:8.5, font:f.b, color:col(C.ink) });
      const tw = f.b.widthOfTextAtSize(T(to.iso), 26); pg.drawText(T(to.iso), { x:W-M-tw, y, size:26, font:f.b, color:col(C.harbour) });
      const pw = f.b.widthOfTextAtSize(T(to.place), 8.5); pg.drawText(T(to.place), { x:W-M-pw, y:y-14, size:8.5, font:f.b, color:col(C.ink) });
      const x1 = M + 70, x2 = W - M - 70, cy = y + 8;
      for(let x = x1; x < x2; x += 9) pg.drawRectangle({ x, y:cy, width:4.5, height:1.6, color:col(C.amber) });
      pg.drawCircle({ x:x1, y:cy+.8, size:3.5, color:col(C.amber) }); pg.drawCircle({ x:x2, y:cy+.8, size:3.5, color:col(C.amber) });
      const mw = f.b.widthOfTextAtSize(T(mode), 8.5) + 16, mx = (x1 + x2) / 2 - mw / 2;
      pg.drawRectangle({ x:mx, y:cy-7, width:mw, height:16, color:col(C.white), borderColor:col(C.amber), borderWidth:1.2 });
      pg.drawText(T(mode), { x:mx+8, y:cy-2.5, size:8.5, font:f.b, color:col(C.harbour) });
      ctx.y = y - 34;
    };
    ctx.box = (title, text, color) => {
      const lines = ctx.wrap(text, f.r, 9, W - 2*M - 24), h = 22 + lines.length * 12.6 + 8;
      ctx.need(h + 6);
      const top = ctx.y + 4;
      ctx.page.drawRectangle({ x:M, y:top-h, width:W-2*M, height:h, color:col(C.fog) });
      ctx.page.drawRectangle({ x:M, y:top-h, width:3, height:h, color:col(color || C.amber) });
      ctx.page.drawText(T(title), { x:M+12, y:top-15, size:9.5, font:f.b, color:col(C.ink) });
      lines.forEach((l, i) => ctx.page.drawText(l, { x:M+12, y:top-29-i*12.6, size:9, font:f.r, color:col(C.ink) }));
      ctx.y = top - h - 12;
    };
    ctx.table = (head, rows, widths, o) => {
      o = o || {}; const size = 9, lh = 13, x0 = M, totalW = W - 2*M;
      const ws = widths.map(w => w * totalW);
      const drawRow = (cells, bold, fill) => {
        const wrapped = cells.map((c, i) => ctx.wrap(c, bold ? f.b : f.r, size, ws[i] - 10));
        const h = Math.max(...wrapped.map(w => w.length)) * lh + 8;
        ctx.need(h);
        if(fill) ctx.page.drawRectangle({ x:x0, y:ctx.y - h + lh - 2, width:totalW, height:h, color:col(fill) });
        let x = x0;
        wrapped.forEach((lines, i) => {
          const right = o.right && o.right.includes(i);
          lines.forEach((l, k) => {
            const tw = (bold ? f.b : f.r).widthOfTextAtSize(l, size);
            ctx.page.drawText(l, { x: right ? x + ws[i] - 5 - tw : x + 5, y: ctx.y - k*lh, size, font: bold ? f.b : f.r, color:col(C.ink) });
          });
          x += ws[i];
        });
        ctx.y -= h;
        ctx.page.drawRectangle({ x:x0, y:ctx.y + lh - 4, width:totalW, height:.6, color:col(C.line) });
      };
      drawRow(head, true, C.fog);
      rows.forEach(r => Array.isArray(r) ? drawRow(r, false, null) : drawRow(r.cells, !!r.bold, r.fill || null));
      ctx.y -= 8;
    };
    ctx.finish = async (footer) => {
      const n = ctx.pages.length;
      ctx.pages.forEach((pg, i) => {
        pg.drawRectangle({ x:M, y:46, width:W-2*M, height:.6, color:col(C.line) });
        const lines = ctx.wrap(footer || '', f.r, 7, W - 2*M - 60);
        lines.slice(0, 3).forEach((l, k) => pg.drawText(l, { x:M, y:36 - k*9, size:7, font:f.r, color:col(C.steel) }));
        const pt = 'Page ' + (i+1) + ' of ' + n, pw = f.r.widthOfTextAtSize(pt, 7);
        pg.drawText(pt, { x:W-M-pw, y:36, size:7, font:f.r, color:col(C.steel) });
      });
      return doc.save();
    };
    ctx.addPage();
    return ctx;
  }

  const legal = () => (window.FREIGHTCON_LEGAL_LINE || FC.brand);
  const placeOf = (place, name) => [place, name].filter(Boolean).join(', ');

  // ---------------- indication ----------------
  P.indication = async (r) => {
    const ctx = await newDoc({ title:'Indication', ref: r.ref || '' });
    const conv = (FC.CONVEYANCE[r.conveyance] || {}).short || r.conveyance;
    ctx.para('Issued ' + FC.dateTime(r.issued_at || new Date()) + (r.company ? ' for ' + r.company : ''), { color:C.steel, size:9 });
    ctx.lane({ iso:r.origin_country, place: r.origin_place || r.origin_name || '' }, { iso:r.dest_country, place: r.dest_place || r.dest_name || '' }, conv);
    ctx.heading('Shipment');
    ctx.kv([
      ['Goods', r.goods_description], ['Cargo type', r.commodity_name], ['Packaging', r.packaging],
      ['Conveyance', conv], ['From', placeOf(r.origin_place, r.origin_name)], ['To', placeOf(r.dest_place, r.dest_name)],
      ['Departure', r.departure_date ? FC.date(r.departure_date) : 'Not stated'],
      ['Special', [r.on_deck ? 'Shipped on deck' : '', r.interest_only ? "Seller's / buyer's own interest only (contingency cover)" : ''].filter(Boolean).join(', ')],
      ['Vessel', /^sea_/.test(r.conveyance) ? (r.vessel || 'To be declared') : ''],
      ['Incoterm', r.incoterm ? r.incoterm + ' (' + ((FC.INCOTERMS[r.incoterm] || {}).name || '') + '), insured for the ' + (r.insured_party || 'seller') : '']
    ]);
    ctx.heading('Cover');
    const cov = FC.COVER[r.cover] || {};
    ctx.kv([
      ['Conditions', cov.clause + (r.war_strikes ? ', incl. Institute War and Strikes Clauses (Cargo)' : '')],
      ['Invoice value', FC.money2(r.invoice_value, r.currency)],
      ['Sum insured', FC.money2(r.sum_insured, r.currency) + ' (invoice value + ' + Number(r.uplift_pct) + ' %)'],
      ['Deductible', r.deductible_text || ''], ['Special conditions', r.conditions || '']
    ]);
    if(r.status === 'quoted'){
      ctx.heading('Indicative premium');
      const rows = [['Rate on sum insured', FC.pct(r.rate_pct)], ['Premium', FC.money2(r.premium_gross, r.currency)]];
      if(Number(r.discount_pct) > 0) rows.push(['Client discount', '- ' + Number(r.discount_pct) + ' %']);
      if(r.min_applied) rows.push(['Minimum premium applied', 'Yes']);
      rows.push(['Total premium (excl. insurance tax)', FC.money2(r.premium, r.currency)]);
      ctx.kv(rows, { labelWidth: 200 });
      ctx.box('This is an indication, not an offer of cover', 'The figures are non-binding and based on the details above. Cover is only in place once a quotation has been accepted and confirmed in writing. Insurance tax is added where applicable.' + (/^sea_/.test(r.conveyance) ? ' Sea transport is subject to the Institute Classification Clause; older or unclassed vessels may carry an additional premium.' : ''), C.teal);
    }else if(r.status === 'on_request'){
      ctx.box('Quoted individually', 'This shipment cannot be priced automatically: ' + (r.reasons || []).join('; ') + '. Please request a quotation, we come back to you promptly.', [224,160,48]);
    }else{
      ctx.box('Compliance review required', (r.reasons || []).join('; ') + '. No indication can be given. Please contact us.', [178,59,50]);
    }
    return ctx.finish(legal() + '. Indications are non-binding and confidential. Not an insurance certificate.');
  };

  // ---------------- quotation ----------------
  P.quotation = async (q, ind) => {
    const d = q.data || {};
    const ctx = await newDoc({ title:'Quotation', ref: (ind && ind.ref ? ind.ref : '') + (q.version > 1 ? ' / v' + q.version : '') });
    ctx.para('Issued ' + FC.dateTime(d.issuedAt || q.created_at) + '  —  valid until ' + FC.dateTime(q.valid_until || d.validUntil), { color:C.steel, size:9 });
    const conv = (FC.CONVEYANCE[d.conveyance] || {}).short || d.conveyance || '';
    ctx.lane({ iso:d.originCountry || '', place:d.originPlace || '' }, { iso:d.destCountry || '', place:d.destPlace || '' }, conv);
    ctx.heading('Assured & shipment');
    ctx.kv([
      ['Assured', d.client], ['Address', d.clientAddress], ['Co-assured', (d.coAssured || []).join(', ')], ['Goods', d.goods], ['Packaging', d.packaging],
      ['Conveyance', conv + (d.vessel ? ', ' + d.vessel : '')], ['Voyage', d.voyage], ['Period', d.period], ['Incoterm', d.incoterm]
    ]);
    ctx.heading('Cover');
    ctx.kv([['Conditions', d.conditions], ['Insurer', d.insurer], ['Deductible', d.deductible], ['Special conditions', d.special]]);
    ctx.heading('Premium');
    const rows = (d.lines || []).map(l => [l.label, FC.money2(l.sum, d.currency), FC.pct(l.rate), FC.money2(l.premium, d.currency)]);
    if(Number(d.discountPct) > 0) rows.push(['Client discount', '', '- ' + Number(d.discountPct) + ' %', '- ' + FC.money2(d.discountAmount, d.currency)]);
    if(d.minApplied) rows.push(['Minimum premium applied', '', '', '']);
    if(Number(d.taxPct) > 0) rows.push(['Insurance tax ' + Number(d.taxPct) + ' %', '', '', FC.money2(d.tax, d.currency)]);
    rows.push({ cells:['Total premium payable', '', '', FC.money2(d.total, d.currency)], bold:true, fill:[144,194,71] });
    ctx.table(['Cover', 'Sum insured', 'Rate', 'Premium'], rows, [.44, .2, .14, .22], { right:[1,2,3] });
    if((d.subjectivities || []).length){ ctx.heading('Subject to'); d.subjectivities.forEach(s => ctx.para('•  ' + s, { size:9, after:1 })); ctx.y -= 4; }
    if(d.note){ ctx.heading('Notes'); ctx.para(d.note); }
    if(d.closing){ ctx.box('How to accept', d.closing, C.teal); }
    if(d.handler && (d.handler.name || d.handler.email)) ctx.para('Your contact: ' + [d.handler.name, d.handler.email].filter(Boolean).join(', '), { size:9, color:C.steel });
    return ctx.finish(legal() + '. This quotation is confidential and valid until the time stated. Cover attaches only after written confirmation.');
  };

  // ---------------- cover note / certificate ----------------
  P.coverNote = async (cn, ind) => {
    const d = cn.data || {};
    const ctx = await newDoc({ title:'Cover note', ref: cn.number || d.number || '' });
    ctx.para('Issued ' + FC.dateTime(cn.issued_at || d.issuedAt) + (ind && ind.ref ? '  —  reference ' + ind.ref : ''), { color:C.steel, size:9 });
    const conv = (FC.CONVEYANCE[d.conveyance] || {}).short || d.conveyance || '';
    ctx.lane({ iso:d.originCountry || '', place:d.originPlace || '' }, { iso:d.destCountry || '', place:d.destPlace || '' }, conv);
    ctx.para('We confirm that insurance has been effected as follows:', { bold:true });
    ctx.heading('Insurance');
    ctx.kv([
      ['Assured', d.client], ['Address', d.clientAddress], ['Co-assured', (d.coAssured || []).join(', ')], ['Insurer(s)', d.insurer], ['Policy / certificate no.', d.policyNo]
    ]);
    ctx.heading('Shipment');
    ctx.kv([
      ['Goods', d.goods], ['Packaging', d.packaging], ['Marks & numbers', d.marks], ['Conveyance', conv + (d.vessel ? ', ' + d.vessel : '')],
      ['Bill of lading / AWB / CMR', d.transportDoc], ['Voyage', d.voyage], ['Sailing / departure', d.departure], ['Period', d.period]
    ]);
    ctx.heading('Cover');
    ctx.kv([
      ['Sum insured', FC.money2(d.sumInsured, d.currency)], ['Conditions', d.conditions], ['Deductible', d.deductible],
      ['Special conditions', d.special], ['Premium', d.total != null ? FC.money2(d.total, d.currency) : '']
    ]);
    if(d.claims){ ctx.box('In case of loss or damage', d.claims, C.teal); }
    if(d.note) ctx.para(d.note, { size:9 });
    return ctx.finish(legal() + '. This cover note is issued as evidence of insurance; terms as per the policy wording. Not negotiable unless stated.');
  };

  P.fileName = (kind, ref, extra) => [kind, ref, extra].filter(Boolean).join('_').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/_+/g, '_') + '.pdf';
})();
