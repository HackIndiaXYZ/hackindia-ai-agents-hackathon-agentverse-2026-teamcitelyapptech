import { asset } from '@/config';

export const POSTERS = [
  {id:'Citely-D1-Intro',day:'Day 1',step:'Introduction',title:'Your documents. Answers you can trace.'},
  {id:'Citely-D2-1-Problem',day:'Day 2',step:'Problem',title:'An upload is only the beginning.'},
  {id:'Citely-D2-2-Mechanism',day:'Day 2',step:'Mechanism',title:'Split the content. Keep its address.'},
  {id:'Citely-D2-3-Takeaway',day:'Day 2',step:'Takeaway',title:'The way back starts at upload.'},
  {id:'Citely-D3-1-Problem',day:'Day 3',step:'Problem',title:'A question needs context.'},
  {id:'Citely-D3-2-Mechanism',day:'Day 3',step:'Mechanism',title:'Retrieve. Then generate.'},
  {id:'Citely-D3-3-Takeaway',day:'Day 3',step:'Takeaway',title:'Every component has a job.'},
  {id:'Citely-D4-1-Problem',day:'Day 4',step:'Problem',title:'Page 4 still leaves you searching.'},
  {id:'Citely-D4-2-Mechanism',day:'Day 4',step:'Mechanism',title:'From answer to exact passage.'},
  {id:'Citely-D4-3-Takeaway',day:'Day 4',step:'Takeaway',title:'If the match is unclear, don’t guess.'},
  {id:'Citely-D5-1-Problem',day:'Day 5',step:'Problem',title:'A spreadsheet is more than text.'},
  {id:'Citely-D5-2-Mechanism',day:'Day 5',step:'Mechanism',title:'Different formats. Different source locations.'},
  {id:'Citely-D5-3-Takeaway',day:'Day 5',step:'Takeaway',title:'Keep the structure. Keep the context.'},
  {id:'Citely-D6-1-Problem',day:'Day 6',step:'Problem',title:'Your thinking shouldn’t disappear on refresh.'},
  {id:'Citely-D6-2-Mechanism',day:'Day 6',step:'Mechanism',title:'Save the highlight and its location.'},
  {id:'Citely-D6-3-Takeaway',day:'Day 6',step:'Takeaway',title:'Edits need history.'},
] as const;

export function PosterSeries({ids,heading=true}:{ids?:string[];heading?:boolean}){
  const posters=ids?POSTERS.filter(poster=>ids.includes(poster.id)):POSTERS;
  return <section className="poster-series" aria-labelledby={heading?'poster-series-title':undefined}>
    {heading&&<div className="poster-series-heading"><div><span className="tiny-label">BUILDING IN PUBLIC / THE COMPLETE SERIES</span><h2 id="poster-series-title">See how Citely fits together.</h2></div><p>Six chapters move from upload to durable notes. Every poster shows one problem, mechanism or takeaway.</p></div>}
    <div className={`poster-grid ${posters.length<3?'compact':''}`}>{posters.map(poster=><figure className="poster-card" key={poster.id}>
      <a href={asset(`/posters/building-in-public/${poster.id}.png`)} target="_blank" rel="noreferrer" aria-label={`Open full-size poster: ${poster.title}`}>
        <img src={asset(`/posters/building-in-public/web/${poster.id}.webp`)} alt={`${poster.title} — ${poster.day} ${poster.step} poster from Citely’s Building in Public series.`} width="1080" height="1350" loading="lazy" decoding="async"/>
      </a>
      <figcaption><span>{poster.day} / {poster.step}</span><strong>{poster.title}</strong><small>Open full-size poster ↗</small></figcaption>
    </figure>)}</div>
  </section>;
}
