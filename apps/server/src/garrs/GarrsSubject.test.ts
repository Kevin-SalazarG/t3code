import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  GarrsArtifactId,
  GarrsAttemptId,
  GarrsTaskId,
  GarrsWorkItemId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import { taskFromSpec, type WorkAggregate } from "./GarrsDomain.ts";
import * as Subject from "./GarrsSubject.ts";

const layer = VcsProcess.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);
const now = "2026-10-31T12:00:00.000Z";
const aggregate = (): WorkAggregate => ({
  workItem: {
    id: GarrsWorkItemId.make("work"),
    projectId: ProjectId.make("project"),
    garrasThreadId: ThreadId.make("thread"),
    title: "Diagnose",
    objective: "Find the problem",
    intent: "diagnose",
    access: "read_only",
    status: "active",
    statusReason: null,
    configRevision: 0,
    bindingRevision: 0,
    revision: 1,
    correctionCycles: 0,
    rules: [{ path: "RULES.md", status: "read", sha256: "initial", bytes: 1, readAt: now }],
    workspace: null,
    authorizations: [],
    createdAt: now,
    updatedAt: now,
    deliveredAt: null,
    acceptedAt: null,
  },
  plans: [],
  tasks: [],
  attempts: [],
  artifacts: [],
  reviews: [],
  messages: [],
});

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const vcs = yield* VcsProcess.VcsProcess;
    return yield* vcs.run({ operation: "GarrsSubject.test", command: "git", cwd, args });
  });

