import { commandError, runGit } from "./git.js";

type ResolvedWorktreeBase = {
  gitOperand: string;
  recordRef: string;
  remote: boolean;
};

export class InvalidWorktreeBaseRefError extends Error {
  constructor(options?: ErrorOptions) {
    super(
      "Worktree base ref does not resolve to a commit. Choose a local or remote branch and retry.",
      options,
    );
    this.name = "InvalidWorktreeBaseRefError";
  }
}

export async function resolveWorktreeBase(
  repoRoot: string,
  baseRef?: string,
  signal?: AbortSignal,
): Promise<ResolvedWorktreeBase> {
  if (baseRef) {
    const verified = await runGit(
      repoRoot,
      [
        "-c",
        "core.warnAmbiguousRefs=true",
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${baseRef === "-" ? "@{-1}" : baseRef}^{commit}`,
      ],
      { signal },
    );
    signal?.throwIfAborted();
    if (verified.code !== 0) {
      throw new InvalidWorktreeBaseRefError({
        cause: commandError("git rev-parse --verify", verified),
      });
    }
    let gitOperand = baseRef;
    if (baseRef !== "-" && baseRef.startsWith("-")) {
      // `worktree add -b` forwards its start point to `git branch`, which parses
      // options again without another `--`; normalize dashed refs before that hop.
      // Force strict lookup so repository config cannot hide ambiguous ref names.
      const symbolic = await runGit(
        repoRoot,
        [
          "-c",
          "core.warnAmbiguousRefs=true",
          "rev-parse",
          "--symbolic-full-name",
          "--verify",
          "--end-of-options",
          baseRef,
        ],
        { signal },
      );
      const fullRef = symbolic.stdout.trim();
      if (symbolic.code !== 0) {
        throw new InvalidWorktreeBaseRefError({
          cause: commandError("git rev-parse --symbolic-full-name --verify", symbolic),
        });
      }
      if (fullRef) {
        if (!fullRef.startsWith("refs/") || fullRef.includes("\n")) {
          throw new InvalidWorktreeBaseRefError({
            cause: commandError("git rev-parse --symbolic-full-name --verify", symbolic),
          });
        }
        gitOperand = fullRef;
      } else {
        if (symbolic.stderr.trim()) {
          throw new InvalidWorktreeBaseRefError({
            cause: commandError("git rev-parse --symbolic-full-name --verify", symbolic),
          });
        }
        gitOperand = verified.stdout.trim();
      }
    }
    return { gitOperand, recordRef: baseRef, remote: false };
  }
  const fetched = await runGit(repoRoot, ["fetch", "origin"], { signal });
  signal?.throwIfAborted();
  if (fetched.code === 0) {
    const remoteHead = await runGit(repoRoot, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
    if (remoteHead.code === 0 && remoteHead.stdout.trim()) {
      const remoteRef = remoteHead.stdout.trim();
      return { gitOperand: remoteRef, recordRef: remoteRef, remote: true };
    }
  }
  return { gitOperand: "HEAD", recordRef: "HEAD", remote: false };
}
