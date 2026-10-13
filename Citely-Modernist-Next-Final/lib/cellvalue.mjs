// What a spreadsheet cell shows. SheetJS cell types: n number, s string,
// b boolean, d date, e error, z blank/stub.
//
// The TYPE decides the display — `v === 0` is never inspected. An uncalculated
// formula is a stub whose v is 0, while a formula that really evaluates to
// zero is a number whose v is 0; testing v would show one as the other.
export function displayCell(c) {
  if (!c) return { text: '', kind: 'empty' };
  if (c.t === 'z') {
    if (c.f) return { text: '—', kind: 'formula-uncalculated', title: `Formula =${c.f} has no saved result` };
    return { text: '', kind: 'blank' };
  }
  if (c.t === 'e') return { text: c.w ?? '#ERROR', kind: 'formula-error', title: c.f ? `Formula =${c.f} evaluated to ${c.w}` : undefined };
  const text = c.w !== undefined ? c.w : c.t === 'd' && c.v instanceof Date ? c.v.toISOString().slice(0, 10) : String(c.v);
  return { text, kind: c.f ? 'formula-cached' : 'literal' };
}
