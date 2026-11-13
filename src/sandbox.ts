import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

/** Where a runner keeps what a command must not see: other users' homes, runtime sockets such as Docker's, and scratch disks. */
const HIDDEN = ["/tmp", "/home", "/root", "/run", "/mnt"];

export interface Jail {
  /** work is the directory the command may change, besides home. */
  work: string;
  home: string;
  path: string;
  /** net shares the runner's network, for fetching dependencies before the review. */
  net?: boolean;
}

/**
 * bwrapArgs confines a command with bubblewrap: the machine read-only, its runtime and homes
 * hidden, only work, home and a fresh /tmp writable, no other process visible, an empty
 * environment, and no network unless net is set.
 */
export function bwrapArgs(j: Jail, cwd = j.work): string[] {
  return [
    "--unshare-all", ...(j.net ? ["--share-net"] : []), "--die-with-parent", "--new-session",
    "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc",
    ...HIDDEN.filter((d) => existsSync(d)).flatMap((d) => ["--tmpfs", d]),
    ...(j.net ? ["--ro-bind-try", "/run/systemd/resolve", "/run/systemd/resolve"] : []),
    "--bind", j.home, j.home, "--bind", j.work, j.work, "--chdir", cwd,
    "--clearenv", "--setenv", "PATH", j.path, "--setenv", "HOME", j.home, "--setenv", "TMPDIR", "/tmp", "--setenv", "LANG", "C.UTF-8",
  ];
}

const quote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

/** sandboxed is a shell command line that runs command under bwrapArgs, starting bwrap with only PATH, as its init keeps the environment it started with. */
export const sandboxed = (command: string, j: Jail, cwd = j.work): string =>
  ["exec", "env", "-i", `PATH=${j.path}`, "bwrap", ...bwrapArgs(j, cwd), "bash", "-c", command].map((a, i) => (i < 3 ? a : quote(a))).join(" ");

/** canSandbox reports whether bubblewrap can make its namespaces here. */
export const canSandbox = (): boolean =>
  spawnSync("bwrap", ["--unshare-all", "--ro-bind", "/", "/", "true"], { stdio: "ignore" }).status === 0;
