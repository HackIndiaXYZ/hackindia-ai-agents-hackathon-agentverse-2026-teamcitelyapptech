// One deployment shape for Next metadata and both browser bundles.
export function deployment(env = process.env) {
  const path = (value = '') => {
    const normalized = value.trim().replace(/\/+$/, '');
    if (normalized && !/^\/(?:[A-Za-z0-9_-]+)(?:\/[A-Za-z0-9_-]+)*$/.test(normalized))
      throw new Error('BASE_PATH must be empty or an absolute path without query, dot segments or repeated slashes');
    return normalized;
  };
  const base = path(env.BASE_PATH ?? env.NEXT_PUBLIC_BASE_PATH);
  if (env.BASE_PATH !== undefined && env.NEXT_PUBLIC_BASE_PATH !== undefined && base !== path(env.NEXT_PUBLIC_BASE_PATH))
    throw new Error('BASE_PATH conflicts with NEXT_PUBLIC_BASE_PATH');
  const site = (raw) => {
    let url;
    try { url = new URL(raw); } catch { throw new Error('SITE_URL must be an absolute HTTP(S) URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new Error('SITE_URL must be HTTP(S), without credentials, query or fragment');
    if (path(url.pathname) !== base) throw new Error('SITE_URL pathname must match BASE_PATH');
    return url.origin + base;
  };
  const url = site(env.SITE_URL ?? env.NEXT_PUBLIC_SITE_URL ?? `https://citely.example${base}`);
  if (env.SITE_URL !== undefined && env.NEXT_PUBLIC_SITE_URL !== undefined && url !== site(env.NEXT_PUBLIC_SITE_URL))
    throw new Error('SITE_URL conflicts with NEXT_PUBLIC_SITE_URL');
  if (env.NEXT_PUBLIC_NOINDEX !== undefined && !['true', 'false'].includes(env.NEXT_PUBLIC_NOINDEX))
    throw new Error('NEXT_PUBLIC_NOINDEX must be true or false');
  if (base && env.NEXT_PUBLIC_NOINDEX === 'false') throw new Error('Non-root deployments must remain noindex');
  return { BASE_PATH: base, SITE_URL: url, NOINDEX: !!base || env.NEXT_PUBLIC_NOINDEX === 'true' };
}
export const { BASE_PATH, SITE_URL, NOINDEX } = deployment();
