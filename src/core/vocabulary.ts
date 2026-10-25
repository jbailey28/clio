/**
 * The words people use for the same thing. Discovery matches on these
 * concepts as well as on literal words, so "live chat", "helpdesk" and
 * "Intercom" all reach a capability described as "chat and helpdesk widgets".
 *
 * Three kinds:
 *  - topic: what the request is about. A match needs at least one.
 *  - action: the job asked for (detect it, send it, analyze its text, build
 *    it). Two components can share a topic and do opposite jobs: one detects
 *    email marketing tools on a website, another sends newsletters.
 *  - generic: words that say little on their own (website, company, tool).
 *    They help ranking but never make something a match by themselves.
 *
 * `words` and `phrases` are compared after stemming, so plurals and -ing
 * forms meet. `patterns` run on the lowercased raw text, for phrasings like
 * "does this brand use …" that no fixed phrase covers.
 *
 * Add to this list when a reasonable request misses. It is plain data; the
 * tests in tests/discovery show what each entry is for.
 */

export type ConceptKind = "topic" | "action" | "generic";

export interface Concept {
  key: string;
  kind: ConceptKind;
  /** How the concept is named in an explanation. */
  label: string;
  words?: string[];
  phrases?: string[];
  patterns?: RegExp[];
}

const W = (s: string) => s.split(/\s+/).filter(Boolean);

export const CONCEPTS: Concept[] = [
  // --- topics: kinds of software a website can run -------------------------
  {
    key: "ecommerce", kind: "topic", label: "ecommerce / online store platforms",
    words: W("ecommerce shopify bigcommerce woocommerce magento squarespace wix storefront shop"),
    phrases: ["e commerce", "online store", "shopping cart", "store platform", "store software", "commerce cloud", "cart platform", "store builder"],
  },
  {
    key: "support_chat", kind: "topic", label: "live chat / helpdesk / customer messaging",
    words: W("chat helpdesk chatbot intercom zendesk drift gorgias freshdesk freshchat tidio livechat kustomer crisp olark"),
    phrases: ["help desk", "customer messaging", "customer support", "customer service", "support widget", "chat widget", "chat bubble", "live chat"],
  },
  {
    key: "email_sms", kind: "topic", label: "email marketing / newsletters / SMS",
    words: W("email newsletter newsletters sms klaviyo mailchimp attentive omnisend sendgrid postscript subscriber"),
    phrases: ["marketing automation", "email marketing", "e mail"],
  },
  {
    key: "payments", kind: "topic", label: "payments / checkout",
    words: W("payment payments checkout stripe paypal adyen braintree klarna afterpay affirm"),
    phrases: ["payment processor", "payment gateway", "credit card", "shop pay", "apple pay"],
  },
  {
    key: "crm", kind: "topic", label: "CRM / sales software",
    words: W("crm salesforce hubspot pipedrive pardot"),
    phrases: ["customer relationship management", "sales software", "sales tool", "sales crm"],
  },
  {
    key: "reviews", kind: "topic", label: "reviews / ratings / UGC",
    words: W("review reviews ugc rating ratings testimonial testimonials yotpo trustpilot okendo bazaarvoice"),
    phrases: ["user generated content", "judge me"],
  },
  {
    key: "tech_detection", kind: "topic", label: "identifying the software a website runs",
    // Not "fingerprint" alone: it is how a capability works, not what it is for.
    words: W("technographic technographics builtwith wappalyzer"),
    phrases: [
      "tech stack", "technology stack", "technology identification", "identify technology", "detect technology",
      "technology detection", "detect software", "software detection", "what it run", "what software", "what technology",
      "which software", "which technology", "what tool", "which tool", "software fingerprint", "technology fingerprint",
      "third party script",
    ],
    patterns: [/\b(software|tools?|technolog\w*|tech|platforms?|vendors?)\b[^.?!]{0,40}\b(uses?|using|runs?|running|built (on|with)|installed)\b/],
  },
  {
    key: "competitor", kind: "topic", label: "competitors",
    words: W("competitor competitors competing competition competitive rival rivals incumbent"),
  },
  {
    key: "analytics", kind: "topic", label: "analytics tags",
    words: W("analytics mixpanel amplitude"),
    phrases: ["google analytics", "analytics tag", "tag manager", "tracking pixel"],
  },
  {
    key: "js_framework", kind: "topic", label: "JavaScript frameworks",
    words: W("react vue angular svelte nextjs"),
    phrases: ["javascript framework", "front end framework", "next js"],
  },
  {
    key: "headless_browser", kind: "topic", label: "headless browsers",
    words: W("puppeteer playwright selenium"),
    phrases: ["headless browser"],
  },
  {
    key: "sentiment", kind: "topic", label: "what text says (sentiment, topics)",
    words: W("sentiment opinion emotion"),
    phrases: ["topic extraction", "common complaint"],
  },
  {
    key: "http_retry", kind: "topic", label: "retrying failed requests",
    words: W("retry retries retrying backoff timeout"),
    phrases: ["exponential backoff"],
  },
  {
    key: "company_data", kind: "topic", label: "company facts (size, industry, funding)",
    words: W("firmographic firmographics headcount funding industry enrichment"),
    phrases: ["employee count", "company size", "number of employees", "lead enrichment"],
  },

  // --- actions: the job asked for ------------------------------------------
  {
    key: "detect", kind: "action", label: "detecting what something uses",
    words: W("detect detects detection detecting identify identifies identification spot recognise recognize scan"),
    phrases: ["find out", "figure out", "check whether", "check if", "tell which", "tell what", "what it run"],
    patterns: [
      /\b(does|do|is|are)\b[^.?!]{0,40}\b(use|uses|using|run|runs|running|have|on)\b/,
      /\b(which|what)\b[^.?!]{0,60}\b(uses?|using|runs?|running|run on)\b/,
      /\b(stores?|sites?|websites?|compan(y|ies)|brands?|shops?|prospects?)\s+(that\s+)?(using|uses?|use|running|runs?)\b/,
    ],
  },
  {
    key: "send", kind: "action", label: "sending messages",
    words: W("send sends sending deliver delivering blast"),
  },
  {
    key: "analyze_text", kind: "action", label: "analyzing what text says",
    words: W("sentiment summarize summarise"),
    patterns: [/\banaly[sz]\w*\s+(the\s+)?(text|content|meaning|wording|feedback|comments?|(customer\s+|product\s+)?reviews?)\b/, /\b(sentiment|opinion)\s+analys/],
  },
  {
    key: "provide", kind: "action", label: "building or running the thing itself",
    words: W("build create implement develop process charge manage"),
    phrases: ["set up", "for my site", "in my app", "on my site"],
  },

  // --- generic -------------------------------------------------------------
  { key: "website", kind: "generic", label: "websites", words: W("website site page webpage url domain homepage html web") },
  { key: "organization", kind: "generic", label: "companies", words: W("company companies brand brands prospect prospects account business") },
  { key: "software", kind: "generic", label: "software", words: W("software tool tools platform vendor technology tech app service system widget library") },
];

/** Actions that describe looking at someone else's product. A component that
 * only does this is not a way to build that product. */
export const OBSERVING = new Set(["detect"]);
