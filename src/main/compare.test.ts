import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { compareMode, parseComparison, remoteFor } from "./compare";
import { diff } from "./git";
import { makeRepo, type Repo, seed, tempDir } from "./test-repo";

describe("parseComparison", () => {
  it("reads ranges and single revisions, defaulting to HEAD", () => {
    expect(parseComparison(["main..feature"])).toEqual({ base: "main", head: "feature" });
    expect(parseComparison(["main...feature"])).toEqual({ base: "main", head: "feature" });
    expect(parseComparison(["HEAD~3"])).toEqual({ base: "HEAD~3", head: "HEAD" });
    expect(parseComparison(["main.."])).toEqual({ base: "main", head: "HEAD" });
    expect(parseComparison(["..feature"])).toEqual({ base: "HEAD", head: "feature" });
    expect(parseComparison(["pr", "123"])).toEqual({ pr: "123" });
  });

  it("refuses what it can't read", () => {
    expect(() => parseComparison(["a..b..c"])).toThrow("Can't compare");
    expect(() => parseComparison(["pr", "abc"])).toThrow("Can't compare");
    expect(() => parseComparison(["main", "feature"])).toThrow("Can't compare");
  });
});

describe("remoteFor", () => {
  const url = "https://github.com/Owner/Repo/pull/7";
  const fallback = "https://github.com/Owner/Repo.git";

  it("finds the base repo among the remotes, over any protocol", () => {
    expect(remoteFor(url, "fork\tgit@github.com:me/repo.git (fetch)\nup\tgit@github.com:owner/repo.git (fetch)\n")).toBe("up");
    expect(remoteFor(url, "origin\thttps://github.com/owner/repo (fetch)\n")).toBe("origin");
    expect(remoteFor(url, "origin\thttps://token@github.com/owner/repo.git/ (fetch)\n")).toBe("origin");
    expect(remoteFor(url, "origin\tssh://git@github.com:22/owner/repo.git (fetch)\n")).toBe("origin");
  });

  it("reads partial clones, which add a filter after (fetch)", () => {
    expect(remoteFor(url, "origin\tgit@github.com:owner/repo.git (fetch) [blob:none]\n")).toBe("origin");
  });

  it("won't take a similar owner or the same path on another host", () => {
    expect(remoteFor(url, "fork\tgit@github.com:notowner/repo.git (fetch)\norigin\tgit@github.com:owner/repo.git (fetch)\n")).toBe("origin");
    expect(remoteFor(url, "backup\tgit@gitlab.com:owner/repo.git (fetch)\n")).toBe(fallback);
  });

  it("falls back to the PR's own repo", () => {
    expect(remoteFor(url, "fork\tgit@github.com:me/repo.git (fetch)\n")).toBe(fallback);
    expect(remoteFor("https://ghe.corp.example/o/r/pull/1", "up\tgit@ghe.corp.example:o/r.git (fetch)\n")).toBe("up");
  });
});

describe("compareMode", () => {
  it("compares a range and refuses an unknown revision", async () => {
    const r = seed({ "a.txt": "1\n" }, { "a.txt": "2\n" });
    r.commit("two");
    const mode = await compareMode(r.root, ["HEAD~1"]);
    expect(mode).toEqual({ kind: "branches", base: "HEAD~1", head: "HEAD" });
    expect((await diff(r.root, mode)).files.map((f) => f.path)).toEqual(["a.txt"]);
    await expect(compareMode(r.root, ["nope..HEAD"])).rejects.toThrow("Unknown revision: nope");
  });
});

