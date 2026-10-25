/**
 * Throwaway libraries for discovery tests. Each lives in its own temp folder
 * with its own database; nothing here ever opens the real library.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openLibrary, type Library } from "../../src/core";
import wa from "../fixtures/website-analysis.json";

export interface Temp {
  lib: Library;
  dir: string;
  close: () => void;
}

type Spec = {
  name: string;
  category: string;
  categoryDescription?: string;
  summary: string;
  documentation?: string;
  language?: string;
  version?: string;
  capabilities: { name: string; description?: string; kind?: "capability" | "check" }[];
  inputs?: { name: string; type?: string; description?: string }[];
  outputs?: { name: string; type?: string; description?: string }[];
};

/** Five made-up components that overlap Website Analysis in wording, each in a
 * different way, so ranking and "this is not the same thing" can be tested. */
export const OVERLAPPING: Spec[] = [
  {
    name: "Newsletter Sender",
    category: "Email",
    categoryDescription: "Sending email",
    summary: "Sends newsletters and marketing email campaigns to a subscriber list over SMTP.",
    capabilities: [
      { name: "Send email campaigns", description: "queue and send a newsletter to every subscriber" },
      { name: "Subscriber list management", description: "add, remove and segment subscribers" },
      { name: "Unsubscribe handling", description: "one-click unsubscribe links", kind: "check" },
    ],
    inputs: [{ name: "subscribers", type: "list", description: "email addresses" }],
    outputs: [{ name: "delivery report", type: "dict" }],
  },
  {
    name: "Review Sentiment",
    category: "Text Analysis",
    categoryDescription: "Understanding written text",
    summary: "Analyzes the text of customer reviews: sentiment, common complaints and topics.",
    capabilities: [
      { name: "Sentiment scoring", description: "positive, negative or neutral for each review" },
      { name: "Topic extraction", description: "the themes customers mention most" },
    ],
    inputs: [{ name: "reviews", type: "list[str]", description: "review text" }],
    outputs: [{ name: "scores", type: "list[dict]" }],
  },
  {
    name: "Tech Stack Scanner",
    category: "Website Research",
    summary: "Opens a page in a headless browser and lists the JavaScript frameworks and analytics tags it loads.",
    capabilities: [
      { name: "JavaScript framework detection", description: "React, Vue, Angular, Next.js and similar" },
      { name: "Analytics tag detection", description: "Google Analytics, Segment, Mixpanel and similar" },
    ],
    inputs: [{ name: "url", type: "string" }],
    outputs: [{ name: "technologies", type: "list" }],
  },
  {
    name: "HTTP Fetch with Retries",
    category: "Networking",
    categoryDescription: "Talking to other servers",
    summary: "Fetches a URL and retries failed requests with exponential backoff and a timeout.",
    capabilities: [
      { name: "Retry with backoff", description: "waits longer after each failure" },
      { name: "Timeout handling", description: "gives up after a set time", kind: "check" },
    ],
    inputs: [{ name: "url", type: "string" }],
    outputs: [{ name: "response", type: "bytes" }],
  },
  {
    name: "Lead Enrichment",
    category: "Sales Data",
    categoryDescription: "Facts about companies and people",
    summary: "Looks up a company's employee count, industry and funding from its domain.",
    capabilities: [
      { name: "Company size lookup", description: "employee count range" },
      { name: "Industry classification", description: "the industry a company is in" },
    ],
    inputs: [{ name: "domain", type: "string" }],
    outputs: [{ name: "company", type: "dict" }],
  },
];

export const WEBSITE_ANALYSIS = wa as Spec;

export function makeLibrary(specs: Spec[]): Temp {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cl-discovery-")));
  const lib = openLibrary(path.join(dir, "db", "library.db"));
  lib.settings.update({ allowedRoots: [dir] });
  for (const s of specs) {
    const catSlug = s.category.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    if (!lib.categories.list().some((c) => c.slug === catSlug)) {
      lib.categories.create({ name: s.category, description: s.categoryDescription ?? "" });
    }
    const src = path.join(dir, "code", s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
    fs.mkdirSync(src, { recursive: true });
    lib.components.create({
      name: s.name,
      category: catSlug,
      summary: s.summary,
      documentation: s.documentation ?? "",
      language: s.language ?? "Python",
      version: s.version ?? "1.0.0",
      sources: [src],
      capabilities: s.capabilities.map((c) => ({ name: c.name, description: c.description ?? "", kind: c.kind ?? "capability" })),
      inputs: (s.inputs ?? []).map((x) => ({ name: x.name, type: x.type ?? "", description: x.description ?? "" })),
      outputs: (s.outputs ?? []).map((x) => ({ name: x.name, type: x.type ?? "", description: x.description ?? "" })),
    } as any);
  }
  return {
    lib,
    dir,
    close: () => {
      lib.db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
