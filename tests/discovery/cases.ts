/**
 * Realistic searches, and what a good answer is.
 *
 * `want`  components that are a right answer (any of them may come first).
 *         Empty means nothing in the library does this.
 * `cap`   the capability that should be named when the first `want` is on top.
 * `notStrong` components that may appear as a weaker possibility, but must
 *         never be presented as the solution.
 *
 * Every case is judged twice: in the fixture library (Website Analysis plus
 * five overlapping fixtures) and in a library holding only Website Analysis.
 * In the second, any `want` that is a fixture simply is not there.
 */

export type Kind =
  | "name" | "capability" | "everyday" | "synonym" | "technical" | "short"
  | "sentence" | "misspelling" | "unrelated" | "partial";

export interface Case {
  q: string;
  kind: Kind;
  want: string[];
  cap?: string;
  notStrong?: string[];
}

const WA = "website-analysis";
const NEWS = "newsletter-sender";
const SENT = "review-sentiment";
const STACK = "tech-stack-scanner";
const FETCH = "http-fetch-with-retries";
const LEAD = "lead-enrichment";

export const CASES: Case[] = [
  // exact names
  { q: "website analysis", kind: "name", want: [WA] },
  { q: "Website-Analysis", kind: "name", want: [WA] },
  // capability names
  { q: "support chat detection", kind: "capability", want: [WA], cap: "Support chat detection" },
  { q: "ecommerce platform detection", kind: "capability", want: [WA], cap: "Ecommerce platform detection" },
  { q: "payments and checkout detection", kind: "capability", want: [WA], cap: "Payments and checkout detection" },
  { q: "CRM detection", kind: "capability", want: [WA], cap: "CRM detection" },
  { q: "custom competitor fingerprints", kind: "capability", want: [WA], cap: "Custom competitor fingerprints" },
  // everyday descriptions
  { q: "What technology is this website running?", kind: "everyday", want: [WA, STACK] },
  { q: "Find stores using Shopify.", kind: "everyday", want: [WA], cap: "Ecommerce platform detection" },
  { q: "Check whether a company uses Zendesk.", kind: "everyday", want: [WA], cap: "Support chat detection" },
  { q: "Identify a site's payment processor.", kind: "everyday", want: [WA], cap: "Payments and checkout detection" },
  { q: "What email marketing platform does this brand use?", kind: "everyday", want: [WA], cap: "Email and SMS detection" },
  { q: "Find competing tools on a prospect's website.", kind: "everyday", want: [WA], cap: "Custom competitor fingerprints" },
  { q: "does this company have a live chat widget", kind: "everyday", want: [WA], cap: "Support chat detection" },
  { q: "which reviews widget does this store use", kind: "everyday", want: [WA], cap: "Reviews detection" },
  // synonyms
  { q: "which online store software does this shop run on", kind: "synonym", want: [WA], cap: "Ecommerce platform detection" },
  { q: "detect shopping cart platform", kind: "synonym", want: [WA], cap: "Ecommerce platform detection" },
  { q: "spot a customer messaging tool on their site", kind: "synonym", want: [WA], cap: "Support chat detection" },
  { q: "is this brand using newsletter software", kind: "synonym", want: [WA], cap: "Email and SMS detection" },
  { q: "customer relationship management software on a company site", kind: "synonym", want: [WA], cap: "CRM detection" },
  { q: "software fingerprinting", kind: "synonym", want: [WA] },
  { q: "technology identification from a URL", kind: "synonym", want: [WA, STACK] },
  // technical language
  { q: "fingerprint third-party scripts by hostname", kind: "technical", want: [WA] },
  { q: "parse script src hosts from html and match them against a fingerprint library", kind: "technical", want: [WA] },
  { q: "technographics", kind: "technical", want: [WA, STACK] },
  // short
  { q: "shopify", kind: "short", want: [WA], cap: "Ecommerce platform detection" },
  { q: "intercom", kind: "short", want: [WA], cap: "Support chat detection" },
  { q: "tech stack", kind: "short", want: [WA, STACK] },
  // full sentences
  { q: "I want to figure out what software a website uses.", kind: "sentence", want: [WA, STACK] },
  { q: "I want to detect whether a company uses Intercom.", kind: "sentence", want: [WA], cap: "Support chat detection" },
  { q: "Can I reuse something to detect software from HTML?", kind: "sentence", want: [WA] },
  { q: "I need something that checks what tools a website uses.", kind: "sentence", want: [WA, STACK] },
  { q: "Do they use Salesforce or HubSpot as their CRM?", kind: "sentence", want: [WA], cap: "CRM detection" },
  // misspellings
  { q: "detect ecomerce platfrom", kind: "misspelling", want: [WA], cap: "Ecommerce platform detection" },
  { q: "websit analysys", kind: "misspelling", want: [WA] },
  { q: "payment proccessor on a site", kind: "misspelling", want: [WA], cap: "Payments and checkout detection" },
  // unrelated
  { q: "Create an authentication system.", kind: "unrelated", want: [] },
  { q: "resize images into thumbnails", kind: "unrelated", want: [] },
  { q: "parse a CSV file into rows", kind: "unrelated", want: [] },
  { q: "schedule a recurring background job", kind: "unrelated", want: [] },
  { q: "generate PDF invoices", kind: "unrelated", want: [] },
  // partial overlap: shares words with a component, asks for something else
  { q: "Analyze customer reviews.", kind: "partial", want: [SENT], notStrong: [WA] },
  { q: "sentiment analysis of product reviews", kind: "partial", want: [SENT], notStrong: [WA] },
  { q: "Build a newsletter sending system.", kind: "partial", want: [NEWS], notStrong: [WA] },
  { q: "send marketing emails to subscribers", kind: "partial", want: [NEWS], notStrong: [WA] },
  { q: "process credit card payments in my app", kind: "partial", want: [], notStrong: [WA] },
  { q: "build a live chat widget for my site", kind: "partial", want: [], notStrong: [WA] },
  { q: "store and manage my sales contacts in a CRM", kind: "partial", want: [], notStrong: [WA] },
  { q: "list the JavaScript frameworks a page loads in a headless browser", kind: "partial", want: [STACK] },
  { q: "detect Google Analytics on a website", kind: "partial", want: [STACK] },
  { q: "fetch a URL with retries and backoff", kind: "partial", want: [FETCH], notStrong: [WA] },
  { q: "find a company's employee count and industry", kind: "partial", want: [LEAD], notStrong: [WA] },
];
