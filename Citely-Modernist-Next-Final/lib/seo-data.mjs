export const PRODUCT_NAME = 'Citely';
export const CANONICAL_URL = 'https://citely.example/';
export const HOME_TITLE = 'Citely — AI Document Chat With Source Citations';
export const HOME_DESCRIPTION = 'Upload documents, ask questions, and inspect the source excerpts behind every answer with Citely.';
export const PRODUCT_DEFINITION = 'Citely is an AI document chat workspace that helps people ask questions about their files and inspect the source excerpts behind each answer.';
export const TAGLINE = 'Grounded answers, cited.';
export const STATUS = 'Currently in beta testing and refinement.';
// Approval of the policy has not been established. Keep it accessible but unindexed.
export const PUBLIC_ROUTES = ['/', '/how-it-works/', '/features/document-chat/', '/features/source-citations/', '/about/', '/documentation/', '/documentation/architecture/', '/documentation/ingestion-pipeline/', '/documentation/retrieval/', '/documentation/answer-generation/', '/documentation/source-viewers/', '/documentation/citations-annotations/', '/documentation/security-privacy/', '/documentation/interactive-demo/'];
export function absoluteFor(site, route) {
  if (!route.startsWith('/') || route.startsWith('//') || /[?#\\]/.test(route) || route.split('/').includes('..')) throw new Error('Expected a site-relative route');
  return site + route;
}
export function faqSchema(faq) {
  return {'@context':'https://schema.org','@type':'FAQPage',mainEntity:faq.map(({q,a})=>({'@type':'Question',name:q,acceptedAnswer:{'@type':'Answer',text:a}}))};
}
