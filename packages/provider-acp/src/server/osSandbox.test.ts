// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { buildSeatbeltProfile, SANDBOX_EXEC, wrapCommandForOsSandbox } from "./osSandbox.ts";

function fixture() {
  const home = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "acp-sb-")));
  const dirs = {
    home,
    project: NodePath.join(home, "Documents/project"),
    checkout: NodePath.join(home, ".t3/worktrees/project-garrs"),
    gitCommon: NodePath.join(home, "Documents/project/.git"),
    t3Home: NodePath.join(home, ".t3"),
    agentState: NodePath.join(home, ".t3/userdata/providers/agent"),
    hiddenState: NodePath.join(home, ".kimi"),
    ssh: NodePath.join(home, ".ssh"),
    pathBin: NodePath.join(home, ".npm-global/bin"),
  };
  for (const dir of Object.values(dirs)) NodeFS.mkdirSync(dir, { recursive: true });
  return dirs;
}

function canWrite(profile: string, file: string): boolean {
  const result = NodeChildProcess.spawnSync(
    "/usr/bin/sandbox-exec",
    ["-p", profile, "/bin/sh", "-c", 'echo x > "$1"', "sh", file],
    { encoding: "utf8" },
  );
  return result.status === 0;
}

describe("ACP operating-system sandbox", () => {
  it("keeps protected roots closed even inside a writable root", () => {
    const dirs = fixture();
    const profile = buildSeatbeltProfile({
      home: dirs.home,
      env: { PATH: `${dirs.pathBin}:/usr/bin`, AGENT_HOME: dirs.agentState, HOME: dirs.home },
      sandbox: {
        writableRoots: [dirs.project],
        protectedRoots: [dirs.gitCommon],
        stateRoots: [dirs.t3Home],
      },
    });
    expect(profile).toContain(`(allow file-write* (subpath "${dirs.agentState}"))`);
    expect(profile).not.toContain(`(allow file-write* (subpath "${dirs.home}"))`);
    expect(profile.trimEnd().endsWith(`(deny file-write* (subpath "${dirs.gitCommon}"))`)).toBe(
      true,
    );
  });

  // Seatbelt is macOS-only; elsewhere this proves nothing about enforcement.
  it.runIf(NodeFS.existsSync(SANDBOX_EXEC))(
    "confines a read-only member's process tree to agent state outside the project",
    () => {
      const dirs = fixture();
      const env = { PATH: `${dirs.pathBin}:/usr/bin:/bin`, AGENT_HOME: dirs.agentState };
      const readOnly = buildSeatbeltProfile({
        home: dirs.home,
        env,
        sandbox: {
          writableRoots: [],
          protectedRoots: [dirs.project],
          stateRoots: [dirs.t3Home],
        },
      });
      expect(canWrite(readOnly, NodePath.join(dirs.project, "a.txt"))).toBe(false);
      expect(canWrite(readOnly, NodePath.join(dirs.home, "Documents/other.txt"))).toBe(false);
      expect(canWrite(readOnly, NodePath.join(dirs.home, ".zshrc"))).toBe(false);
      expect(canWrite(readOnly, NodePath.join(dirs.ssh, "authorized_keys"))).toBe(false);
      expect(canWrite(readOnly, NodePath.join(dirs.pathBin, "git"))).toBe(false);
      expect(canWrite(readOnly, NodePath.join(dirs.t3Home, "state.sqlite"))).toBe(false);
      expect(canWrite(readOnly, NodePath.join(dirs.checkout, "a.txt"))).toBe(false);
      expect(canWrite(readOnly, NodePath.join(dirs.agentState, "session.json"))).toBe(true);
      expect(canWrite(readOnly, NodePath.join(dirs.hiddenState, "log.txt"))).toBe(true);

      const writer = buildSeatbeltProfile({
        home: dirs.home,
        env,
        sandbox: {
          writableRoots: [dirs.checkout],
          protectedRoots: [dirs.project, NodePath.join(dirs.checkout, ".git")],
          stateRoots: [dirs.t3Home],
        },
      });
      expect(canWrite(writer, NodePath.join(dirs.checkout, "src.ts"))).toBe(true);
      NodeFS.mkdirSync(NodePath.join(dirs.checkout, ".git"));
      expect(canWrite(writer, NodePath.join(dirs.checkout, ".git/config"))).toBe(false);
      expect(canWrite(writer, NodePath.join(dirs.project, "src.ts"))).toBe(false);
    },
  );

  it("refuses to launch unconfined where Seatbelt is unavailable", () => {
    expect(() =>
      wrapCommandForOsSandbox({
        sandbox: { writableRoots: [], protectedRoots: [], stateRoots: [] },
        command: "agent",
        args: [],
        env: {},
        home: "/home/user",
        platform: "linux",
      }),
    ).toThrow("only on macOS");
  });
});
