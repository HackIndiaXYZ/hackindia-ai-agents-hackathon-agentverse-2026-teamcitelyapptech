// Lazily loaded: only fetched when a DOCX original is opened, so the
// workspace's own bundle does not grow by the renderer.
import { renderAsync } from 'docx-preview';
import { collectText, locate, clearMarks, paintMarks, selectionAnchor } from '../lib/viewer-dom.mjs';
import { anchorFromRaw, locateOnPages } from '../lib/anchor.mjs';

export { collectText, locate, clearMarks, paintMarks, selectionAnchor, anchorFromRaw, locateOnPages };

/** Renders a .docx into a fresh element. Its CSS is scoped by docx-preview to
 *  `.docx` selectors and kept inside the element, so it cannot restyle Citely. */
export async function render(data: ArrayBuffer): Promise<HTMLElement> {
  const root = document.createElement('div');
  root.className = 'original-docx';
  await renderAsync(data, root, root, {
    inWrapper: true,
    breakPages: true,
    ignoreLastRenderedPageBreak: true,
    useBase64URL: true,            // images as data URLs: nothing to revoke later
    experimental: false,
  });
  // Word headings arrive as styled paragraphs; give assistive technology the
  // document outline they represent.
  root.querySelectorAll<HTMLElement>('p[class*="docx_heading"]').forEach(p => {
    const level = Number(/docx_heading(\d)/.exec(p.className)?.[1]);
    if (level >= 1 && level <= 6) { p.setAttribute('role', 'heading'); p.setAttribute('aria-level', String(level)); }
  });
  // Links from an untrusted document: never script, always a separate tab.
  root.querySelectorAll<HTMLAnchorElement>('a[href]').forEach(a => {
    const href = a.getAttribute('href') || '';
    if (/^\s*(javascript|data|vbscript):/i.test(href)) { a.removeAttribute('href'); return; }
    if (!href.startsWith('#')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  });
  return root;
}

/** One element per rendered page, for the page control. */
export const pages = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('section.docx')];

/** The first page for the file list. Later pages are dropped straight away so
 *  a long document costs one page of DOM, not all of them. */
export async function thumbnail(data: ArrayBuffer): Promise<{ element: HTMLElement; width: number; height: number }> {
  const root = document.createElement('div');
  root.className = 'original-docx thumb-docx';
  await renderAsync(data, root, root, { inWrapper: false, breakPages: true, ignoreLastRenderedPageBreak: true, useBase64URL: true, experimental: false });
  const pages = [...root.querySelectorAll<HTMLElement>('section.docx')];
  pages.slice(1).forEach(p => p.remove());
  root.querySelectorAll('a[href]').forEach(a => a.removeAttribute('href'));
  const first = pages[0];
  const width = parseFloat(first?.style.width || '') || 816;
  const height = parseFloat(first?.style.minHeight || first?.style.height || '') || 1056;
  return { element: root, width, height };
}