describe("pull requests", () => {
  const path = process.env.PATH;
  let bin: string;
  const fakeGh = (body: string) => {
    writeFileSync(join(bin, "gh"), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, "gh"), 0o755);
  };

  beforeAll(() => {
    bin = tempDir("moire-bin-");
  });
  afterEach(() => {
    process.env.PATH = path;
    vi.resetModules();
  });

  async function withFakeGh() {
    process.env.PATH = `${bin}:${path}`;
    vi.resetModules();
    return import("./compare");
  }

  function prRepo(server: string, view: object = {}, r: Repo = seed({ "x.txt": "x\n" })) {
    r.git("remote", "add", "up", "https://github.com/owner/repo.git");
    r.git("config", `url.${server}.insteadOf`, "https://github.com/owner/repo.git");
    fakeGh(`echo '${JSON.stringify({ baseRefName: "main", url: "https://github.com/owner/repo/pull/7", ...view })}'`);
    return r;
  }

  async function filesOfPr(r: Repo) {
    const fresh = await withFakeGh();
    return (await diff(r.root, await fresh.compareMode(r.root, ["pr", "7"]))).files.map((f) => f.path);
  }

  function onlyGit() {
    const dir = tempDir("moire-bin-");
    symlinkSync(execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(), join(dir, "git"));
    process.env.PATH = dir;
    vi.resetModules();
    return dir;
  }

  it("fetches the PR and its base from the remote, without touching branches", async () => {
    const server = seed({ "a.txt": "base\n" });
    server.git("checkout", "-q", "-b", "topic");
    server.write("a.txt", "topic\n");
    const sha = server.commit("topic");
    server.git("tag", "v1", sha);
    server.git("update-ref", "refs/pull/7/head", sha);
    server.git("checkout", "-q", "main");

    const r = seed({ "x.txt": "x\n" });
    // Git reads this as a path, and remoteFor as github.com, so the fetch goes through a remote it really matched.
    const remote = "github.com/owner/repo.git";
    execFileSync("git", ["clone", "-q", "--bare", server.root, join(r.root, remote)]);
    execFileSync("git", ["-C", join(r.root, remote), "update-ref", "refs/pull/7/head", sha]);
    r.git("remote", "add", "up", remote);
    fakeGh(`echo '{"baseRefName":"main","url":"https://github.com/owner/repo/pull/7"}'`);

    const fresh = await withFakeGh();
    const mode = await fresh.compareMode(r.root, ["pr", "7"]);
    expect(mode).toEqual({ kind: "branches", base: "moire/pr/7/base", head: "moire/pr/7/head" });
    expect(r.git("rev-parse", "refs/moire/pr/7/head")).toBe(sha);
    expect(r.git("for-each-ref", "--format=%(refname)", "refs/heads/")).toBe("refs/heads/main");
    expect(r.git("for-each-ref", "--format=%(refname)", "refs/remotes/")).toBe("");
    expect(r.git("for-each-ref", "--format=%(refname)", "refs/tags/")).toBe("");
    expect(existsSync(join(r.root, ".git", "FETCH_HEAD"))).toBe(false);
    expect((await diff(r.root, mode)).files.map((f) => f.path)).toEqual(["a.txt"]);
  });

  it("opens a PR that bumps a submodule to a commit its remote doesn't have", async () => {
    const sub = seed({ "s.txt": "1\n" });
    const server = makeRepo();
    server.git("-c", "protocol.file.allow=always", "submodule", "--quiet", "add", sub.root, "vendor");
    server.commit("add vendor");
    sub.write("s.txt", "2\n");
    const fork = sub.commit("only in a fork");
    sub.git("reset", "-q", "--hard", "HEAD~1");
    sub.git("reflog", "expire", "--expire=now", "--all");
    sub.git("gc", "-q", "--prune=now");
    server.git("checkout", "-q", "-b", "topic");
    server.git("update-index", "--cacheinfo", `160000,${fork},vendor`);
    server.git("commit", "-q", "-m", "bump");
    server.git("update-ref", "refs/pull/7/head", "topic");
    server.git("checkout", "-q", "main");
    const r = makeRepo();
    r.git("pull", "-q", server.root, "main");
    r.git("-c", "protocol.file.allow=always", "submodule", "--quiet", "update", "--init");
    expect(await filesOfPr(prRepo(server.root, {}, r))).toEqual(["vendor"]);
  });

  it("shows a PR merged with a merge commit as it was before the merge, even with its base branch deleted", async () => {
    const server = seed({ "a.txt": "base\n" });
    server.git("checkout", "-q", "-b", "topic");
    server.write("b.txt", "topic\n");
    const sha = server.commit("topic");
    server.git("update-ref", "refs/pull/7/head", sha);
    server.git("checkout", "-q", "main");
    server.write("c.txt", "later on main\n");
    server.commit("later");
    server.git("merge", "-q", "--no-ff", "-m", "merge", "topic");
    const oid = server.git("rev-parse", "HEAD");
    server.git("checkout", "-q", "--detach");
    server.git("branch", "-q", "-D", "main");
    server.git("update-ref", "refs/heads/keep", oid);

    expect(await filesOfPr(prRepo(server.root, { state: "MERGED", mergeCommit: { oid } }))).toEqual(["b.txt"]);
  });

  it("shows every commit of a PR fast-forwarded onto its base", async () => {
    const server = seed({ "a.txt": "base\n" });
    server.git("checkout", "-q", "-b", "topic");
    server.write("b.txt", "first\n");
    const first = server.commit("first");
    server.write("c.txt", "second\n");
    const last = server.commit("second");
    server.git("update-ref", "refs/pull/7/head", last);
    server.git("checkout", "-q", "main");
    server.git("merge", "-q", "--ff-only", "topic");

    const view = { commits: [{ oid: first }, { oid: last }], headRefOid: last, state: "MERGED", mergeCommit: { oid: last } };
    expect(await filesOfPr(prRepo(server.root, view))).toEqual(["b.txt", "c.txt"]);
  });

  it("signs in with gh only for a remote it couldn't match", async () => {
    const asked: (string | undefined)[] = [];
    const http = createServer((req, res) => {
      asked.push(req.headers.authorization);
      res.writeHead(req.headers.authorization ? 404 : 401, { "WWW-Authenticate": 'Basic realm="git"' }).end();
    });
    await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
    const local = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    const gh = (url: string) => `[ "$1" = auth ] && { echo username=x-access-token; echo password=from-gh; exit; }
echo '{"baseRefName":"main","state":"OPEN","mergeCommit":null,"url":"${url}"}'`;

    const unmatched = seed({ "x.txt": "x\n" });
    unmatched.git("config", `url.${local}/.insteadOf`, "https://github.com/");
    fakeGh(gh("https://github.com/owner/repo/pull/7"));
    await expect((await withFakeGh()).compareMode(unmatched.root, ["pr", "7"])).rejects.toThrow();
    expect(asked).toContain(`Basic ${Buffer.from("x-access-token:from-gh").toString("base64")}`);

    asked.length = 0;
    const matched = seed({ "x.txt": "x\n" });
    matched.git("remote", "add", "up", `${local}/owner/repo.git`);
    fakeGh(gh("https://127.0.0.1/owner/repo/pull/7"));
    await expect((await withFakeGh()).compareMode(matched.root, ["pr", "7"])).rejects.toThrow();
    http.close();
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.filter(Boolean)).toEqual([]);
  });

  it("fails a fetch that wants a password rather than opening a desktop dialog", async () => {
    const r = seed({ "x.txt": "x\n" });
    const http = createServer((_, res) => res.writeHead(401, { "WWW-Authenticate": 'Basic realm="git"' }).end());
    await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
    const asked = join(bin, "askpass-ran");
    writeFileSync(join(bin, "askpass"), `#!/bin/sh\ntouch ${asked}\n`);
    chmodSync(join(bin, "askpass"), 0o755);
    vi.stubEnv("SSH_ASKPASS", join(bin, "askpass"));
    await withFakeGh();
    const { gitFetch } = await import("./git");
    const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/o/r.git`;
    await expect(gitFetch(r.root, ["--", url, "+refs/heads/main:refs/x"])).rejects.toThrow();
    http.close();
    vi.unstubAllEnvs();
    expect(existsSync(asked)).toBe(false);
  });

  it("passes on gh's own error", async () => {
    const r = seed({ "a.txt": "1\n" });
    fakeGh(`echo 'no pull requests found' >&2; exit 1`);
    const fresh = await withFakeGh();
    await expect(fresh.compareMode(r.root, ["pr", "7"])).rejects.toThrow("no pull requests found");
  });

  it("waits for the login shell's PATH before looking for gh", async () => {
    const r = seed({ "a.txt": "1\n" });
    fakeGh(`echo 'no pull requests found' >&2; exit 1`);
    const dir = onlyGit();
    const [fresh, git] = [await import("./compare"), await import("./git")];
    git.setShellPath(new Promise((done) => setTimeout(() => done(`${bin}:${dir}`), 50)));
    await expect(fresh.compareMode(r.root, ["pr", "7"])).rejects.toThrow("no pull requests found");
  });

  it("says so when gh isn't installed", async () => {
    const r = seed({ "a.txt": "1\n" });
    onlyGit();
    const fresh = await import("./compare");
    await expect(fresh.compareMode(r.root, ["pr", "7"])).rejects.toThrow("needs the GitHub CLI");
  });
});
