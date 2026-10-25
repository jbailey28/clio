import { NextResponse } from "next/server";
import { isLibraryError } from "@/src/core/errors";
import { getLib } from "@/src/web/lib";
import { fromAnotherSite } from "@/src/web/guard";

export const dynamic = "force-dynamic";

/**
 * Opens a recorded project in Claude Code (a new Terminal window in its folder).
 * Takes only a project id: the folder and the claude program come from the server.
 * POST only, and only from this app's own pages, so a link or another site can't trigger it.
 */
export async function POST(req: Request) {
  const refused = fromAnotherSite(req);
  if (refused) return NextResponse.json({ error: `Refused: ${refused}.` }, { status: 403 });
  const form = await req.formData().catch(() => null);
  const project = String(form?.get("project") ?? "");
  try {
    const r = await getLib().claudeCode.open(project);
    const { cli, ...rest } = r; // the program's location stays on the server
    return NextResponse.json({ ...rest, cliFound: cli.found }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    if (isLibraryError(err)) return NextResponse.json({ error: err.message }, { status: 404 });
    return NextResponse.json({ error: `Something went wrong: ${(err as Error).message}` }, { status: 500 });
  }
}
