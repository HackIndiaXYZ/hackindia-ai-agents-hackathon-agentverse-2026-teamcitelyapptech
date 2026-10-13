import Link from 'next/link';
import { Footer } from './Marketing';
import { ProductScreenshot } from './ProductScreenshot';
import { StructuredData } from './StructuredData';
import { absolute } from '@/lib/seo';
import { DOC_OVERVIEW, DOC_PAGES, type DocPage } from '@/lib/documentation';
import { PosterSeries } from './PosterSeries';

function DocsNav({active}:{active?:string}) {
  return <nav className="docs-nav" aria-label="Documentation sections">
    <Link className={!active?'active':''} href="/documentation/">Overview</Link>
    {DOC_PAGES.map(page=><Link className={active===page.slug?'active':''} key={page.slug} href={`/documentation/${page.slug}/`}>{page.title}</Link>)}
  </nav>;
}

export function DocumentationOverview(){
  return <><StructuredData data={{'@context':'https://schema.org','@type':'CollectionPage',name:DOC_OVERVIEW.title,description:DOC_OVERVIEW.description,url:absolute('/documentation/')}} />
    <div className="docs-shell"><DocsNav/><article className="docs-article docs-overview">
      <div className="docs-kicker"><span>DOCUMENTATION</span><span>BETA / CURRENT SYSTEM</span></div>
      <h1>Understand the product.<br/><em>Follow the evidence.</em></h1><p className="docs-lede">{DOC_OVERVIEW.description}</p>
      <ProductScreenshot name="workspace" alt="Citely workspace joining an answer, its source and working notes." caption="Citely keeps the question, evidence and working context together." priority />
      <section><h2>What Citely is</h2><p>Citely is an AI document chat workspace for people who need to question files and inspect where each answer came from. It brings a document library, scoped conversations, original-file readers, exact citations, saved evidence and revisioned notes into one workflow.</p></section>
      <section><h2>Where it helps</h2><div className="docs-card-grid"><div><strong>Research and review</strong><p>Trace a statement back to the exact passage before carrying it into analysis.</p></div><div><strong>Operational knowledge</strong><p>Question reports, policies and project files without losing the source context.</p></div><div><strong>Evidence capture</strong><p>Keep citations, add manual highlights and develop notes alongside the material.</p></div></div></section>
      <PosterSeries />
      <section><h2>Explore the system</h2><div className="docs-index">{DOC_PAGES.map((page,index)=><Link href={`/documentation/${page.slug}/`} key={page.slug}><span>{String(index+1).padStart(2,'0')}</span><div><h3>{page.title}</h3><p>{page.description}</p></div><b>↗</b></Link>)}</div></section>
    </article></div><Footer/></>;
}

export function DocumentationPage({page}:{page:DocPage}){
  const index=DOC_PAGES.findIndex(item=>item.slug===page.slug);
  const next=DOC_PAGES[index+1];
  return <><StructuredData data={{'@context':'https://schema.org','@type':'TechArticle',headline:page.title,description:page.description,url:absolute(`/documentation/${page.slug}/`),isPartOf:{'@type':'CollectionPage',name:'Citely documentation',url:absolute('/documentation/')}}} />
    <div className="docs-shell"><DocsNav active={page.slug}/><article className="docs-article">
      <div className="docs-breadcrumb"><Link href="/documentation/">Documentation</Link><span>/</span><span>{page.title}</span></div>
      <span className="tiny-label">{page.eyebrow}</span><h1>{page.title}</h1><p className="docs-lede">{page.description}</p>
      {page.screenshot&&<ProductScreenshot {...page.screenshot}/>}
      {page.slug==='ingestion-pipeline'&&<PosterSeries ids={['Citely-D2-1-Problem','Citely-D2-2-Mechanism','Citely-D2-3-Takeaway']} heading={false}/>}
      {page.slug==='retrieval'&&<PosterSeries ids={['Citely-D3-1-Problem','Citely-D3-2-Mechanism','Citely-D3-3-Takeaway']} heading={false}/>}
      {page.slug==='answer-generation'&&<PosterSeries ids={['Citely-D3-2-Mechanism','Citely-D3-3-Takeaway']} heading={false}/>}
      {page.slug==='source-viewers'&&<PosterSeries ids={['Citely-D5-1-Problem','Citely-D5-2-Mechanism','Citely-D5-3-Takeaway']} heading={false}/>}
      {page.slug==='citations-annotations'&&<PosterSeries ids={['Citely-D4-1-Problem','Citely-D4-2-Mechanism','Citely-D4-3-Takeaway','Citely-D6-1-Problem','Citely-D6-2-Mechanism','Citely-D6-3-Takeaway']} heading={false}/>}
      <div className="docs-sections">{page.sections.map((section,i)=><section key={section.heading} id={`section-${i+1}`}><span className="docs-section-number">{String(i+1).padStart(2,'0')}</span><div><h2>{section.heading}</h2><p>{section.body}</p>{section.points&&<ul>{section.points.map(point=><li key={point}>{point}</li>)}</ul>}</div></section>)}</div>
      <aside className="docs-note"><strong>Evidence standard</strong><p>This documentation describes the current implementation. Accepted file types and interface controls do not by themselves guarantee perfect extraction, rendering or answer quality.</p></aside>
      <div className="docs-next">{next?<><span>Next section</span><Link href={`/documentation/${next.slug}/`}>{next.title} <b>↗</b></Link></>:<><span>Continue exploring</span><Link href="/how-it-works/">How Citely works <b>↗</b></Link></>}</div>
    </article></div><Footer/></>;
}
