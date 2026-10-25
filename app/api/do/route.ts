import { NextResponse } from "next/server";
import { isLibraryError } from "@/src/core/errors";
import { ops, safeReturn } from "@/src/web/actions";
import { fromAnotherSite } from "@/src/web/guard";

export const dynamic = "force-dynamic";

/**
 * The single endpoint every form posts to. With JavaScript, ActionForm sends
 * x-fetch: 1 and gets JSON so typed input survives an error. Without it, the
 * browser follows a 303 redirect.
 */
export async function POST(req: Request) {
  const refused = fromAnotherSite(req);
  if (refused) return NextResponse.json({ ok: false, error: `Refused: ${refused}.` }, { status: 403 });
  const form = await req.formData();
  const op = String(form.get("op") ?? "");
  const wantsJson = req.headers.get("x-fetch") === "1";
  const back = safeReturn(String(form.get("returnTo") ?? ""), "/");

  const respond = (ok: boolean, payload: { redirect?: string; error?: string }) => {
    if (wantsJson) return NextResponse.json({ ok, ...payload }, { status: ok ? 200 : 400 });
    const target = ok ? payload.redirect! : `${back}${back.includes("?") ? "&" : "?"}error=${encodeURIComponent(payload.error!)}`;
    return new NextResponse(null, { status: 303, headers: { Location: target } });
  };

  const handler = ops[op];
  if (!handler) return respond(false, { error: `Unknown action "${op}".` });
  try {
    return respond(true, { redirect: safeReturn(await handler(form)) });
  } catch (err) {
    if (isLibraryError(err)) return respond(false, { error: err.message });
    console.error(`[component-library] ${op} failed`, err);
    return respond(false, { error: `Something went wrong running "${op}": ${(err as Error).message}` });
  }
}
