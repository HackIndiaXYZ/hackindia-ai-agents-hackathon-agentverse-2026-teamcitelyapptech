import {expect, Locator, Page} from '@playwright/test';

/** The blue flash is an inset box-shadow; visible while its colour has alpha. */
export const flashVisible = (el: Locator) => el.evaluate(e => /rgba\(78, 137, 232, 0\.2\d+\)/.test(getComputedStyle(e).boxShadow));

/** A clicked citation shows its blue flash, then it is gone (FLASH_MS = 3.5 s). */
export async function expectFlashThenGone(el: Locator) {
  await expect.poll(() => flashVisible(el)).toBe(true);
  await expect.poll(() => flashVisible(el), {timeout: 6000, intervals: [500]}).toBe(false);
}

/** No highlight draws a border, outline or blend. `plain` is an
 *  unhighlighted element of the same kind (a grid cell has its own border);
 *  highlighted ones must draw exactly the same border as it. */
export async function expectNoBorders(page: Page, selector: string, plain?: string) {
  const read = (e: Element) => { const s = getComputedStyle(e); return {outline: s.outlineStyle, blend: s.mixBlendMode, border: s.borderTopStyle + ' ' + s.borderTopColor, underline: /0px 2px 0px/.test(s.boxShadow)}; };
  const base = plain ? await page.locator(plain).first().evaluate(read) : {border: 'none rgb(0, 0, 0)'};
  const styles = await page.locator(selector).evaluateAll((els, src) => els.map(e => (new Function('e', 'return (' + src + ')(e)'))(e)), read.toString());
  expect(styles.length).toBeGreaterThan(0);
  for (const s of styles) {
    expect({outline: s.outline, blend: s.blend, underline: s.underline}).toEqual({outline: 'none', blend: 'normal', underline: false});
    if (plain) expect(s.border).toBe(base.border); else expect(s.border.startsWith('none')).toBe(true);
  }
}
