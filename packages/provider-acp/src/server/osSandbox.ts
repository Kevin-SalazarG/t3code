// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/**
 * Operating-system write confinement for one ACP agent process and everything it spawns.
 * The agent keeps network access: model APIs need it, and Seatbelt cannot allow by host name.
 */
export interface AcpOsSandbox {
  /** Directories the agent may modify, such as an isolated checkout. */
  readonly writableRoots: ReadonlyArray<string>;
  /** Never writable, overriding every allowance (projects, Git metadata). */
  readonly protectedRoots: ReadonlyArray<string>;
  /** Not writable, except agent state directories declared strictly inside them (the T3 home). */
  readonly stateRoots: ReadonlyArray<string>;
}

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

// Credential stores, other agents' state and startup paths that grant persistence.
const SENSITIVE_HOME_ENTRIES = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  ".config/gh",
  ".config/git",
  ".claude",
  ".codex",
  ".local/bin",
  ".oh-my-zsh",
];

const STATE_ENV_NAME = /^(?:TMPDIR|TEMP|TMP|XDG_[A-Z_]+_HOME|[A-Z][A-Z0-9_]*_(?:HOME|DIR))$/;

/** Resolve symlinks of the existing prefix; Seatbelt matches canonical paths. */
function canonicalSandboxPath(path: string): string | undefined {
  if (!NodePath.isAbsolute(path)) return undefined;
  const suffix: Array<string> = [];
  let candidate = NodePath.resolve(path);
  while (true) {
    try {
      return NodePath.join(NodeFS.realpathSync.native(candidate), ...suffix);
    } catch {
      const parent = NodePath.dirname(candidate);
      if (parent === candidate) return undefined;
      suffix.unshift(NodePath.basename(candidate));
      candidate = parent;
    }
  }
}

const within = (path: string, root: string) => {
  const relative = NodePath.relative(root, path);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
};
const strictlyWithin = (path: string, root: string) => path !== root && within(path, root);

const quote = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\/"]/g, "\\$&");
const subpaths = (paths: ReadonlyArray<string>) => paths.map((path) => `(subpath ${quote(path)})`);

function canonicalAll(paths: ReadonlyArray<string>): Array<string> {
  return [
    ...new Set(paths.flatMap((path) => canonicalSandboxPath(path) ?? [])).values(),
  ].toSorted();
}

/**
 * Seatbelt rules are last-match-wins: home is closed, hidden state directories reopen,
 * sensitive paths close again, declared state and writable roots reopen, protected roots close.
 */
export function buildSeatbeltProfile(input: {
  readonly sandbox: AcpOsSandbox;
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
}): string {
  const home = canonicalSandboxPath(input.home);
  if (home === undefined || home === "/") throw new Error("Cannot resolve the home directory.");
  const protectedRoots = canonicalAll(input.sandbox.protectedRoots);
  const writableRoots = canonicalAll(input.sandbox.writableRoots).filter(
    (root) => root !== "/" && !protectedRoots.some((entry) => within(root, entry)),
  );
  const pathEntries = (input.env.PATH ?? "")
    .split(NodePath.delimiter)
    .filter((entry) => NodePath.isAbsolute(entry));
  const sensitive = canonicalAll([
    ...canonicalAll([
      ...SENSITIVE_HOME_ENTRIES.map((entry) => NodePath.join(home, entry)),
      ...pathEntries,
    ]).filter((entry) => strictlyWithin(entry, home)),
    ...input.sandbox.stateRoots,
  ]);
  const stateDirectories = canonicalAll(
    Object.entries(input.env).flatMap(([name, value]) =>
      STATE_ENV_NAME.test(name) && typeof value === "string" ? [value] : [],
    ),
  ).filter(
    (entry) =>
      entry !== "/" &&
      !within(home, entry) &&
      !sensitive.some((root) => within(root, entry)) &&
      !protectedRoots.some((root) => within(root, entry) || within(entry, root)),
  );
  return [
    "(version 1)",
    "(allow default)",
    `(deny file-write* (subpath ${quote(home)}))`,
    `(allow file-write* (regex #"^${escapeRegex(home)}/\\.[^/]+/") (subpath ${quote(NodePath.join(home, "Library/Caches"))}))`,
    ...(sensitive.length === 0 ? [] : [`(deny file-write* ${subpaths(sensitive).join(" ")})`]),
    ...(stateDirectories.length === 0
      ? []
      : [`(allow file-write* ${subpaths(stateDirectories).join(" ")})`]),
    ...(writableRoots.length === 0
      ? []
      : [`(allow file-write* ${subpaths(writableRoots).join(" ")})`]),
    ...(protectedRoots.length === 0
      ? []
      : [`(deny file-write* ${subpaths(protectedRoots).join(" ")})`]),
  ].join("\n");
}

export function wrapCommandForOsSandbox(input: {
  readonly sandbox: AcpOsSandbox;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  readonly platform: NodeJS.Platform;
}): { readonly command: string; readonly args: ReadonlyArray<string> } {
  if (input.platform !== "darwin") {
    throw new Error("Operating-system confinement for ACP agents is available only on macOS.");
  }
  if (!NodeFS.existsSync(SANDBOX_EXEC)) throw new Error("macOS sandbox-exec is unavailable.");
  const profile = buildSeatbeltProfile({
    sandbox: input.sandbox,
    env: input.env,
    home: input.home,
  });
  return { command: SANDBOX_EXEC, args: ["-p", profile, input.command, ...input.args] };
}
