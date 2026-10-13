// The boxes to draw for a highlighted passage, one per line.
//
// A DOM Range's getClientRects() returns a box for every inline element it
// crosses, so nested spans give overlapping boxes for the same words. Drawn
// as translucent overlays they stack and turn dark. Boxes on the same line
// are merged into one (touching or overlapping), so every point of the
// passage is covered exactly once.

/** @param {{left:number, top:number, width:number, height:number}[]} rects */
export function mergeLineRects(rects, gap = 2) {
  const boxes = rects.filter(r => r.width > 0.5 && r.height > 0.5)
    .map(r => ({ left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height }))
    .sort((a, b) => a.top - b.top || a.left - b.left);
  const lines = [];
  for (const b of boxes) {
    // Same line: the boxes overlap vertically by at least half the smaller height.
    const line = lines.find(l => Math.min(l.bottom, b.bottom) - Math.max(l.top, b.top) >= Math.min(l.bottom - l.top, b.bottom - b.top) / 2);
    if (line) { line.items.push(b); line.top = Math.min(line.top, b.top); line.bottom = Math.max(line.bottom, b.bottom); }
    else lines.push({ top: b.top, bottom: b.bottom, items: [b] });
  }
  const out = [];
  for (const line of lines) {
    let current = null;
    for (const b of line.items.sort((x, y) => x.left - y.left)) {
      if (current && b.left <= current.right + gap) current.right = Math.max(current.right, b.right);
      else { current = { left: b.left, right: b.right, top: line.top, bottom: line.bottom }; out.push(current); }
    }
  }
  return out.map(b => ({ left: b.left, top: b.top, width: b.right - b.left, height: b.bottom - b.top }));
}
