// SemVer 2.0.0 prerelease tagged with the commit: 1.4.0-sha.0123abc. Ordering among prereleases of one
// base is not meaningful; the dist-tag, not the version order, says which one is live.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export function shaVersion(base, sha) {
  if (!SEMVER.test(base)) throw new TypeError('plain major.minor.patch base required');
  if (!/^[a-f0-9]{7,40}$/.test(sha)) throw new TypeError('hexadecimal commit id required');
  return `${base}-sha.${sha.slice(0, 12)}`;
}
export const isSha = v => /^\d+\.\d+\.\d+-sha\.[a-f0-9]{7,12}$/.test(v);
