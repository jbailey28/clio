import { invalid } from "./errors";

/** Semantic versions: major.minor.patch, numbers only. No ranges, no pre-releases. */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseVersion(v: string): [number, number, number] {
  const m = SEMVER.exec((v ?? "").trim());
  if (!m) throw invalid(`"${v}" is not a version like 1.2.3 (major.minor.patch, numbers only).`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export const isVersion = (v: string) => SEMVER.test((v ?? "").trim());

export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** The newest of a list of versions, ignoring anything that isn't a version. */
export function newest(versions: string[]): string {
  return versions.filter(isVersion).sort(compareVersions).at(-1) ?? "";
}
