import "server-only";

/**
 * Only this app's own pages may use these endpoints. A browser marks every request with
 * where it came from; a page on another site (or a site pretending to be this
 * one through DNS) is refused before anything runs. Scripts on this Mac that
 * send no browser headers are still allowed.
 */
export function fromAnotherSite(req: Request): string | null {
  const host = req.headers.get("host") ?? "";
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return `this app only answers on 127.0.0.1, not "${host}"`;
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return "the request came from another website";
  const origin = req.headers.get("origin");
  if (origin && origin !== "null") {
    try { if (new URL(origin).host !== host) return "the request came from another website"; } catch { return "the request has an unreadable origin"; }
  } else if (origin === "null") return "the request came from a page with no origin";
  return null;
}

