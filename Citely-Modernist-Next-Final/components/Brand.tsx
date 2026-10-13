import { asset } from "@/lib/config";

/** Approved Source Point assets; CSS chooses the variant before hydration. */
export function Brand({ decorative = false }: { decorative?: boolean }) {
  return <span className="source-point" role={decorative ? undefined : "img"} aria-label={decorative ? undefined : "Citely"} aria-hidden={decorative || undefined}>
    <img className="source-point-light" src={asset('/branding/citely-02-evidence-accent.svg')} width="674" height="256" alt="" />
    <img className="source-point-dark" src={asset('/branding/citely-03-night.svg')} width="674" height="256" alt="" />
  </span>;
}
export function BrandIcon() {
  return <img className="source-point-icon" src={asset('/branding/citely-04-app-tile.svg')} width="256" height="256" alt="" aria-hidden="true" />;
}
