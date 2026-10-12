// Turns an uploaded/forwarded file into something the AI can read:
//   Word (.docx) and Excel (.xlsx) → text extracted here (no AI cost for the reading part)
//   CSV / TXT / Markdown → text
//   PDF, photos (JPG/PNG/WebP/HEIC) and short videos → sent to the AI model as-is (it reads scanned
//   pages, handwriting and speech in video natively)
// Anything else is refused with a clear message.
const JSZip = require('jszip');
const ExcelJS = require('exceljs');

class UnsupportedFile extends Error { constructor(msg) { super(msg); this.code = 'UNSUPPORTED_FILE'; } }
const MAX_TEXT = 50000;
const ext = n => (String(n || '').toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
const decodeXml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

async function docxText(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const f = zip.file('word/document.xml');
  if (!f) throw new UnsupportedFile('That Word file could not be read.');
  const xml = await f.async('string');
  return decodeXml(xml.replace(/<w:tab\/>/g, '\t').replace(/<\/w:p>/g, '\n').replace(/<w:br\/>/g, '\n').replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
async function xlsxText(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const out = [];
  wb.eachSheet(ws => {
    out.push(`Sheet: ${ws.name}`);
    let n = 0;
    ws.eachRow({ includeEmpty: false }, row => {
      if (n++ > 500) return;
      const cells = (row.values || []).slice(1).map(v => v == null ? '' : (typeof v === 'object' ? (v.text || v.result || (v.richText ? v.richText.map(r => r.text).join('') : '') || (v instanceof Date ? v.toISOString().slice(0, 10) : '')) : String(v)));
      if (cells.some(c => String(c).trim())) out.push(cells.join(' | '));
    });
  });
  return out.join('\n');
}

// → { kind: 'text', text } or { kind: 'media', mime, contentType }
async function documentToInput(buffer, mime, name) {
  const e = ext(name);
  const m = String(mime || '').toLowerCase();
  if (e === 'docx' || m.includes('wordprocessingml')) return { kind: 'text', contentType: 'document', text: (await docxText(buffer)).slice(0, MAX_TEXT) };
  if (e === 'xlsx' || m.includes('spreadsheetml')) return { kind: 'text', contentType: 'document', text: (await xlsxText(buffer)).slice(0, MAX_TEXT) };
  if (['csv', 'txt', 'md'].includes(e) || m.startsWith('text/')) return { kind: 'text', contentType: 'document', text: buffer.toString('utf8').slice(0, MAX_TEXT) };
  if (e === 'pdf' || m === 'application/pdf') return { kind: 'media', mime: 'application/pdf', contentType: 'document' };
  if (m.startsWith('image/') || ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'].includes(e)) return { kind: 'media', mime: m.startsWith('image/') ? m : `image/${e === 'jpg' ? 'jpeg' : e}`, contentType: 'image' };
  if (m.startsWith('video/') || ['mp4', '3gp', 'mov', 'webm'].includes(e)) return { kind: 'media', mime: m.startsWith('video/') ? m : 'video/mp4', contentType: 'video' };
  if (e === 'doc' || e === 'xls') throw new UnsupportedFile('Old .doc/.xls files can\'t be read — save as .docx / .xlsx or PDF and try again.');
  throw new UnsupportedFile('This file type is not supported. Use PDF, Word (.docx), Excel (.xlsx), CSV, a photo or a short video.');
}
module.exports = { documentToInput, UnsupportedFile };
