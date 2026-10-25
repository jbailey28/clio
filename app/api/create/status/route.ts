import { NextResponse } from "next/server";
import { getLib } from "@/src/web/lib";
import { fromAnotherSite } from "@/src/web/guard";

export const dynamic = "force-dynamic";

/**
 * Read-only: what a draft (component or project) is doing right now, as the server last recorded it.
 * `active` is null when nothing is running (or a step was left by a crash).
 */
export async function GET(req: Request) {
  const refused = fromAnotherSite(req);
  if (refused) return NextResponse.json({ error: `Refused: ${refused}.` }, { status: 403 });
  const id = new URL(req.url).searchParams.get("draft") ?? "";
  try {
    const lib = getLib();
    const headers = { "cache-control": "no-store" };
    if (lib.projectCreation.owns(id)) {
      const d = lib.projectCreation.get(id);
      return NextResponse.json({ active: lib.creation.active(d), stage: d.project ? "created" : d.plan ? "planned" : "planning", lastError: d.lastError, updatedAt: d.updatedAt }, { headers });
    }
    const d = lib.creation.get(id);
    return NextResponse.json({ active: lib.creation.active(d), stage: lib.creation.stage(d), lastError: d.lastError, updatedAt: d.updatedAt }, { headers });
  } catch {
    return NextResponse.json({ error: "No such draft." }, { status: 404 });
  }
}
