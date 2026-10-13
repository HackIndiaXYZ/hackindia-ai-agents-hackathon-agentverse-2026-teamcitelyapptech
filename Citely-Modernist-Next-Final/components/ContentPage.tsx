import Link from 'next/link';
import { Footer } from './Marketing';
import { StructuredData } from './StructuredData';
import { absolute } from '@/lib/seo';
import { ProductScreenshot } from './ProductScreenshot';
const screenshots: Record<string, {name:string;alt:string;caption:string}> = {
  '/how-it-works/': {name:'library',alt:'Citely file library with a garden plan, volunteer checklist and planting schedule ready to open.',caption:'Start with your documents, organised in one workspace.'},
  '/features/document-chat/': {name:'document-chat',alt:'A question about a community garden answered beside the original document, with a page-one citation.',caption:'Ask a question and inspect the source beside the answer.'},
  '/features/source-citations/': {name:'source-citation',alt:'The selected citation highlights only the garden opening date and volunteer schedule in the source reader.',caption:'Follow a citation to its exact passage.'},
  '/about/': {name:'workspace',alt:'Citely workspace showing a source document, a cited conversation and working notes together.',caption:'Your sources, conversation and working notes, together.'},
};
export function ContentPage({title, intro, sections, route}: {title:string; intro:string; sections:{heading:string;body:string}[];route:string}) {
  return <>{route.startsWith('/features/') && <StructuredData data={{'@context':'https://schema.org','@type':'BreadcrumbList',itemListElement:[{'@type':'ListItem',position:1,name:'Citely',item:absolute('/')},{'@type':'ListItem',position:2,name:title,item:absolute(route)}]}} />}
    <article className="workflow-section content-page">
      <div className="section-label"><span>CITELY / IN PRACTICE</span><span>BETA</span></div>
      <div className="workflow-intro">
        <h1>{title}</h1>
        <p>{intro}</p>
        {screenshots[route] && <ProductScreenshot {...screenshots[route]} />}
        {sections.map((s,index)=><section key={s.heading} style={{marginTop:40}}><h2 style={{fontSize:'clamp(1.5rem,3vw,2rem)'}}>{s.heading}</h2><p>{s.body}</p>{route==='/how-it-works/' && index===2 && <ProductScreenshot {...screenshots['/features/source-citations/']} />}</section>)}
        <p><Link className="text-link" href="/try-demo/">Try demo ↗</Link></p>
      </div>
    </article><Footer /></>;
}
