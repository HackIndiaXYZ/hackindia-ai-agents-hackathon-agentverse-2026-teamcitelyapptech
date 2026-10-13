/** Offsets always index the exact page string; never trim or reconstruct it. */
export function validRange(text, start, end) {
  return typeof text === 'string' && Number.isInteger(start) && Number.isInteger(end)
    && start >= 0 && end > start && end <= text.length;
}
export function locatable(page, item) {
  item=browserCitation(page,item);
  return !!page && !!page.extraction_version && item.extraction_version === page.extraction_version
    && validRange(page.text, item.page_char_start, item.page_char_end)
    && (!item.quote || page.text.slice(item.page_char_start,item.page_char_end).replace(/\s+/g,' ').trim() === item.quote.replace(/\s+/g,' ').trim());
}
/** Old backend citations used code points; DOM selections already use UTF-16. */
export function browserCitation(page, item) {
  if (!page || item.offset_unit !== 'codepoint') return item;
  const points = Array.from(page.text), start=item.page_char_start, end=item.page_char_end;
  if (!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<=start||end>points.length) return {...item,page_char_start:null,page_char_end:null};
  return {...item,page_char_start:points.slice(0,start).join('').length,page_char_end:points.slice(0,end).join('').length,offset_unit:'utf16'};
}
export function uniqueCitations(citations) {
  const seen = new Set();
  return citations.filter(c => { if (seen.has(c.citation_id)) return false; seen.add(c.citation_id); return true; });
}
/** Partition at every boundary. Overlapping ranges share a segment, never duplicate text. */
export function segmentRanges(text, citations = [], annotations = []) {
  const cs = uniqueCitations(citations).filter(c => validRange(text,c.page_char_start,c.page_char_end));
  const as = annotations.filter(a => validRange(text,a.page_char_start,a.page_char_end));
  const points = [...new Set([0,text.length,...[...cs,...as].flatMap(c => [c.page_char_start,c.page_char_end])])].sort((a,b)=>a-b);
  return points.slice(0,-1).map((start,i) => {
    const end=points[i+1];
    const citationIds=cs.filter(c=>c.page_char_start<=start && c.page_char_end>=end).map(c=>c.citation_id).sort();
    const annotationIds=as.filter(a=>a.page_char_start<=start && a.page_char_end>=end).map(a=>a.id).sort();
    return {start,end,text:text.slice(start,end),citationIds,annotationIds,key:`${start}:${end}:${citationIds.join(',')}:${annotationIds.join(',')}`};
  });
}
const escape = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function renderRanges(page, citations, annotations, activeId) {
  const assigned=new Set();
  return segmentRanges(page.text,citations.map(c=>browserCitation(page,c)).filter(c=>locatable(page,c)),annotations.filter(a=>locatable(page,a))).map(s=>{
    if(!s.citationIds.length && !s.annotationIds.length)return escape(s.text);
    const active=s.citationIds.includes(activeId);
    const target=active && !assigned.has(activeId) ? ` id="citation-${escape(encodeURIComponent(activeId))}" tabindex="-1"` : '';
    if(active)assigned.add(activeId);
    return `<mark${target} class="${s.citationIds.length?'citation-range ':''}${active?'current-citation ':''}${s.annotationIds.length?'permanent-mark':''}" data-range-key="${escape(s.key)}" data-start="${s.start}" data-end="${s.end}" data-citation-ids="${escape(JSON.stringify(s.citationIds))}">${escape(s.text)}</mark>`;
  }).join('');
}
/** DOM Range endpoints work across spans, marks, and adjacent text nodes on ONE page. */
export function rangeToPageOffsets(container, range) {
  if (!container || !range || range.collapsed) return null;
  const pageOf=node=>(node.nodeType===1?node:node.parentElement)?.closest('[data-page-text]');
  if (pageOf(range.startContainer)!==container || pageOf(range.endContainer)!==container) return null;
  if (!container.contains(range.startContainer)||!container.contains(range.endContainer)) return null;
  const before=range.cloneRange();before.selectNodeContents(container);before.setEnd(range.startContainer,range.startOffset);
  const through=range.cloneRange();through.selectNodeContents(container);through.setEnd(range.endContainer,range.endOffset);
  const start=before.toString().length,end=through.toString().length,quote=range.toString();
  if(!validRange(container.textContent,start,end)||container.textContent.slice(start,end)!==quote)return null;
  return {start,end,quote};
}
export function annotationKey(a) {
  const anchor=a.anchor?(a.anchor.range??[a.anchor.shape_id,a.anchor.row,a.anchor.col,a.anchor.quote,a.anchor.offset??a.anchor.occurrence??0].join('|')):null;
  return JSON.stringify([a.document_id,a.page_number,a.page_char_start,a.page_char_end,a.extraction_version,anchor]);
}
/** Use text nodes, not HTML parsing: CRLF, nulls and literal markup stay exact. */
export function paintRanges(container, page, citations, annotations, activeId) {
  const fragment=container.ownerDocument.createDocumentFragment();
  let focused=false;
  for(const s of segmentRanges(page.text,citations.map(c=>browserCitation(page,c)).filter(c=>locatable(page,c)),annotations.filter(a=>locatable(page,a)))) {
    if(!s.citationIds.length&&!s.annotationIds.length){fragment.append(container.ownerDocument.createTextNode(s.text));continue;}
    const mark=container.ownerDocument.createElement('mark'),active=s.citationIds.includes(activeId);
    mark.className=[s.citationIds.length?'citation-range':'',active?'current-citation':'',s.annotationIds.length?'permanent-mark':''].filter(Boolean).join(' ');
    mark.dataset.rangeKey=s.key;mark.dataset.start=String(s.start);mark.dataset.end=String(s.end);mark.dataset.citationIds=JSON.stringify(s.citationIds);
    if(active&&!focused){mark.id='citation-'+encodeURIComponent(activeId);mark.tabIndex=-1;focused=true;}
    mark.textContent=s.text;fragment.append(mark);
  }
  container.replaceChildren(fragment);
}
