/* FREIGHTCON - universal list export (.xlsx / .pdf)
   window.FREIGHTCONExport (alias FCX)
     FCX.exportList(spec, 'xlsx' | 'pdf')   spec = { title, filename, columns, rows, filters, staff }
       columns: [{ label, get: row => value, type: 'text' | 'number' | 'money' | 'pct' | 'date' | 'datetime', internal: true (staff only), width }]
       rows:    the CURRENT (filtered and sorted) rows of the list
       filters: array of strings or one string, e.g. ['Client = Bertling', 'Status = Open']
     FCX.bar(host, () => spec)               adds [Export .xlsx] [Export .pdf] to a toolbar
     FCX.fromTable(table, { title, filters, skip }) builds a spec from a rendered table (what the user sees)
   Excel: SheetJS with styles (assets/vendor/xlsx-style.bundle.js), bold navy header, frozen header row,
          auto widths, #,##0.00 and DD.MM.YYYY formats.
   PDF:   jsPDF + AutoTable (assets/vendor), MARINCON logo and header, filter line, repeating table head,
          "Page X of Y"; landscape for wide lists.
   Every text goes through the dash sanitizer (ASCII hyphen only). Columns marked internal are dropped
   for non-staff users (Chinese Wall). */
(function(){
  'use strict';
  const V = (window.FC && FC.VERSION) ? '?v=' + FC.VERSION : '';
  const LIBS = { xlsx: 'assets/vendor/xlsx-style.bundle.js' + V, jspdf: 'assets/vendor/jspdf.umd.min.js' + V, autotable: 'assets/vendor/jspdf.plugin.autotable.min.js' + V };
  const LOGO_URLS = [window.MARINCON_LOGO_URL || 'assets/brand/marincon-logo.png', 'https://marincon.net/wp-content/uploads/2018/05/marincon-marine-insurance-brokers-hamburg-logo.png'];
  const NAVY = '003A79', BLUE = '009FE3';

  const load = src => (window.FC && FC.loadScript) ? FC.loadScript(src) : new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  const dash = s => String(s == null ? '' : s).replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-');
  // the PDF standard font speaks Latin-1 only
  const latin = s => dash(s).replace(/[\u2192\u2794\u27F6]/g, '->').replace(/\u2190/g, '<-').replace(/\u2026/g, '...').replace(/[\u201C\u201D\u201E]/g, '"').replace(/[\u2018\u2019\u201A]/g, "'")
    .replace(/\u2030/g, ' permille').replace(/\u2264/g, '<=').replace(/\u2265/g, '>=').replace(/\u00D7/g, 'x').replace(/[\u2022\u25CF]/g, '·').replace(/[^\x00-\xFF]/g, '');
  const pad = n => String(n).padStart(2, '0');
  const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const fileStamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  const safeName = s => dash(s || 'FREIGHTCON_export').replace(/[^\w.-]+/g, '_').replace(/_+/g, '_').slice(0, 80);
  const toDate = v => { if(v == null || v === '') return null; if(v instanceof Date) return isNaN(v) ? null : v; const s = String(v);
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s); if(m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const d = new Date(s); return isNaN(d) ? null : d; };
  const toNum = v => { if(v == null || v === '') return null; if(typeof v === 'number') return isFinite(v) ? v : null;
    const s = String(v).replace(/[^\d.,-]/g, ''); if(!s || !/\d/.test(s)) return null; const n = Number(s.replace(/,/g, '')); return isFinite(n) ? n : null; };
  const fmtNum = (n, dec = 2) => Number(n).toLocaleString('en-GB', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  const fmtDate = d => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;

  const isStaff = spec => spec.staff != null ? !!spec.staff : !!(window.FC && FC.isStaffView);
  const cols = spec => (spec.columns || []).filter(c => !c.internal || isStaff(spec));
  const valueOf = (c, r) => { try{ return typeof c.get === 'function' ? c.get(r) : r[c.key]; }catch(e){ return null; } };
  const filterLine = spec => { const f = Array.isArray(spec.filters) ? spec.filters.filter(Boolean) : spec.filters ? [spec.filters] : [];
    return dash((f.length ? 'Filtered by: ' + f.join(' | ') + ' | ' : 'All records | ') + 'Exported: ' + stamp()); };

  // ---------------------------------------------------------------- .xlsx
  async function toXlsx(spec){
    if(!window.XLSX || !window.XLSX.style_version) await load(LIBS.xlsx);
    const X = window.XLSX, C = cols(spec), rows = spec.rows || [];
    const head = { font:{ bold:true, color:{ rgb:'FFFFFF' }, name:'Calibri', sz:11 }, fill:{ patternType:'solid', fgColor:{ rgb:NAVY } }, alignment:{ vertical:'center', wrapText:true },
      border:{ bottom:{ style:'thin', color:{ rgb:BLUE } } } };
    const aoa = [[dash(spec.title || 'FREIGHTCON export')], [filterLine(spec)], [], C.map(c => dash(c.label))];
    const body = rows.map(r => C.map(c => {
      const v = valueOf(c, r);
      if(['number','money','pct'].includes(c.type)){ const n = toNum(v); return n == null ? '' : n; }
      if(c.type === 'date' || c.type === 'datetime'){ const d = toDate(v); return d || ''; }
      return dash(Array.isArray(v) ? v.join(', ') : v == null ? '' : v);
    }));
    const ws = X.utils.aoa_to_sheet(aoa.concat(body), { cellDates:true });
    const HR = 3;   // header row index (0-based)
    ws.A1.s = { font:{ bold:true, sz:14, color:{ rgb:NAVY }, name:'Calibri' } };
    if(ws.A2) ws.A2.s = { font:{ italic:true, sz:9, color:{ rgb:'5E6E75' }, name:'Calibri' } };
    C.forEach((c, j) => {
      const h = X.utils.encode_cell({ r:HR, c:j }); if(ws[h]) ws[h].s = head;
      for(let i = 0; i < body.length; i++){ const a = X.utils.encode_cell({ r:HR + 1 + i, c:j }), cell = ws[a]; if(!cell) continue;
        if(c.type === 'number') cell.z = '#,##0.00'; else if(c.type === 'money') cell.z = '#,##0.00'; else if(c.type === 'pct') cell.z = '0.00';
        else if(c.type === 'date' && cell.t === 'd') cell.z = 'DD.MM.YYYY'; else if(c.type === 'datetime' && cell.t === 'd') cell.z = 'DD.MM.YYYY HH:MM';
        cell.s = Object.assign({ font:{ name:'Calibri', sz:10 }, alignment:{ vertical:'top', wrapText: c.type === 'text' || !c.type } }, i % 2 ? { fill:{ patternType:'solid', fgColor:{ rgb:'F3F6F8' } } } : {}); }
    });
    // auto-fitted widths
    ws['!cols'] = C.map((c, j) => { let w = String(c.label).length;
      body.forEach(r => { const v = r[j]; const l = v instanceof Date ? 10 : typeof v === 'number' ? fmtNum(v).length : String(v).split('\n').reduce((a, x) => Math.max(a, x.length), 0); if(l > w) w = l; });
      return { wch: Math.min(c.width || 60, Math.max(8, w + 2)) }; });
    ws['!merges'] = [{ s:{ r:0, c:0 }, e:{ r:0, c:Math.max(0, C.length - 1) } }, { s:{ r:1, c:0 }, e:{ r:1, c:Math.max(0, C.length - 1) } }];
    if(body.length) ws['!autofilter'] = { ref: X.utils.encode_range({ s:{ r:HR, c:0 }, e:{ r:HR + body.length, c:Math.max(0, C.length - 1) } }) };
    const wb = X.utils.book_new(); X.utils.book_append_sheet(wb, ws, dash(spec.sheet || 'List').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31));
    wb.Props = { Title: dash(spec.title || ''), Author: 'MARINCON GmbH & Co. KG', Company: 'MARINCON GmbH & Co. KG' };
    let out = X.write(wb, { type:'array', bookType:'xlsx', compression:true });
    // frozen header row: SheetJS community writes no panes, so the sheet XML gets one
    try{
      const z = X.CFB.read(new Uint8Array(out), { type:'array' }), k = z.FullPaths.findIndex(p => /xl\/worksheets\/sheet1\.xml$/.test(p));
      if(k >= 0){ const f = z.FileIndex[k]; let xml = new TextDecoder().decode(f.content);
        const pane = `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${HR + 1}" topLeftCell="A${HR + 2}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${HR + 2}" sqref="A${HR + 2}"/></sheetView></sheetViews>`;
        xml = /<sheetViews>[\s\S]*?<\/sheetViews>/.test(xml) ? xml.replace(/<sheetViews>[\s\S]*?<\/sheetViews>/, pane) : xml.replace(/(<dimension[^>]*\/>)/, '$1' + pane);
        f.content = new TextEncoder().encode(xml); f.size = f.content.length;
        out = X.CFB.write(z, { fileType:'zip', type:'array' }); }
    }catch(e){ console.warn('freeze pane skipped', e); }
    return new Blob([out instanceof ArrayBuffer ? out : new Uint8Array(out)], { type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  // ---------------------------------------------------------------- .pdf
  let LOGO = null;
  async function logo(){
    if(LOGO !== null) return LOGO;
    LOGO = false;
    for(const u of LOGO_URLS){
      try{ const r = await fetch(u, { mode:'cors' }); if(!r.ok) continue; const b = await r.blob(); if(b.size < 60) continue;
        const url = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(b); });
        const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
        LOGO = { url, w: img.naturalWidth, h: img.naturalHeight, type: /png/i.test(b.type) || /\.png/i.test(u) ? 'PNG' : 'JPEG' }; break; }catch(e){ /* next */ }
    }
    return LOGO;
  }
  async function toPdf(spec){
    if(!window.jspdf) await load(LIBS.jspdf);
    if(!window.jspdf.jsPDF.API.autoTable) await load(LIBS.autotable);
    const C = cols(spec), rows = spec.rows || [];
    const land = spec.orientation ? spec.orientation === 'landscape' : C.length > 6;
    const doc = new window.jspdf.jsPDF({ orientation: land ? 'landscape' : 'portrait', unit:'pt', format:'a4', compress:true });
    const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 36;
    const lg = await logo();
    const title = latin(spec.title || 'FREIGHTCON export'), fl = latin(filterLine(spec));
    const header = () => {
      if(lg){ const h = 26, w = Math.min(170, lg.w * h / lg.h); try{ doc.addImage(lg.url, lg.type, M, 18, w, w * lg.h / lg.w); }catch(e){ doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.setTextColor(0, 58, 121); doc.text('MARINCON', M, 36); } }
      else { doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.setTextColor(0, 58, 121); doc.text('MARINCON', M, 36); }
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(94, 110, 117);
      doc.text('MARINCON GmbH & Co. KG · Marine Insurance Brokers · Hamburg', W - M, 28, { align:'right' });
      doc.setDrawColor(0, 58, 121); doc.setLineWidth(1.2); doc.line(M, 52, W - M, 52);
      doc.setDrawColor(0, 159, 227); doc.setLineWidth(0.6); doc.line(M, 54.5, W - M, 54.5);
    };
    const cell = (c, r) => { const v = valueOf(c, r);
      if(['number','money'].includes(c.type)){ const n = toNum(v); return n == null ? '' : fmtNum(n); }
      if(c.type === 'pct'){ const n = toNum(v); return n == null ? '' : fmtNum(n) + ' %'; }
      if(c.type === 'date'){ const d = toDate(v); return d ? fmtDate(d) : ''; }
      if(c.type === 'datetime'){ const d = toDate(v); return d ? fmtDate(d) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) : ''; }
      return latin(Array.isArray(v) ? v.join(', ') : v == null ? '' : v); };
    header();
    doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.setTextColor(18, 35, 42); doc.text(title, M, 76);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(94, 110, 117);
    const fls = doc.splitTextToSize(fl + ' | ' + rows.length + ' record' + (rows.length === 1 ? '' : 's'), W - 2 * M); doc.text(fls, M, 90);
    const startY = 92 + fls.length * 10;
    doc.autoTable({
      startY, margin:{ left:M, right:M, top:66, bottom:40 },
      head:[C.map(c => latin(c.label))], body: rows.map(r => C.map(c => cell(c, r))),
      styles:{ font:'helvetica', fontSize: C.length > 10 ? 6.5 : C.length > 7 ? 7.5 : 8.5, cellPadding:3, overflow:'linebreak', textColor:[18, 35, 42], lineColor:[220, 228, 232], lineWidth:0.3 },
      headStyles:{ fillColor:[0, 58, 121], textColor:255, fontStyle:'bold' },
      alternateRowStyles:{ fillColor:[243, 246, 248] },
      columnStyles: Object.fromEntries(C.map((c, j) => [j, ['number','money','pct'].includes(c.type) ? { halign:'right' } : {}])),
      showHead:'everyPage', rowPageBreak:'avoid',
      didDrawPage: data => { if(data.pageNumber > 1) header(); }
    });
    // page numbers and footer
    const n = doc.internal.getNumberOfPages();
    for(let i = 1; i <= n; i++){ doc.setPage(i); doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(94, 110, 117);
      doc.text(latin(title) + ' · exported ' + stamp(), M, H - 20); doc.text('Page ' + i + ' of ' + n, W - M, H - 20, { align:'right' }); }
    return doc.output('blob');
  }

  // ---------------------------------------------------------------- public
  const save = (blob, name) => { if(window.FC && FC.saveBlob) return FC.saveBlob(blob, name, blob.type);
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500); };
  async function exportList(spec, format){
    const blob = format === 'pdf' ? await toPdf(spec) : await toXlsx(spec);
    const name = safeName(spec.filename || spec.title) + '_' + fileStamp() + (format === 'pdf' ? '.pdf' : '.xlsx');
    save(blob, name);
    return { name, blob };
  }
  function bar(host, specFn, opt){
    opt = opt || {};
    const wrap = document.createElement('span'); wrap.className = 'fcx-bar'; wrap.setAttribute('role', 'group'); wrap.setAttribute('aria-label', 'Export');
    [['xlsx', 'Export .xlsx'], ['pdf', 'Export .pdf']].forEach(([f, l]) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn-ghost btn-sm fcx-' + f; b.textContent = l;
      b.addEventListener('click', async () => {
        if(b.disabled) return; b.disabled = true; const t = b.textContent; b.textContent = 'Exporting...';
        try{ const spec = await specFn(); if(!spec || !(spec.rows || []).length){ (window.FC && FC.toast ? FC.toast : alert)('Nothing to export - the list is empty.', 'error'); return; }
          await exportList(spec, f); }
        catch(e){ console.error(e); (window.FC && FC.toast ? FC.toast : alert)('Export failed: ' + (e.message || e), 'error'); }
        finally{ b.disabled = false; b.textContent = t; }
      });
      wrap.appendChild(b);
    });
    if(opt.prepend && host.firstChild) host.insertBefore(wrap, host.firstChild); else host.appendChild(wrap);
    return wrap;
  }
  // a rendered table as it is shown (only what the user can see; action columns skipped)
  function fromTable(table, o){
    o = o || {};
    if(!table) return null;
    const ths = Array.from(table.querySelectorAll('thead th'));
    const keep = ths.map((th, j) => ({ j, label: (th.innerText || th.textContent || '').trim() })).filter(x => x.label && !(o.skip || []).includes(x.label) && !/^(select|actions?)$/i.test(x.label));
    const rows = Array.from(table.querySelectorAll('tbody tr')).filter(tr => !tr.hidden && tr.offsetParent !== null && !tr.classList.contains('empty')).map(tr => {
      const tds = Array.from(tr.children); return keep.map(k => { const td = tds[k.j]; if(!td) return '';
        // form cells (editable tables): their current values
        const live = Array.from(td.querySelectorAll('input, select, textarea')).filter(x => x.type !== 'hidden' && !x.classList.contains('sl-row'));
        if(live.length) return live.map(x => x.type === 'checkbox' ? (x.checked ? 'Yes' : 'No') : x.tagName === 'SELECT' ? ((x.selectedOptions[0] || {}).textContent || '') : x.value).join(' / ').trim();
        const c = td.cloneNode(true); c.querySelectorAll('button.kebab, .kebab, input[type=checkbox], .sr-only').forEach(x => x.remove());
        return (c.innerText || c.textContent || '').replace(/\s*\n\s*/g, ' / ').replace(/\s+/g, ' ').trim(); }); });
    const typeOf = j => { const vs = rows.map(r => r[j]).filter(Boolean); if(!vs.length) return 'text';
      if(vs.every(v => /^\d{2}\.\d{2}\.\d{4}$/.test(v) || /^\d{4}-\d{2}-\d{2}$/.test(v))) return 'date';
      if(vs.every(v => /^-?[\d,]+(\.\d+)?$/.test(v))) return 'number';
      return 'text'; };
    return { title: o.title, filename: o.filename, filters: o.filters, staff: o.staff, rows,
      columns: keep.map((k, i) => ({ label: k.label, get: r => r[i], type: typeOf(i) })) };
  }
  const FCX = { exportList, bar, fromTable, toXlsx, toPdf, dash, stamp };
  window.FREIGHTCONExport = FCX; window.FCX = FCX;
})();
