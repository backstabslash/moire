import type { CompareMode } from "../shared/types";
import { gh, git, gitError, gitFetch, sides } from "./git";

export type Comparison = { base: string; head: string; worktree?: boolean } | { pr: string };

interface PrView {
  baseRefName: string;
  commits: { oid: string }[];
  headRefOid: string;
  mergeCommit: { oid: string } | null;
  state: string;
  url: string;
}

export function parseComparison(args: string[]): Comparison {
  if (args[0] === "pr" && args.length === 2 && /^\d+$/.test(args[1])) return { pr: args[1] };
  const parts = args[0].split(/\.{2,3}/);
  if (args.length > 1 || parts.length > 2) throw new Error(`Can't compare "${args.join(" ")}". Try main..feature, HEAD~3 or pr 123.`);
  if (parts.length === 1) return { base: parts[0], head: "HEAD", worktree: true };
  return { base: parts[0] || "HEAD", head: parts[1] || "HEAD" };
}

// Covers git@host:o/r.git, ssh://git@host:22/o/r and https://host/o/r/.
function hostAndRepo(url: string): string | null {
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+(?=\/))?[:/](.+?)(?:\.git)?\/?$/i.exec(url);
  return m && `${m[1]}/${m[2]}`.toLowerCase();
}

// GitHub's base repo may be a remote other than origin, or none at all when you've cloned a fork.
export function remoteFor(url: string, remotes: string): string {
  const { host, pathname } = new URL(url);
  const repo = pathname.split("/").slice(1, 3).join("/");
  const wanted = `${host}/${repo}`.toLowerCase();
  const match = remotes.split("\n").find((line) => {
    const [, url] = /^\S+\s+(\S+) \(fetch\)/.exec(line) ?? [];
    return url && hostAndRepo(url) === wanted;
  });
  return match?.split(/\s/)[0] ?? `https://${host}/${repo}.git`;
}

// A remote we couldn't match may be private, and gh is signed in or it wouldn't have found the PR.
const GH_CREDENTIALS = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];

async function fetchPr(root: string, pr: string): Promise<{ base: string; head: string }> {
  const view = await gh(root, ["pr", "view", pr, "--json", "baseRefName,commits,headRefOid,mergeCommit,state,url"]).catch((e: NodeJS.ErrnoException) => {
    throw new Error(e.code === "ENOENT" ? "moire pr needs the GitHub CLI (gh) on your PATH" : gitError(e));
  });
  const { baseRefName, commits, headRefOid, mergeCommit, state, url } = JSON.parse(view) as PrView;
  const remote = remoteFor(url, await git(root, ["remote", "-v"]));
  const [base, head] = ["base", "head"].map((side) => `moire/pr/${pr}/${side}`);
  // The base branch of a merged PR already contains it, and may be gone. A fast-forward has no merge commit, so its first commit stands in.
  const merged = state === "MERGED" ? (mergeCommit?.oid === headRefOid ? commits[0]?.oid : mergeCommit?.oid) : undefined;
  const refspecs = [`+${merged ?? `refs/heads/${baseRefName}`}:refs/${base}`, `+refs/pull/${pr}/head:refs/${head}`];
  await gitFetch(root, ["--", remote, ...refspecs], remote.startsWith("https://") ? GH_CREDENTIALS : []).catch((e) => {
    throw new Error(gitError(e));
  });
  return { base: merged ? `${base}^` : base, head };
}

export async function compareMode(root: string, args: string[]): Promise<CompareMode> {
  const wanted = parseComparison(args);
  const mode: CompareMode = { kind: "branches", ...("pr" in wanted ? await fetchPr(root, wanted.pr) : wanted) };
  await sides(root, mode);
  return mode;
}
