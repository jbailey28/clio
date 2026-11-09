import { NextResponse } from "next/server";
import { isLibraryError } from "@/src/core/errors";
import { getLib } from "@/src/web/lib";
import { fromAnotherSite } from "@/src/web/guard";

export const dynamic = "force-dynamic";

/**
 * Starts or stops a recorded project's app. Takes only a project id and
 * "start" or "stop": the folder and the command come from the library, and the
 * command is one of the built-in ones the person approved. POST only, and only
 * from this app's own pages, so a link or another site can't trigger it.
 */
export async function POST(req: Request) {
  const refused = fromAnotherSite(req);
  if (refused) return NextResponse.json({ error: `Refused: ${refused}.` }, { status: 403 });
  const form = await req.formData().catch(() => null);
  const project = String(form?.get("project") ?? "");
  const action = String(form?.get("action") ?? "");
  try {
    const run = getLib().run;
    const status = action === "start" ? await run.start(project) : action === "stop" ? await run.stop(project) : await run.status(project);
    return NextResponse.json(status, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    if (isLibraryError(err)) return NextResponse.json({ error: err.message }, { status: 400 });
    return NextResponse.json({ error: `Something went wrong: ${(err as Error).message}` }, { status: 500 });
  }
}
