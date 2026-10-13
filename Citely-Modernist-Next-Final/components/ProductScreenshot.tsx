import { asset } from '@/config';

/** A product screenshot in light and dark (CSS shows the one matching the
 *  theme). Shown as a WebP copy; selecting it opens the full-size JPG.
 *  `priority` is for a screenshot at the top of the page: it is fetched
 *  straight away instead of when scrolled near. */
export function ProductScreenshot({name, alt, caption, priority = false}: {name:string; alt:string; caption:string; priority?:boolean}) {
  return (
    <figure className="product-screenshot">
      {(['light', 'dark'] as const).map(theme => (
        <a key={theme} className={`product-screenshot-${theme}`} href={asset(`/screenshots/${name}-${theme}.jpg`)} target="_blank" rel="noreferrer" aria-label={`${caption} — open full-size screenshot`}>
          <img src={asset(`/screenshots/web/${name}-${theme}.webp`)} alt={alt} width={1600} height={1000}
            loading={priority ? 'eager' : 'lazy'} fetchPriority={priority ? 'high' : undefined} decoding="async" />
        </a>
      ))}
      <figcaption><span>{caption}</span><small>Sample documents · Select image to enlarge ↗</small></figcaption>
    </figure>
  );
}
