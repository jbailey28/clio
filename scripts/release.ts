/**
 * Freeze a component version: npm run release -- <slug> <version> [from-folder]
 *
 * Copies the folder (default: the component's primary source) into
 * library/releases/<slug>/<version>/, writes RELEASE.json with per-file
 * checksums, and makes the copy read-only. It does NOT record the release in
 * the library: do that with the record_release MCP tool, which asks for approval.
 */
import { openLibrary } from "../src/core";

const [slug, version, from] = process.argv.slice(2);
if (!slug || !version) {
  console.error("usage: npm run release -- <slug> <version> [from-folder]");
  process.exit(2);
}
const lib = openLibrary();
try {
  const source = from ?? lib.components.get(slug).sources.find((s) => s.isPrimary)?.path;
  if (!source) throw new Error(`${slug} has no primary source folder; pass one`);
  const snap = lib.releases.snapshot({ slug, version, from: source });
  console.log(JSON.stringify({ path: snap.path, checksum: snap.checksum, files: snap.files.length, skipped: snap.skipped }, null, 2));
} catch (err) {
  console.error(`release failed: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  lib.db.close();
}