describe("GarrsSubject", () => {
  it.effect("verifies that an isolated checkout belongs to the intended repository", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "garrs-checkout-owner-" });
      const first = path.join(root, "first");
      const second = path.join(root, "second");
      const checkout = path.join(root, "checkout");
      for (const repo of [first, second]) {
        yield* fs.makeDirectory(repo);
        yield* git(repo, ["init", "--quiet"]);
        yield* git(repo, [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "--quiet",
          "--allow-empty",
          "-m",
          "base",
        ]);
      }
      yield* git(first, ["worktree", "add", "--quiet", "--detach", checkout]);
      expect(yield* Subject.sameRepository(first, checkout)).toBe(true);
      expect(yield* Subject.sameRepository(second, checkout)).toBe(false);
      expect(yield* Subject.sameRepository(first, path.join(root, "missing"))).toBe(false);
      expect(yield* Subject.repositoryIdentity(path.join(root, "missing"))).toEqual(Option.none());
    }).pipe(Effect.provide(layer)),
  );

  it.effect("binds a cross-project write review to both isolated checkout diffs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "garrs-multi-diff-" });
      const front = path.join(dir, "front");
      const back = path.join(dir, "back");
      const frontCheckout = path.join(dir, "front-worktree");
      const backCheckout = path.join(dir, "back-worktree");
      for (const [root, checkout, rule] of [
        [front, frontCheckout, "RULES.md"],
        [back, backCheckout, "BACK.md"],
      ] as const) {
        yield* fs.makeDirectory(root);
        yield* git(root, ["init", "--quiet"]);
        yield* fs.writeFileString(path.join(root, rule), `${rule} rules`);
        yield* git(root, ["add", "."]);
        yield* git(root, [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "--quiet",
          "-m",
          "base",
        ]);
        yield* git(root, ["worktree", "add", "--quiet", "--detach", checkout]);
      }
      const work = aggregate();
      const other = ProjectId.make("backend");
      const firstBase = (yield* git(front, ["rev-parse", "HEAD"])).stdout.trim();
      const secondBase = (yield* git(back, ["rev-parse", "HEAD"])).stdout.trim();
      const input = {
        ...work,
        workItem: {
          ...work.workItem,
          access: "write" as const,
          rules: yield* Subject.readRules(front, ["RULES.md"]),
          workspace: {
            projectId: work.workItem.projectId,
            checkoutPath: frontCheckout,
            isolated: true,
            baseSha: firstBase,
          },
          projectContexts: [
            {
              projectId: other,
              projectRoot: back,
              bindingRevision: 1,
              rules: yield* Subject.readRules(back, ["BACK.md"]),
              workspace: {
                projectId: other,
                checkoutPath: backCheckout,
                isolated: true,
                baseSha: secondBase,
              },
            },
          ],
        },
      };
      yield* fs.writeFileString(path.join(frontCheckout, "ui.ts"), "frontend change");
      yield* fs.writeFileString(path.join(backCheckout, "api.ts"), "backend change");
      const before = yield* Subject.subjectOf(input, front);
      expect(before.hash).not.toBeNull();
      const scopedTask = taskFromSpec({
        id: GarrsTaskId.make("scoped"),
        workItem: input.workItem,
        planRevision: 1,
        now,
        spec: {
          key: "scoped",
          agentId: "botas",
          title: "Scoped",
          objective: "Inspect input",
          reason: "Owner",
          inputs: [],
          deliverables: ["Evidence"],
          acceptanceCriteria: ["Uses the right project"],
          dependsOn: [],
          capability: "read",
        },
      });
      const firstTaskHash = (yield* Subject.subjectOf({ ...input, tasks: [scopedTask] }, front))
        .hash;
      expect(
        (yield* Subject.subjectOf(
          { ...input, tasks: [{ ...scopedTask, projectId: other }] },
          front,
        )).hash,
      ).not.toBe(firstTaskHash);
      yield* fs.writeFileString(path.join(backCheckout, "api.ts"), "backend changed again");
      expect((yield* Subject.subjectOf(input, front)).hash).not.toBe(before.hash);
      const wrong = {
        ...input,
        workItem: {
          ...input.workItem,
          projectContexts: [
            {
              ...input.workItem.projectContexts[0]!,
              workspace: {
                ...input.workItem.projectContexts[0]!.workspace,
                checkoutPath: frontCheckout,
              },
            },
          ],
        },
      };
      expect((yield* Subject.subjectOf(wrong, front)).hash).toBeNull();
    }).pipe(Effect.provide(layer)),
  );
  it.effect("does not execute external diff, textconv, or fsmonitor commands while reviewing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "garrs-git-helpers-" });
      yield* git(root, ["init", "--quiet"]);
      yield* fs.writeFileString(path.join(root, ".gitattributes"), "*.bin diff=custom\n");
      yield* fs.writeFile(path.join(root, "file.bin"), new Uint8Array([0, 1, 2]));
      yield* git(root, ["add", "."]);
      yield* git(root, [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--quiet",
        "-m",
        "base",
      ]);
      yield* fs.writeFile(path.join(root, "file.bin"), new Uint8Array([0, 1, 3]));
      yield* git(root, ["config", "diff.external", "touch external-ran"]);
      yield* Subject.workspaceState(root, null);
      expect(yield* fs.exists(path.join(root, "external-ran"))).toBe(false);
      yield* git(root, ["config", "--unset", "diff.external"]);
      yield* git(root, ["config", "diff.custom.textconv", "touch textconv-ran; cat"]);
      yield* Subject.workspaceState(root, null);
      expect(yield* fs.exists(path.join(root, "textconv-ran"))).toBe(false);
      yield* fs.writeFileString(
        path.join(root, "monitor"),
        "#!/bin/sh\ntouch monitor-ran\nprintf '\\0'\n",
      );
      yield* fs.chmod(path.join(root, "monitor"), 0o755);
      yield* git(root, ["config", "core.fsmonitor", path.join(root, "monitor")]);
      yield* Subject.workspaceState(root, null);
      expect(yield* fs.exists(path.join(root, "monitor-ran"))).toBe(false);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses oversized rules and untracked files without a partial hash", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "garrs-large-state-" });
      yield* git(root, ["init", "--quiet"]);
      yield* git(root, [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "initial",
      ]);
      const createSparse = (filename: string, size: number) =>
        Effect.scoped(
          Effect.gen(function* () {
            const file = yield* fs.open(path.join(root, filename), { flag: "w" });
            yield* file.truncate(size);
          }),
        );
      yield* createSparse("RULES.md", 256 * 1024 + 1);
      let readCalls = 0;
      const countedFs = FileSystem.FileSystem.of({
        ...fs,
        open: (filename, options) =>
          fs.open(filename, options).pipe(
            Effect.map((file) => ({
              ...file,
              stat: file.stat,
              read: (buffer, readOptions) => {
                readCalls++;
                return file.read(buffer, readOptions);
              },
            })),
          ),
      });
      const [rule] = yield* Subject.readRules(root, ["RULES.md"]).pipe(
        Effect.provideService(FileSystem.FileSystem, countedFs),
      );
      expect(rule).toMatchObject({ status: "truncated", sha256: null });
      expect(readCalls).toBe(0);
      yield* fs.remove(path.join(root, "RULES.md"));
      yield* createSparse("large.bin", 4 * 1024 * 1024 + 1);
      const state = yield* Subject.workspaceState(root, null);
      expect(state.diffHash).toBeNull();
      expect(state.unavailableReason).toContain("4 MiB");
      yield* fs.remove(path.join(root, "large.bin"));
      for (let i = 0; i < 9; i++) yield* createSparse(`file-${i}`, 4 * 1024 * 1024);
      const total = yield* Subject.workspaceState(root, null);
      expect(total.diffHash).toBeNull();
      expect(total.unavailableReason).toContain("32 MiB");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("marks a rule unreadable if it grows while the file is being read", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "garrs-changing-rule-" });
      const filename = path.join(root, "RULES.md");
      yield* fs.writeFileString(filename, "first");
      let changed = false;
      const changingFs = FileSystem.FileSystem.of({
        ...fs,
        open: (filePath, options) =>
          fs.open(filePath, options).pipe(
            Effect.map((file) => ({
              ...file,
              stat: file.stat,
              read: (buffer, readOptions) =>
                file.read(buffer, readOptions).pipe(
                  Effect.tap(() => {
                    if (changed) return Effect.void;
                    changed = true;
                    return fs.writeFileString(filename, "x".repeat(256 * 1024 + 1));
                  }),
                ),
            })),
          ),
      });
      const [rule] = yield* Subject.readRules(root, ["RULES.md"]).pipe(
        Effect.provideService(FileSystem.FileSystem, changingFs),
      );
      expect(rule).toMatchObject({ status: "unreadable", sha256: null });
    }).pipe(Effect.provide(layer)),
  );
  it.effect("binds a read-only review to both project checkouts and their own rules", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "garrs-multiple-projects-" });
      const frontend = path.join(root, "frontend");
      const backend = path.join(root, "backend");
      yield* fs.makeDirectory(frontend);
      yield* fs.makeDirectory(backend);
      for (const dir of [frontend, backend]) {
        yield* git(dir, ["init", "--quiet"]);
        yield* git(dir, [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "--quiet",
          "--allow-empty",
          "-m",
          "base",
        ]);
      }
      yield* fs.writeFileString(path.join(frontend, "RULES.md"), "frontend rules");
      yield* fs.writeFileString(path.join(backend, "BACKEND.md"), "backend rules");
      yield* fs.writeFileString(path.join(backend, "api.ts"), "first");
      const work = aggregate();
      const secondary = ProjectId.make("backend");
      const primaryState = yield* Subject.workspaceState(frontend, null);
      const backendState = yield* Subject.workspaceState(backend, null);
      const primaryRules = yield* Subject.readRules(frontend, ["RULES.md"]);
      const backendRules = yield* Subject.readRules(backend, ["BACKEND.md"]);
      const input = {
        ...work,
        workItem: {
          ...work.workItem,
          rules: primaryRules,
          readOnlyBaseline: { headSha: primaryState.headSha!, diffHash: primaryState.diffHash! },
          projectContexts: [
            {
              projectId: secondary,
              bindingRevision: 1,
              rules: backendRules,
              baselineDiffHash: backendState.diffHash!,
              workspace: {
                projectId: secondary,
                checkoutPath: backend,
                isolated: false,
                baseSha: backendState.headSha,
              },
            },
          ],
        },
      };
      const first = yield* Subject.subjectOf(input, frontend);
      expect(first.hash).not.toBeNull();
      yield* fs.writeFileString(path.join(backend, "api.ts"), "changed");
      const changedFile = yield* Subject.subjectOf(input, frontend);
      expect(changedFile.hash).toBeNull();
      yield* fs.writeFileString(path.join(backend, "api.ts"), "first");
      yield* fs.writeFileString(path.join(backend, "BACKEND.md"), "changed rule");
      expect((yield* Subject.subjectOf(input, frontend)).hash).toBeNull();
      yield* fs.remove(path.join(backend, "BACKEND.md"));
      const removed = yield* Subject.subjectOf(input, frontend);
      expect(removed.hash).toBeNull();
      yield* fs.makeDirectory(path.join(backend, "BACKEND.md"));
      expect((yield* Subject.subjectOf(input, frontend)).hash).toBeNull();
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "binds a diagnosis to its actual rules and request, and refuses unavailable rules",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "garrs-subject-" });
        yield* git(root, ["init", "--quiet"]);
        yield* git(root, [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "--quiet",
          "--allow-empty",
          "-m",
          "base",
        ]);
        const rule = path.join(root, "RULES.md");
        yield* fs.writeFileString(rule, "first rule");
        const work = aggregate();
        const original = yield* Subject.subjectOf(work, root);
        expect(original.hash).not.toBeNull();
        const helper = {
          ...taskFromSpec({
            id: GarrsTaskId.make("helper"),
            workItem: work.workItem,
            planRevision: 1,
            now,
            spec: {
              key: "helper-1",
              agentId: "copito",
              title: "Helper",
              objective: "Inspect evidence",
              reason: "Independent check",
              inputs: [],
              deliverables: ["Result"],
              acceptanceCriteria: ["Evidence"],
              dependsOn: [],
              capability: "read",
            },
          }),
          helper: {
            parentTaskId: GarrsTaskId.make("review"),
            parentAttemptId: GarrsAttemptId.make("review-attempt"),
            deadline: now,
          },
        };
        const withHelper = {
          ...work,
          tasks: [helper],
          artifacts: [
            {
              id: GarrsArtifactId.make("helper-result"),
              workItemId: work.workItem.id,
              taskId: helper.id,
              attemptId: GarrsAttemptId.make("helper-attempt"),
              agentId: "copito" as const,
              kind: "diagnosis" as const,
              summary: "Evidence",
              body: "Independent result",
              evidence: [],
              contentHash: "result",
              workspace: null,
              createdAt: now,
            },
          ],
        };
        expect((yield* Subject.subjectOf(withHelper, root)).hash).toBe(original.hash);
        yield* fs.writeFileString(path.join(root, "code.ts"), "one");
        const changedFile = yield* Subject.subjectOf(work, root);
        expect(changedFile.hash).not.toBe(original.hash);
        yield* fs.remove(path.join(root, "code.ts"));
        const changedRequest = yield* Subject.subjectOf(
          { ...work, workItem: { ...work.workItem, objective: "Another request" } },
          root,
        );
        expect(changedRequest.hash).not.toBe(original.hash);
        yield* fs.writeFileString(rule, "changed rule");
        const modified = yield* Subject.subjectOf(work, root);
        expect(modified.hash).not.toBe(original.hash);
        yield* fs.remove(rule);
        const missing = yield* Subject.subjectOf(work, root);
        expect(missing.hash).not.toBeNull();
        expect(missing.hash).not.toBe(modified.hash);
        expect((yield* Subject.subjectOf(work, root)).hash).toBe(missing.hash);
        yield* fs.makeDirectory(rule);
        expect((yield* Subject.subjectOf(work, root)).hash).toBeNull();
        expect((yield* Subject.subjectOf(work, null)).hash).toBeNull();
      }).pipe(Effect.provide(layer)),
  );

  it.effect("does not approve an incomplete checkout and includes every untracked file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "garrs-workspace-" });
      yield* git(root, ["init", "--quiet"]);
      yield* git(root, [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "initial",
      ]);
      const vcs = yield* VcsProcess.VcsProcess;
      for (const part of ["diff", "--name-only", "--raw", "ls-files"]) {
        const truncated = yield* Subject.workspaceState(root, null).pipe(
          Effect.provideService(
            VcsProcess.VcsProcess,
            VcsProcess.VcsProcess.of({
              run: (input) =>
                vcs.run(input).pipe(
                  Effect.map((output) => ({
                    ...output,
                    stdoutTruncated:
                      part === "diff" ? input.args.includes("--binary") : input.args.includes(part),
                  })),
                ),
            }),
          ),
        );
        expect(truncated.diffHash).toBeNull();
      }
      yield* fs.writeFileString(path.join(root, "new file.txt"), "one");
      const first = yield* Subject.workspaceState(root, null);
      expect(first.diffHash).not.toBeNull();
      yield* fs.writeFileString(path.join(root, "new file.txt"), "two");
      expect((yield* Subject.workspaceState(root, null)).diffHash).not.toBe(first.diffHash);
      yield* fs.symlink("missing-target", path.join(root, "link"));
      const link = yield* Subject.workspaceState(root, null);
      expect(link.diffHash).not.toBeNull();
      yield* fs.remove(path.join(root, "link"));
      yield* fs.symlink("another-target", path.join(root, "link"));
      expect((yield* Subject.workspaceState(root, null)).diffHash).not.toBe(link.diffHash);
      yield* Effect.forEach(
        Array.from({ length: 2_000 }, (_, i) => i),
        (i) => fs.writeFileString(path.join(root, `file-${i}`), "x"),
        { concurrency: 32, discard: true },
      );
      const tooMany = yield* Subject.workspaceState(root, null);
      expect(tooMany.diffHash).toBeNull();
      expect(tooMany.unavailableReason).toContain("2,000");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rejects Git index flags that can hide modified tracked files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "garrs-index-flags-" });
      yield* git(root, ["init", "--quiet"]);
      yield* fs.writeFileString(path.join(root, "tracked.txt"), "original");
      yield* git(root, ["add", "tracked.txt"]);
      yield* git(root, [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--quiet",
        "-m",
        "base",
      ]);
      yield* fs.writeFileString(path.join(root, "tracked.txt"), "hidden change");
      yield* git(root, ["update-index", "--assume-unchanged", "tracked.txt"]);
      const assume = yield* Subject.workspaceState(root, null);
      expect(assume.diffHash).toBeNull();
      expect(assume.unavailableReason).toContain("index flags");
      yield* git(root, ["update-index", "--no-assume-unchanged", "tracked.txt"]);
      yield* git(root, ["update-index", "--skip-worktree", "tracked.txt"]);
      expect((yield* Subject.workspaceState(root, null)).diffHash).toBeNull();
      yield* git(root, ["update-index", "--no-skip-worktree", "tracked.txt"]);
      expect((yield* Subject.workspaceState(root, null)).diffHash).not.toBeNull();
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "refuses a changed submodule whose complete content Git's outer diff cannot prove",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "garrs-submodule-" });
        const source = path.join(root, "source");
        const checkout = path.join(root, "checkout");
        yield* fs.makeDirectory(source);
        yield* fs.makeDirectory(checkout);
        for (const repository of [source, checkout]) {
          yield* git(repository, ["init", "--quiet"]);
          yield* git(repository, [
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "--quiet",
            "--allow-empty",
            "-m",
            "initial",
          ]);
        }
        yield* git(checkout, [
          "-c",
          "protocol.file.allow=always",
          "submodule",
          "add",
          "--quiet",
          source,
          "nested",
        ]);
        yield* git(checkout, [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "--quiet",
          "-am",
          "submodule",
        ]);
        expect((yield* Subject.workspaceState(checkout, null)).diffHash).not.toBeNull();
        yield* fs.writeFileString(path.join(checkout, "nested", "untracked"), "dirty");
        const dirty = yield* Subject.workspaceState(checkout, null);
        expect(dirty.diffHash).toBeNull();
        expect(dirty.unavailableReason).toContain("submodule");
      }).pipe(Effect.provide(layer)),
  );
});
