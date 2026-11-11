import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SyncDaemon } from "../index.js";
import { config } from "../config.js";
import { isVersionCompatible } from "../util/versionUtils.js";

// Fork regressions run against synthetic Studio messages on an ephemeral port;
// they never connect to Studio or touch a consumer project's files/config.
async function withFolderBackedDaemon(
  run: (daemon: any, tmp: string, sent: any[]) => Promise<void>,
) {
  const tmp = makeTempDir("azul-folder-backed-");
  const previous = { ...config };
  let daemon: SyncDaemon | undefined;
  try {
    Object.assign(config, {
      syncDir: tmp,
      sourcemapPath: path.join(tmp, "sourcemap.json"),
      port: 0,
      folderBackedScriptsWithChildren: true,
      liveFsSync: { ...config.liveFsSync, enabled: true },
    });
    daemon = new SyncDaemon();
    const sent: any[] = [];
    (daemon as any).ipc.send = (message: any) => {
      sent.push(message);
      return true;
    };
    await run(daemon, tmp, sent);
  } finally {
    await daemon?.stop();
    Object.assign(config, previous);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function folderBackedSnapshot(daemon: any, className = "ModuleScript") {
  daemon.tree.applyFullSnapshot([
    {
      guid: "rs",
      className: "ReplicatedStorage",
      name: "ReplicatedStorage",
      path: ["ReplicatedStorage"],
    },
    {
      guid: "parent",
      className,
      name: "Parent",
      path: ["ReplicatedStorage", "Parent"],
      parentGuid: "rs",
      source: "return {}",
    },
    {
      guid: "child",
      className: "ModuleScript",
      name: "Child",
      path: ["ReplicatedStorage", "Parent", "Child"],
      parentGuid: "parent",
      source: "return 1",
    },
    {
      guid: "part",
      className: "Part",
      name: "Part",
      path: ["ReplicatedStorage", "Parent", "Part"],
      parentGuid: "parent",
    },
  ]);
  daemon.fileWriter.writeTree(daemon.tree.getAllNodes());
  daemon.recordInodes();
  daemon.regenerateSourcemap();
}

test("folder-backed export supports all script classes, suffixes and Lua extensions", async () => {
  await withFolderBackedDaemon(async (daemon, tmp) => {
    for (const extension of [".luau", ".lua"]) {
      config.scriptExtension = extension;
      for (const [className, suffix, moduleSuffix] of [
        ["ModuleScript", "", false],
        ["ModuleScript", ".module", true],
        ["Script", ".server", false],
        ["LocalScript", ".client", false],
      ] as const) {
        config.suffixModuleScripts = moduleSuffix;
        folderBackedSnapshot(daemon, className);
        const initPath = path.join(
          tmp,
          "ReplicatedStorage",
          "Parent",
          `init${suffix}${extension}`,
        );
        assert.equal(daemon.fileWriter.getMapping("parent").filePath, initPath);
        assert.equal(fs.readFileSync(initPath, "utf8"), "return {}");
        assert.equal(daemon.fileWriter.getGuidByPath(initPath), "parent");
        const entry = findInSourcemap(readSourcemap(), [
          "ReplicatedStorage",
          "Parent",
        ]);
        assert.equal(entry.className, className);
        assert.ok(
          entry.filePaths.some((p: string) =>
            p.endsWith(`init${suffix}${extension}`),
          ),
        );
      }
    }
  });
});

test("folder-backed layout updates script ancestors through non-script containers", async () => {
  await withFolderBackedDaemon(async (daemon, tmp, sent) => {
    folderBackedSnapshot(daemon);
    daemon.handleDeleted({ guid: "child" });
    const parentDir = path.join(tmp, "ReplicatedStorage", "Parent");
    // Explicit init layout remains stable when the last script child is removed.
    assert.ok(fs.existsSync(path.join(parentDir, "init.luau")));
    daemon.handleInstanceUpdated({
      guid: "container",
      className: "Folder",
      name: "Container",
      path: ["ReplicatedStorage", "Parent", "Container"],
      parentGuid: "parent",
    });
    daemon.handleInstanceUpdated({
      guid: "nested",
      className: "ModuleScript",
      name: "Nested",
      path: ["ReplicatedStorage", "Parent", "Container", "Nested"],
      parentGuid: "container",
      source: "return 2",
    });
    assert.ok(fs.existsSync(path.join(parentDir, "Container", "Nested.luau")));
    daemon.handleFileChange(path.join(parentDir, "init.luau"), "return 3");
    assert.ok(
      sent.some(
        (m) =>
          m.type === "patchScript" &&
          m.guid === "parent" &&
          m.source === "return 3",
      ),
    );
    await readSettledSourcemap();
    assert.equal(
      findInSourcemap(readSourcemap(), ["ReplicatedStorage", "Parent"])
        .className,
      "ModuleScript",
    );
  });
});

test("new init files target the containing instance and do not create an init child or duplicate Folder", async () => {
  await withFolderBackedDaemon(async (daemon, tmp, sent) => {
    for (const [fileName, className] of [
      ["init.luau", "ModuleScript"],
      ["init.module.lua", "ModuleScript"],
      ["init.server.luau", "Script"],
      ["init.client.lua", "LocalScript"],
    ]) {
      const dir = path.join(tmp, "ReplicatedStorage", className + fileName);
      fs.mkdirSync(dir, { recursive: true });
      const init = path.join(dir, fileName);
      fs.writeFileSync(init, "return {}");
      sent.length = 0;
      daemon.handleDirAdd(dir);
      daemon.handleFileAdd(init, "return {}");
      assert.deepEqual(sent, [
        {
          type: "createInstance",
          className,
          name: path.basename(dir),
          parentPath: ["ReplicatedStorage"],
          source: "return {}",
        },
      ]);
    }
    sent.length = 0;
    daemon.handleFileAdd(path.join(tmp, "init.luau"), "return {}");
    assert.equal(
      sent.length,
      0,
      "root init must not create or replace a service",
    );
  });
});

for (const fileFirst of [false, true]) {
  test(`folder-backed directory move preserves GUIDs, Parts, mappings and edits (${fileFirst ? "file" : "directory"} add first)`, async () => {
    await withFolderBackedDaemon(async (daemon, tmp, sent) => {
      folderBackedSnapshot(daemon);
      const oldDir = path.join(tmp, "ReplicatedStorage", "Parent");
      const newDir = path.join(tmp, "ReplicatedStorage", "Renamed");
      const oldInit = path.join(oldDir, "init.luau");
      fs.renameSync(oldDir, newDir);
      daemon.handleFileDelete(path.join(oldDir, "Child.luau"));
      daemon.handleFileDelete(oldInit);
      daemon.handleDirDelete(oldDir);
      if (fileFirst)
        daemon.handleFileAdd(path.join(newDir, "init.luau"), "return {}");
      daemon.handleDirAdd(newDir);
      if (!fileFirst)
        daemon.handleFileAdd(path.join(newDir, "init.luau"), "return {}");
      assert.equal(sent.filter((m) => m.type === "moveInstance").length, 1);
      assert.equal(sent.filter((m) => m.type === "createInstance").length, 0);
      assert.deepEqual(daemon.tree.getNode("part").path, [
        "ReplicatedStorage",
        "Renamed",
        "Part",
      ]);
      assert.equal(
        daemon.fileWriter.getMapping("parent").filePath,
        path.join(newDir, "init.luau"),
      );
      const childPath = path.join(newDir, "Child.luau");
      assert.equal(daemon.fileWriter.getGuidByPath(childPath), "child");
      daemon.handleFileChange(childPath, "return 4");
      assert.ok(
        sent.some((m) => m.type === "patchScript" && m.guid === "child"),
      );
      await wait(650);
      assert.equal(sent.filter((m) => m.type === "deleteInstance").length, 0);
      assert.ok(daemon.tree.getNode("part"));
    });
  });
}

test("renaming an init suffix changes class without moving to an init child", async () => {
  await withFolderBackedDaemon(async (daemon, tmp, sent) => {
    folderBackedSnapshot(daemon);
    const dir = path.join(tmp, "ReplicatedStorage", "Parent");
    const oldInit = path.join(dir, "init.luau");
    const newInit = path.join(dir, "init.server.luau");
    fs.renameSync(oldInit, newInit);
    daemon.handleFileDelete(oldInit);
    daemon.handleFileAdd(newInit, "print(1)");
    const move = sent.find((m) => m.type === "moveInstance");
    assert.equal(move.guid, "parent");
    assert.equal(move.name, "Parent");
    assert.equal(move.className, "Script");
    assert.deepEqual(move.parentPath, ["ReplicatedStorage"]);
    assert.equal(daemon.fileWriter.getGuidByPath(newInit), "parent");
    assert.ok(daemon.tree.getNode("part"));
  });
});

test("removing only init demotes to Folder without destroying descendants", async () => {
  await withFolderBackedDaemon(async (daemon, tmp, sent) => {
    folderBackedSnapshot(daemon);
    const init = path.join(tmp, "ReplicatedStorage", "Parent", "init.luau");
    fs.unlinkSync(init);
    daemon.handleFileDelete(init);
    await wait(650);
    assert.equal(sent.filter((m) => m.type === "deleteInstance").length, 0);
    assert.ok(
      sent.some(
        (m) =>
          m.type === "moveInstance" &&
          m.guid === "parent" &&
          m.className === "Folder",
      ),
    );
    assert.equal(daemon.tree.getNode("parent").className, "Folder");
    assert.ok(daemon.tree.getNode("part"));
    assert.ok(daemon.tree.getNode("child"));
    assert.equal(daemon.fileWriter.getMapping("parent"), undefined);
  });
});

function makeTempDir(prefix = "azul-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Walk a generated sourcemap tree by exact DataModel path (from the root). */
function findInSourcemap(root: any, pathSegments: string[]): any {
  let current = root;
  for (const segment of pathSegments) {
    if (!current || !Array.isArray(current.children)) return undefined;
    current = current.children.find((c: any) => c.name === segment);
  }
  return current;
}

function readSourcemap(): any {
  return JSON.parse(fs.readFileSync(config.sourcemapPath, "utf8"));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read the sourcemap once the daemon's coalesced write has landed. */
async function readSettledSourcemap(): Promise<any> {
  await wait(250);
  return readSourcemap();
}

test("atomic init replacement is an edit, not a delayed Folder demotion", async () => {
  await withFolderBackedDaemon(async (daemon, tmp, sent) => {
    folderBackedSnapshot(daemon);
    const init = path.join(tmp, "ReplicatedStorage", "Parent", "init.luau");
    fs.unlinkSync(init);
    daemon.handleFileDelete(init);
    fs.writeFileSync(init, "return 5");
    daemon.handleFileAdd(init, "return 5");
    daemon.handleFileChange(init, "return 5");
    await wait(650);
    assert.equal(daemon.tree.getNode("parent").className, "ModuleScript");
    assert.equal(fs.readFileSync(init, "utf8"), "return 5");
    assert.equal(
      sent.filter(
        (m) => m.type === "moveInstance" || m.type === "deleteInstance",
      ).length,
      0,
    );
  });
});

test("live watcher suppresses Studio layout promotion echoes and follows folder-backed moves", async () => {
  await withFolderBackedDaemon(async (daemon, tmp, sent) => {
    folderBackedSnapshot(daemon);
    daemon.fileWatcher.watch(tmp);
    await new Promise<void>((resolve) =>
      daemon.fileWatcher.watcher.once("ready", resolve),
    );
    // Drop initial pre-watch directory suppressions before exercising real events.
    await wait(1100);
    const dir = path.join(tmp, "ReplicatedStorage", "Parent");
    const renamed = path.join(tmp, "ReplicatedStorage", "Moved");
    fs.renameSync(dir, renamed);
    await wait(1400);
    assert.equal(
      sent.filter((m) => m.type === "moveInstance" && m.guid === "parent")
        .length,
      1,
    );
    assert.equal(sent.filter((m) => m.type === "createInstance").length, 0);
    assert.ok(daemon.tree.getNode("part"));
    assert.deepEqual(daemon.tree.getNode("parent").path, [
      "ReplicatedStorage",
      "Moved",
    ]);
    sent.length = 0;
    fs.writeFileSync(path.join(renamed, "Child.luau"), "return 6");
    await wait(600);
    assert.ok(
      sent.some(
        (m) =>
          m.type === "patchScript" &&
          m.guid === "child" &&
          m.source === "return 6",
      ),
    );

    // An upstream instance notification creates a script descendant through a
    // Folder under a flat script, promoting that ancestor to init layout.
    daemon.handleInstanceUpdated({
      guid: "flat",
      className: "ModuleScript",
      name: "Flat",
      path: ["ReplicatedStorage", "Flat"],
      parentGuid: "rs",
      source: "return {}",
    });
    await wait(600);
    sent.length = 0;
    daemon.handleInstanceUpdated({
      guid: "nestedFolder",
      className: "Folder",
      name: "Nested",
      path: ["ReplicatedStorage", "Flat", "Nested"],
      parentGuid: "flat",
    });
    daemon.handleInstanceUpdated({
      guid: "nestedScript",
      className: "ModuleScript",
      name: "Child",
      path: ["ReplicatedStorage", "Flat", "Nested", "Child"],
      parentGuid: "nestedFolder",
      source: "return 7",
    });
    await wait(900);
    assert.ok(
      fs.existsSync(path.join(tmp, "ReplicatedStorage", "Flat", "init.luau")),
    );
    assert.equal(
      fs.existsSync(path.join(tmp, "ReplicatedStorage", "Flat.luau")),
      false,
    );
    assert.equal(
      sent.filter((m) =>
        ["createInstance", "deleteInstance", "moveInstance"].includes(m.type),
      ).length,
      0,
      "daemon writes must not echo as structural edits",
    );
  });
});

test("orphan cleanup preserves non-script files and honors per-place overrides with init layouts", async () => {
  await withFolderBackedDaemon(async (daemon, tmp) => {
    folderBackedSnapshot(daemon);
    const dir = path.join(tmp, "ReplicatedStorage", "Parent");
    for (const file of ["AGENTS.md", "asset.json", "notes.txt", "image.png"]) {
      fs.writeFileSync(path.join(dir, file), "keep me");
    }
    for (const file of ["orphan.lua", "orphan.luau", "orphan.server.luau"]) {
      fs.writeFileSync(path.join(dir, file), "remove me");
    }
    config.deleteOrphansOnConnect = false;
    daemon.applyPlaceConfig({ deleteOrphansOnConnect: true });
    daemon.cleanupOrphanFiles();
    for (const file of ["AGENTS.md", "asset.json", "notes.txt", "image.png"]) {
      assert.equal(fs.readFileSync(path.join(dir, file), "utf8"), "keep me");
    }
    for (const file of ["orphan.lua", "orphan.luau", "orphan.server.luau"]) {
      assert.equal(fs.existsSync(path.join(dir, file)), false);
    }
    assert.equal(
      fs.readFileSync(path.join(dir, "init.luau"), "utf8"),
      "return {}",
    );
    assert.equal(
      fs.readFileSync(path.join(dir, "Child.luau"), "utf8"),
      "return 1",
    );
    config.deleteOrphansOnConnect = true;
    daemon.applyPlaceConfig({ deleteOrphansOnConnect: false });
    fs.writeFileSync(path.join(dir, "orphan.luau"), "keep this too");
    daemon.cleanupOrphanFiles();
    assert.ok(fs.existsSync(path.join(dir, "orphan.luau")));
  });
});

test("fullSnapshot writes scripts, generates sourcemap, and removes orphans", async () => {
  const tmp = makeTempDir();
  const prevSyncDir = config.syncDir;
  const prevSourcemapPath = config.sourcemapPath;
  const prevPort = config.port;
  const prevDeleteOrphansOnConnect = config.deleteOrphansOnConnect;
  let daemon: SyncDaemon | undefined;
  try {
    // Configure daemon to use our temp dir and an ephemeral port
    config.syncDir = tmp;
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;
    config.deleteOrphansOnConnect = true;

    // Create an orphan file that should be removed on snapshot
    const orphanDir = path.join(tmp, "extra");
    fs.mkdirSync(orphanDir, { recursive: true });
    const orphanPath = path.join(orphanDir, "orphan.luau");
    fs.writeFileSync(orphanPath, "print('i am orphan')", "utf8");
    const notesPath = path.join(orphanDir, "AGENTS.md");
    fs.writeFileSync(notesPath, "preserve instructions", "utf8");
    assert.ok(fs.existsSync(orphanPath), "orphan created");

    daemon = new SyncDaemon();

    const instances = [
      {
        guid: "r1",
        className: "Folder",
        name: "ReplicatedStorage",
        path: ["ReplicatedStorage"],
      },
      {
        guid: "m1",
        className: "Folder",
        name: "Modules",
        path: ["ReplicatedStorage", "Modules"],
      },
      {
        guid: "s1",
        className: "ModuleScript",
        name: "Foo",
        path: ["ReplicatedStorage", "Modules", "Foo"],
        source: "print('hello')",
      },
    ];

    // Send full snapshot
    (daemon as any).handleStudioMessage({
      type: "fullSnapshot",
      data: instances,
    });

    const expectedFile = path.join(
      tmp,
      "ReplicatedStorage",
      "Modules",
      "Foo.luau",
    );
    assert.ok(fs.existsSync(expectedFile), "script file was written");

    assert.ok(fs.existsSync(config.sourcemapPath), "sourcemap was generated");
    const sourcemap = JSON.parse(fs.readFileSync(config.sourcemapPath, "utf8"));
    assert.strictEqual(sourcemap.name, "Game");

    // Orphan file should have been removed
    assert.strictEqual(fs.existsSync(orphanPath), false, "orphan file removed");
    assert.equal(fs.readFileSync(notesPath, "utf8"), "preserve instructions");
  } finally {
    await daemon?.stop();
    config.syncDir = prevSyncDir;
    config.sourcemapPath = prevSourcemapPath;
    config.port = prevPort;
    config.deleteOrphansOnConnect = prevDeleteOrphansOnConnect;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("scriptChanged creates file when node missing", async () => {
  const tmp = makeTempDir();
  const prevSyncDir = config.syncDir;
  const prevSourcemapPath = config.sourcemapPath;
  const prevPort = config.port;
  let daemon: SyncDaemon | undefined;
  try {
    config.syncDir = tmp;
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;

    daemon = new SyncDaemon();

    const msg = {
      type: "scriptChanged",
      data: {
        guid: "new1",
        path: ["ReplicatedStorage", "Modules", "Bar"],
        className: "ModuleScript",
        source: "print('bar')",
      },
    } as any;

    (daemon as any).handleStudioMessage(msg);

    const expected = path.join(tmp, "ReplicatedStorage", "Modules", "Bar.luau");
    assert.ok(fs.existsSync(expected), "scriptChanged created file");

    // Resending identical source leaves the file untouched
    const mtimeBefore = fs.statSync(expected).mtimeMs;
    await wait(20);
    (daemon as any).handleStudioMessage(msg);
    assert.equal(fs.statSync(expected).mtimeMs, mtimeBefore);

    // Changed source is still written
    (daemon as any).handleStudioMessage({
      ...msg,
      data: { ...msg.data, source: "print('baz')" },
    });
    assert.equal(fs.readFileSync(expected, "utf8"), "print('baz')");
  } finally {
    await daemon?.stop();
    config.syncDir = prevSyncDir;
    config.sourcemapPath = prevSourcemapPath;
    config.port = prevPort;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("deleted removes files and updates sourcemap", async () => {
  const tmp = makeTempDir();
  const prevSyncDir = config.syncDir;
  const prevSourcemapPath = config.sourcemapPath;
  const prevPort = config.port;
  let daemon: SyncDaemon | undefined;
  try {
    config.syncDir = tmp;
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;

    daemon = new SyncDaemon();

    // Create snapshot with one script
    const instances = [
      {
        guid: "r1",
        className: "Folder",
        name: "ReplicatedStorage",
        path: ["ReplicatedStorage"],
      },
      {
        guid: "m1",
        className: "Folder",
        name: "Modules",
        path: ["ReplicatedStorage", "Modules"],
      },
      {
        guid: "sdel",
        className: "ModuleScript",
        name: "ToDelete",
        path: ["ReplicatedStorage", "Modules", "ToDelete"],
        source: "print('bye')",
      },
    ];

    (daemon as any).handleStudioMessage({
      type: "fullSnapshot",
      data: instances,
    });
    const filePath = path.join(
      tmp,
      "ReplicatedStorage",
      "Modules",
      "ToDelete.luau",
    );
    assert.ok(fs.existsSync(filePath), "initial file exists");
    assert.ok(fs.existsSync(config.sourcemapPath), "sourcemap exists");

    // Send delete
    (daemon as any).handleStudioMessage({
      type: "deleted",
      data: { guid: "sdel" },
    });

    // File should be removed
    assert.strictEqual(fs.existsSync(filePath), false, "file was deleted");

    // Sourcemap should also be pruned for the deleted node/path
    await wait(250);
    const sourcemapRaw = fs.readFileSync(config.sourcemapPath, "utf8");
    const sourcemap = JSON.parse(sourcemapRaw);
    assert.notStrictEqual(sourcemapRaw.includes('"guid": "sdel"'), true);
    assert.notStrictEqual(sourcemapRaw.includes('"name": "ToDelete"'), true);
    const hasDeletedPath = (node: any, pathSegments: string[]): boolean => {
      if (!node || !Array.isArray(node.children)) return false;
      for (const child of node.children) {
        if (child.name === pathSegments[0]) {
          if (pathSegments.length === 1) return true;
          if (hasDeletedPath(child, pathSegments.slice(1))) return true;
        }
        if (hasDeletedPath(child, pathSegments)) return true;
      }
      return false;
    };
    assert.strictEqual(
      hasDeletedPath(sourcemap, ["ReplicatedStorage", "Modules", "ToDelete"]),
      false,
      "deleted path removed from sourcemap",
    );
  } finally {
    await daemon?.stop();
    config.syncDir = prevSyncDir;
    config.sourcemapPath = prevSourcemapPath;
    config.port = prevPort;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("filesystem live sync triggers createInstance and deleteInstance IPC messages", async () => {
  const tmp = makeTempDir();
  const prevSyncDir = config.syncDir;
  const prevSourcemapPath = config.sourcemapPath;
  const prevPort = config.port;
  const prevLiveFsSync = config.liveFsSync;
  let daemon: SyncDaemon | undefined;

  try {
    config.syncDir = tmp;
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;
    config.liveFsSync = { ...prevLiveFsSync, enabled: true };

    daemon = new SyncDaemon();

    const sentMessages: any[] = [];
    (daemon as any).ipc.send = (msg: any) => {
      sentMessages.push(msg);
      return true;
    };

    // Test handleFileAdd for a Server script
    const serverScriptPath = path.join(
      tmp,
      "ReplicatedStorage",
      "Test.server.luau",
    );
    (daemon as any).handleFileAdd(serverScriptPath, "print('server')");

    assert.strictEqual(sentMessages.length, 1);
    assert.deepStrictEqual(sentMessages[0], {
      type: "createInstance",
      className: "Script",
      name: "Test",
      parentPath: ["ReplicatedStorage"],
      source: "print('server')",
    });

    sentMessages.length = 0;

    // Test handleDirAdd
    const dirPath = path.join(tmp, "ReplicatedStorage", "NewFolder");
    (daemon as any).handleDirAdd(dirPath);

    assert.strictEqual(sentMessages.length, 1);
    assert.deepStrictEqual(sentMessages[0], {
      type: "createInstance",
      className: "Folder",
      name: "NewFolder",
      parentPath: ["ReplicatedStorage"],
      source: undefined,
    });

    sentMessages.length = 0;

    // Test handleFileDelete for an unmapped file
    (daemon as any).handleFileDelete(serverScriptPath);

    assert.strictEqual(sentMessages.length, 1);
    assert.deepStrictEqual(sentMessages[0], {
      type: "deleteInstance",
      guid: undefined,
      path: ["ReplicatedStorage", "Test"],
    });

    sentMessages.length = 0;

    // Test handleDirDelete
    (daemon as any).handleDirDelete(dirPath);

    assert.strictEqual(sentMessages.length, 1);
    assert.deepStrictEqual(sentMessages[0], {
      type: "deleteInstance",
      guid: undefined,
      path: ["ReplicatedStorage", "NewFolder"],
    });
  } finally {
    await daemon?.stop();
    config.syncDir = prevSyncDir;
    config.sourcemapPath = prevSourcemapPath;
    config.port = prevPort;
    config.liveFsSync = prevLiveFsSync;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("renaming a folder on disk moves the instance and preserves non-script descendants", async () => {
  const tmp = makeTempDir();
  const prevSyncDir = config.syncDir;
  const prevSourcemapPath = config.sourcemapPath;
  const prevPort = config.port;
  const prevLiveFsSync = config.liveFsSync;
  let daemon: SyncDaemon | undefined;

  try {
    config.syncDir = tmp;
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;
    config.liveFsSync = { ...prevLiveFsSync, enabled: true };

    daemon = new SyncDaemon();

    // Studio has: ReplicatedStorage > Parent(Folder) > { Thing(Part), S(Script) }
    const tree = (daemon as any).tree;
    tree.applyFullSnapshot([
      {
        guid: "rs",
        className: "ReplicatedStorage",
        name: "ReplicatedStorage",
        path: ["ReplicatedStorage"],
        parentGuid: "root",
      },
      {
        guid: "gP",
        className: "Folder",
        name: "Parent",
        path: ["ReplicatedStorage", "Parent"],
        parentGuid: "rs",
      },
      {
        guid: "gPart",
        className: "Part",
        name: "Thing",
        path: ["ReplicatedStorage", "Parent", "Thing"],
        parentGuid: "gP",
      },
      {
        guid: "gS",
        className: "Script",
        name: "S",
        path: ["ReplicatedStorage", "Parent", "S"],
        parentGuid: "gP",
        source: "print(1)",
      },
    ]);

    // Write scripts to disk (creates Parent/ and maps the script), then record
    // folder inodes as the daemon does after a snapshot.
    (daemon as any).fileWriter.writeTree(tree.getAllNodes());
    (daemon as any).recordInodes();

    const sentMessages: any[] = [];
    (daemon as any).ipc.send = (msg: any) => {
      sentMessages.push(msg);
      return true;
    };

    // Real rename preserves the directory inode.
    const parentDir = path.join(tmp, "ReplicatedStorage", "Parent");
    const renamedDir = path.join(tmp, "ReplicatedStorage", "Renamed");
    const oldScript = path.join(parentDir, "S.server.luau");
    fs.renameSync(parentDir, renamedDir);

    // Real ordering: the script's unlink (carrying its OLD path) is processed
    // first and tears the script node out of the tree, then the folder's
    // unlinkDir, then the folder's addDir. This desync is what broke content
    // matching; inode matching is immune to it.
    (daemon as any).handleFileDelete(oldScript);
    (daemon as any).handleDirDelete(parentDir);
    (daemon as any).handleDirAdd(renamedDir);

    const moves = sentMessages.filter((m) => m.type === "moveInstance");
    assert.deepStrictEqual(moves, [
      {
        type: "moveInstance",
        guid: "gP",
        parentPath: ["ReplicatedStorage"],
        name: "Renamed",
        className: undefined,
        source: undefined,
      },
    ]);

    // The folder itself is never deleted (that would destroy the Part in Studio).
    const folderDeletes = sentMessages.filter(
      (m) => m.type === "deleteInstance" && m.guid === "gP",
    );
    assert.strictEqual(folderDeletes.length, 0, "folder is moved, not deleted");

    // The non-script Part survives and rode along to the new path.
    const part = tree.getNode("gPart");
    assert.ok(part, "Part node still exists");
    assert.deepStrictEqual(part.path, [
      "ReplicatedStorage",
      "Renamed",
      "Thing",
    ]);

    // The descendant script's own mapping is fixed proactively — not left
    // stale until a later round-trip self-heals it.
    const scriptMapping = (daemon as any).fileWriter.getMapping("gS");
    const newScriptPath = path.join(renamedDir, "S.server.luau");
    assert.strictEqual(
      path.resolve(scriptMapping.filePath),
      path.resolve(newScriptPath),
      "descendant script mapping points at its new path immediately",
    );

    // The physical file the folder rename already relocated is now recognized
    // as already-mapped when its own "add" event eventually arrives — not
    // treated as an unrelated new file.
    sentMessages.length = 0;
    (daemon as any).handleFileAdd(
      newScriptPath,
      fs.readFileSync(newScriptPath, "utf8"),
    );
    assert.strictEqual(
      sentMessages.filter((m) => m.type === "createInstance").length,
      0,
      "descendant script's add event does not spawn a spurious createInstance",
    );
  } finally {
    await daemon?.stop();
    config.syncDir = prevSyncDir;
    config.sourcemapPath = prevSourcemapPath;
    config.port = prevPort;
    config.liveFsSync = prevLiveFsSync;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("moving a script file on disk moves the instance and preserves non-script descendants", async () => {
  const tmp = makeTempDir();
  const prevSyncDir = config.syncDir;
  const prevSourcemapPath = config.sourcemapPath;
  const prevPort = config.port;
  const prevLiveFsSync = config.liveFsSync;
  let daemon: SyncDaemon | undefined;

  try {
    config.syncDir = tmp;
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;
    config.liveFsSync = { ...prevLiveFsSync, enabled: true };

    daemon = new SyncDaemon();

    // ReplicatedStorage > Module(ModuleScript) > Thing(Part, non-script descendant).
    const tree = (daemon as any).tree;
    tree.applyFullSnapshot([
      {
        guid: "rs",
        className: "ReplicatedStorage",
        name: "ReplicatedStorage",
        path: ["ReplicatedStorage"],
        parentGuid: "root",
      },
      {
        guid: "ws",
        className: "Workspace",
        name: "Workspace",
        path: ["Workspace"],
        parentGuid: "root",
      },
      {
        guid: "gM",
        className: "ModuleScript",
        name: "Module",
        path: ["ReplicatedStorage", "Module"],
        parentGuid: "rs",
        source: "return {}",
      },
      {
        guid: "gPart",
        className: "Part",
        name: "Thing",
        path: ["ReplicatedStorage", "Module", "Thing"],
        parentGuid: "gM",
      },
    ]);

    // Write the script to disk (creates ReplicatedStorage/Module.luau and maps
    // it), then record inodes as the daemon does after a snapshot.
    (daemon as any).fileWriter.writeTree(tree.getAllNodes());
    (daemon as any).recordInodes();

    const sentMessages: any[] = [];
    (daemon as any).ipc.send = (msg: any) => {
      sentMessages.push(msg);
      return true;
    };

    // Real move preserves the file's inode (mirrors the reported bug: moving
    // Module.luau from ReplicatedStorage to Workspace).
    const oldScript = path.join(tmp, "ReplicatedStorage", "Module.luau");
    const newScript = path.join(tmp, "Workspace", "Module.luau");
    fs.mkdirSync(path.dirname(newScript), { recursive: true });
    fs.renameSync(oldScript, newScript);

    // Real chokidar ordering: unlink (old path) fires before add (new path).
    (daemon as any).handleFileDelete(oldScript);
    (daemon as any).handleFileAdd(
      newScript,
      fs.readFileSync(newScript, "utf8"),
    );

    const moves = sentMessages.filter((m) => m.type === "moveInstance");
    assert.deepStrictEqual(moves, [
      {
        type: "moveInstance",
        guid: "gM",
        parentPath: ["Workspace"],
        name: "Module",
        className: undefined,
        source: undefined,
      },
    ]);

    // The script itself is never deleted (that would destroy the Part in Studio).
    const scriptDeletes = sentMessages.filter(
      (m) => m.type === "deleteInstance" && m.guid === "gM",
    );
    assert.strictEqual(scriptDeletes.length, 0, "script is moved, not deleted");

    // The non-script Part survives and rode along to the new path.
    const part = tree.getNode("gPart");
    assert.ok(part, "Part node still exists");
    assert.deepStrictEqual(part.path, ["Workspace", "Module", "Thing"]);
  } finally {
    await daemon?.stop();
    config.syncDir = prevSyncDir;
    config.sourcemapPath = prevSourcemapPath;
    config.port = prevPort;
    config.liveFsSync = prevLiveFsSync;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("renaming a script's suffix propagates the class change (ModuleScript -> Script)", async () => {
  const tmp = makeTempDir();
  const prevSyncDir = config.syncDir;
  const prevSourcemapPath = config.sourcemapPath;
  const prevPort = config.port;
  const prevLiveFsSync = config.liveFsSync;
  let daemon: SyncDaemon | undefined;

  try {
    config.syncDir = tmp;
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;
    config.liveFsSync = { ...prevLiveFsSync, enabled: true };

    daemon = new SyncDaemon();
    const tree = (daemon as any).tree;

    tree.applyFullSnapshot([
      {
        guid: "rs",
        className: "ReplicatedStorage",
        name: "ReplicatedStorage",
        path: ["ReplicatedStorage"],
        parentGuid: "root",
      },
      {
        guid: "gM",
        className: "ModuleScript",
        name: "Foo",
        path: ["ReplicatedStorage", "Foo"],
        parentGuid: "rs",
        source: "return {}",
      },
    ]);

    (daemon as any).fileWriter.writeTree(tree.getAllNodes());
    (daemon as any).recordInodes();

    const sentMessages: any[] = [];
    (daemon as any).ipc.send = (msg: any) => {
      sentMessages.push(msg);
      return true;
    };

    // Foo.luau -> Foo.server.luau: same name and directory, only the suffix
    // (and therefore the implied class) changes.
    const oldScript = path.join(tmp, "ReplicatedStorage", "Foo.luau");
    const newScript = path.join(tmp, "ReplicatedStorage", "Foo.server.luau");
    fs.renameSync(oldScript, newScript);

    (daemon as any).handleFileDelete(oldScript);
    (daemon as any).handleFileAdd(
      newScript,
      fs.readFileSync(newScript, "utf8"),
    );

    const moves = sentMessages.filter((m) => m.type === "moveInstance");
    assert.strictEqual(moves.length, 1);
    assert.strictEqual(
      moves[0].className,
      "Script",
      "class change is sent to Studio",
    );

    const node = tree.getNode("gM");
    assert.strictEqual(
      node.className,
      "Script",
      "daemon tree reflects the new class",
    );

    // FileWriter's mapping matches the actual renamed file, not the old path.
    const mapping = (daemon as any).fileWriter.getMapping("gM");
    assert.strictEqual(
      path.resolve(mapping.filePath),
      path.resolve(newScript),
      "file mapping points at the renamed file",
    );

    // The dangling buffered-delete timer must not fire and destroy the
    // instance after the fact.
    await wait(650);
    const deletes = sentMessages.filter(
      (m) => m.type === "deleteInstance" && m.guid === "gM",
    );
    assert.strictEqual(
      deletes.length,
      0,
      "no delayed delete for the renamed instance",
    );
  } finally {
    await daemon?.stop();
    config.syncDir = prevSyncDir;
    config.sourcemapPath = prevSourcemapPath;
    config.port = prevPort;
    config.liveFsSync = prevLiveFsSync;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("renaming a script's suffix propagates the class change (Script -> ModuleScript)", async () => {
  const tmp = makeTempDir();
  const prevSyncDir = config.syncDir;
  const prevSourcemapPath = config.sourcemapPath;
  const prevPort = config.port;
  const prevLiveFsSync = config.liveFsSync;
  let daemon: SyncDaemon | undefined;

  try {
    config.syncDir = tmp;
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;
    config.liveFsSync = { ...prevLiveFsSync, enabled: true };

    daemon = new SyncDaemon();
    const tree = (daemon as any).tree;

    tree.applyFullSnapshot([
      {
        guid: "rs",
        className: "ReplicatedStorage",
        name: "ReplicatedStorage",
        path: ["ReplicatedStorage"],
        parentGuid: "root",
      },
      {
        guid: "gS",
        className: "Script",
        name: "Foo",
        path: ["ReplicatedStorage", "Foo"],
        parentGuid: "rs",
        source: "print(1)",
      },
    ]);

    (daemon as any).fileWriter.writeTree(tree.getAllNodes());
    (daemon as any).recordInodes();

    const sentMessages: any[] = [];
    (daemon as any).ipc.send = (msg: any) => {
      sentMessages.push(msg);
      return true;
    };

    // Foo.server.luau -> Foo.luau: dropping the suffix implies ModuleScript.
    const oldScript = path.join(tmp, "ReplicatedStorage", "Foo.server.luau");
    const newScript = path.join(tmp, "ReplicatedStorage", "Foo.luau");
    fs.renameSync(oldScript, newScript);

    (daemon as any).handleFileDelete(oldScript);
    (daemon as any).handleFileAdd(
      newScript,
      fs.readFileSync(newScript, "utf8"),
    );

    const moves = sentMessages.filter((m) => m.type === "moveInstance");
    assert.strictEqual(moves.length, 1);
    assert.strictEqual(
      moves[0].className,
      "ModuleScript",
      "class change is sent to Studio",
    );

    const node = tree.getNode("gS");
    assert.strictEqual(
      node.className,
      "ModuleScript",
      "daemon tree reflects the new class",
    );

    await wait(650);
    const deletes = sentMessages.filter(
      (m) => m.type === "deleteInstance" && m.guid === "gS",
    );
    assert.strictEqual(
      deletes.length,
      0,
      "no delayed delete for the renamed instance",
    );
  } finally {
    await daemon?.stop();
    config.syncDir = prevSyncDir;
    config.sourcemapPath = prevSourcemapPath;
    config.port = prevPort;
    config.liveFsSync = prevLiveFsSync;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("moving a script file relocates its nested-scripts children folder alongside it", async () => {
  const tmp = makeTempDir();
  const prevSyncDir = config.syncDir;
  const prevSourcemapPath = config.sourcemapPath;
  const prevPort = config.port;
  const prevLiveFsSync = config.liveFsSync;
  let daemon: SyncDaemon | undefined;

  try {
    config.syncDir = tmp;
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;
    config.liveFsSync = { ...prevLiveFsSync, enabled: true };

    daemon = new SyncDaemon();

    // ReplicatedStorage > Module(ModuleScript) > Script1(Script, nested script descendant).
    const tree = (daemon as any).tree;
    tree.applyFullSnapshot([
      {
        guid: "rs",
        className: "ReplicatedStorage",
        name: "ReplicatedStorage",
        path: ["ReplicatedStorage"],
        parentGuid: "root",
      },
      {
        guid: "ws",
        className: "Workspace",
        name: "Workspace",
        path: ["Workspace"],
        parentGuid: "root",
      },
      {
        guid: "gM",
        className: "ModuleScript",
        name: "Module",
        path: ["ReplicatedStorage", "Module"],
        parentGuid: "rs",
        source: "return {}",
      },
      {
        guid: "gS1",
        className: "Script",
        name: "Script1",
        path: ["ReplicatedStorage", "Module", "Script1"],
        parentGuid: "gM",
        source: "print(1)",
      },
    ]);

    // Write the tree to disk: creates ReplicatedStorage/Module.luau AND the
    // nested-scripts container ReplicatedStorage/Module/Script1.server.luau.
    (daemon as any).fileWriter.writeTree(tree.getAllNodes());
    (daemon as any).recordInodes();

    const oldFolder = path.join(tmp, "ReplicatedStorage", "Module");
    const oldNestedScript = path.join(oldFolder, "Script1.server.luau");
    assert.ok(
      fs.existsSync(oldNestedScript),
      "sanity: nested script written under Module/",
    );

    (daemon as any).ipc.send = () => true;

    // Only the script FILE is moved (mirrors the reported bug exactly): the
    // OS operation doesn't know to also move the sibling Module/ folder.
    const oldScript = path.join(tmp, "ReplicatedStorage", "Module.luau");
    const newScript = path.join(tmp, "Workspace", "Module.luau");
    fs.mkdirSync(path.dirname(newScript), { recursive: true });
    fs.renameSync(oldScript, newScript);

    (daemon as any).handleFileDelete(oldScript);
    (daemon as any).handleFileAdd(
      newScript,
      fs.readFileSync(newScript, "utf8"),
    );

    const newFolder = path.join(tmp, "Workspace", "Module");
    const newNestedScript = path.join(newFolder, "Script1.server.luau");

    assert.ok(
      !fs.existsSync(oldFolder),
      "old children folder no longer exists",
    );
    assert.ok(
      fs.existsSync(newNestedScript),
      "children folder relocated alongside the script",
    );

    // FileWriter's mapping for the nested script is updated, not left stale.
    const mapping = (daemon as any).fileWriter.getMapping("gS1");
    assert.strictEqual(
      path.resolve(mapping.filePath),
      path.resolve(newNestedScript),
    );
  } finally {
    await daemon?.stop();
    config.syncDir = prevSyncDir;
    config.sourcemapPath = prevSourcemapPath;
    config.port = prevPort;
    config.liveFsSync = prevLiveFsSync;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("moving a folder to a different parent updates the tree's parent/child linkage, not just its path", async () => {
  const tmp = makeTempDir();
  const prevSyncDir = config.syncDir;
  const prevSourcemapPath = config.sourcemapPath;
  const prevPort = config.port;
  let daemon: SyncDaemon | undefined;

  try {
    config.syncDir = tmp;
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;

    daemon = new SyncDaemon();

    // ReplicatedStorage > Foo(Folder) > Thing(Part); ServerStorage is the move destination.
    const tree = (daemon as any).tree;
    tree.applyFullSnapshot([
      {
        guid: "rs",
        className: "ReplicatedStorage",
        name: "ReplicatedStorage",
        path: ["ReplicatedStorage"],
        parentGuid: "root",
      },
      {
        guid: "ss",
        className: "ServerStorage",
        name: "ServerStorage",
        path: ["ServerStorage"],
        parentGuid: "root",
      },
      {
        guid: "gF",
        className: "Folder",
        name: "Foo",
        path: ["ReplicatedStorage", "Foo"],
        parentGuid: "rs",
      },
      {
        guid: "gPart",
        className: "Part",
        name: "Thing",
        path: ["ReplicatedStorage", "Foo", "Thing"],
        parentGuid: "gF",
      },
    ]);

    (daemon as any).ipc.send = () => true;

    // Move Foo from ReplicatedStorage to ServerStorage.
    (daemon as any).performInstanceMove(
      "gF",
      ["ReplicatedStorage", "Foo"],
      ["ServerStorage", "Foo"],
    );

    const rs = tree.getNode("rs");
    const ss = tree.getNode("ss");
    const folder = tree.getNode("gF");

    assert.deepStrictEqual(
      folder.path,
      ["ServerStorage", "Foo"],
      "path updated",
    );
    assert.strictEqual(
      folder.parent?.guid,
      "ss",
      "parent link points at the new parent",
    );
    assert.ok(
      !rs.children.has("gF"),
      "old parent no longer lists the folder as a child",
    );
    assert.ok(ss.children.has("gF"), "new parent lists the folder as a child");

    // A later delete of the OLD parent must not cascade into the moved subtree.
    tree.deleteInstance("rs");
    assert.ok(
      tree.getNode("gF"),
      "moved folder survives deletion of its old parent",
    );
    assert.ok(tree.getNode("gPart"), "moved folder's descendant survives too");
  } finally {
    await daemon?.stop();
    config.syncDir = prevSyncDir;
    config.sourcemapPath = prevSourcemapPath;
    config.port = prevPort;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("moving a script to become nested under another script resolves the correct parent", async () => {
  const tmp = makeTempDir();
  const prevSyncDir = config.syncDir;
  const prevSourcemapPath = config.sourcemapPath;
  const prevPort = config.port;
  let daemon: SyncDaemon | undefined;

  try {
    config.syncDir = tmp;
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;

    daemon = new SyncDaemon();

    // ReplicatedStorage > { Module(ModuleScript) > Sub(Script), Other(ModuleScript) }.
    // destinationParent must resolve Other even though it's a script, not a folder.
    const tree = (daemon as any).tree;
    tree.applyFullSnapshot([
      {
        guid: "rs",
        className: "ReplicatedStorage",
        name: "ReplicatedStorage",
        path: ["ReplicatedStorage"],
        parentGuid: "root",
      },
      {
        guid: "gM",
        className: "ModuleScript",
        name: "Module",
        path: ["ReplicatedStorage", "Module"],
        parentGuid: "rs",
        source: "return {}",
      },
      {
        guid: "gSub",
        className: "Script",
        name: "Sub",
        path: ["ReplicatedStorage", "Module", "Sub"],
        parentGuid: "gM",
        source: "print(1)",
      },
      {
        guid: "gOther",
        className: "ModuleScript",
        name: "Other",
        path: ["ReplicatedStorage", "Other"],
        parentGuid: "rs",
        source: "return {}",
      },
    ]);

    (daemon as any).ipc.send = () => true;

    // Move Sub from under Module to under Other (a script, not a folder).
    (daemon as any).performInstanceMove(
      "gSub",
      ["ReplicatedStorage", "Module", "Sub"],
      ["ReplicatedStorage", "Other", "Sub"],
    );

    const module_ = tree.getNode("gM");
    const other = tree.getNode("gOther");
    const sub = tree.getNode("gSub");

    assert.deepStrictEqual(sub.path, ["ReplicatedStorage", "Other", "Sub"]);
    assert.strictEqual(
      sub.parent?.guid,
      "gOther",
      "parent link points at the script-class destination parent",
    );
    assert.ok(
      !module_.children.has("gSub"),
      "old script parent no longer lists Sub as a child",
    );
    assert.ok(
      other.children.has("gSub"),
      "new script parent lists Sub as a child",
    );
  } finally {
    await daemon?.stop();
    config.syncDir = prevSyncDir;
    config.sourcemapPath = prevSourcemapPath;
    config.port = prevPort;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("empty folder instances are preserved by cleanupDirectories", async () => {
  const tmp = makeTempDir();
  const prevSyncDir = config.syncDir;
  const prevSourcemapPath = config.sourcemapPath;
  const prevPort = config.port;
  let daemon: SyncDaemon | undefined;

  try {
    config.syncDir = tmp;
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;

    daemon = new SyncDaemon();

    // Create an empty folder on disk
    const emptyFolderPath = path.join(tmp, "ReplicatedStorage", "MyFolder");
    fs.mkdirSync(emptyFolderPath, { recursive: true });

    // Snapshot contains an empty Folder instance at ReplicatedStorage/MyFolder
    const instances = [
      {
        guid: "r1",
        className: "Folder",
        name: "ReplicatedStorage",
        path: ["ReplicatedStorage"],
      },
      {
        guid: "f1",
        className: "Folder",
        name: "MyFolder",
        path: ["ReplicatedStorage", "MyFolder"],
      },
    ];

    (daemon as any).handleStudioMessage({
      type: "fullSnapshot",
      data: instances,
    });

    // Verify the empty directory was NOT cleaned up
    assert.ok(
      fs.existsSync(emptyFolderPath),
      "empty Folder instance directory was preserved",
    );
  } finally {
    await daemon?.stop();
    config.syncDir = prevSyncDir;
    config.sourcemapPath = prevSourcemapPath;
    config.port = prevPort;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// --- Sourcemap staleness after external (filesystem) actions ---

test("sourcemap has no stale entries after a folder is renamed on disk", async () => {
  const tmp = makeTempDir();
  const prevSyncDir = config.syncDir;
  const prevSourcemapPath = config.sourcemapPath;
  const prevPort = config.port;
  const prevLiveFsSync = config.liveFsSync;
  let daemon: SyncDaemon | undefined;

  try {
    config.syncDir = tmp;
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;
    config.liveFsSync = { ...prevLiveFsSync, enabled: true };

    daemon = new SyncDaemon();
    const tree = (daemon as any).tree;

    // ReplicatedStorage > Parent(Folder) > S(Script)
    tree.applyFullSnapshot([
      {
        guid: "rs",
        className: "ReplicatedStorage",
        name: "ReplicatedStorage",
        path: ["ReplicatedStorage"],
        parentGuid: "root",
      },
      {
        guid: "gP",
        className: "Folder",
        name: "Parent",
        path: ["ReplicatedStorage", "Parent"],
        parentGuid: "rs",
      },
      {
        guid: "gS",
        className: "Script",
        name: "S",
        path: ["ReplicatedStorage", "Parent", "S"],
        parentGuid: "gP",
        source: "print(1)",
      },
    ]);

    (daemon as any).fileWriter.writeTree(tree.getAllNodes());
    (daemon as any).recordInodes();
    (daemon as any).regenerateSourcemap();
    (daemon as any).ipc.send = () => true;

    const before = readSourcemap();
    assert.ok(
      findInSourcemap(before, ["ReplicatedStorage", "Parent"]),
      "sanity: initial sourcemap has the folder at its original path",
    );

    // Real rename preserves the directory inode.
    const parentDir = path.join(tmp, "ReplicatedStorage", "Parent");
    const renamedDir = path.join(tmp, "ReplicatedStorage", "Renamed");
    const oldScript = path.join(parentDir, "S.server.luau");
    fs.renameSync(parentDir, renamedDir);

    (daemon as any).handleFileDelete(oldScript);
    (daemon as any).handleDirDelete(parentDir);
    (daemon as any).handleDirAdd(renamedDir);

    const after = await readSettledSourcemap();
    assert.strictEqual(
      findInSourcemap(after, ["ReplicatedStorage", "Parent"]),
      undefined,
      "no stale entry left at the old folder path",
    );

    const folderNode = findInSourcemap(after, ["ReplicatedStorage", "Renamed"]);
    assert.ok(folderNode, "folder entry exists at the new path");
    assert.strictEqual(folderNode.guid, "gP");

    const scriptNode = findInSourcemap(after, [
      "ReplicatedStorage",
      "Renamed",
      "S",
    ]);
    assert.ok(scriptNode, "descendant script entry exists at the new path");
    const newScriptPath = path.join(renamedDir, "S.server.luau");
    assert.strictEqual(
      path.resolve(process.cwd(), scriptNode.filePaths[0]),
      path.resolve(newScriptPath),
      "descendant script's filePaths point at its new location, not the old one",
    );
  } finally {
    await daemon?.stop();
    config.syncDir = prevSyncDir;
    config.sourcemapPath = prevSourcemapPath;
    config.port = prevPort;
    config.liveFsSync = prevLiveFsSync;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("sourcemap has no stale entries after a folder is moved to a different parent on disk", async () => {
  const tmp = makeTempDir();
  const prevSyncDir = config.syncDir;
  const prevSourcemapPath = config.sourcemapPath;
  const prevPort = config.port;
  const prevLiveFsSync = config.liveFsSync;
  let daemon: SyncDaemon | undefined;

  try {
    config.syncDir = tmp;
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;
    config.liveFsSync = { ...prevLiveFsSync, enabled: true };

    daemon = new SyncDaemon();
    const tree = (daemon as any).tree;

    // ReplicatedStorage > Foo(Folder) > S(Script); ServerStorage is the destination.
    tree.applyFullSnapshot([
      {
        guid: "rs",
        className: "ReplicatedStorage",
        name: "ReplicatedStorage",
        path: ["ReplicatedStorage"],
        parentGuid: "root",
      },
      {
        guid: "ss",
        className: "ServerStorage",
        name: "ServerStorage",
        path: ["ServerStorage"],
        parentGuid: "root",
      },
      {
        guid: "gF",
        className: "Folder",
        name: "Foo",
        path: ["ReplicatedStorage", "Foo"],
        parentGuid: "rs",
      },
      {
        guid: "gS",
        className: "Script",
        name: "S",
        path: ["ReplicatedStorage", "Foo", "S"],
        parentGuid: "gF",
        source: "print(1)",
      },
    ]);

    (daemon as any).fileWriter.writeTree(tree.getAllNodes());
    (daemon as any).recordInodes();
    (daemon as any).regenerateSourcemap();
    (daemon as any).ipc.send = () => true;

    assert.ok(
      findInSourcemap(readSourcemap(), ["ReplicatedStorage", "Foo"]),
      "sanity: initial sourcemap has the folder under ReplicatedStorage",
    );

    const oldDir = path.join(tmp, "ReplicatedStorage", "Foo");
    const newDir = path.join(tmp, "ServerStorage", "Foo");
    const oldScript = path.join(oldDir, "S.server.luau");
    fs.mkdirSync(path.dirname(newDir), { recursive: true });
    fs.renameSync(oldDir, newDir);

    (daemon as any).handleFileDelete(oldScript);
    (daemon as any).handleDirDelete(oldDir);
    (daemon as any).handleDirAdd(newDir);

    const after = await readSettledSourcemap();
    assert.strictEqual(
      findInSourcemap(after, ["ReplicatedStorage", "Foo"]),
      undefined,
      "no stale entry left under the old parent",
    );

    const folderNode = findInSourcemap(after, ["ServerStorage", "Foo"]);
    assert.ok(folderNode, "folder entry exists under the new parent");
    assert.strictEqual(folderNode.guid, "gF");

    const scriptNode = findInSourcemap(after, ["ServerStorage", "Foo", "S"]);
    assert.ok(
      scriptNode,
      "descendant script entry exists under the new parent",
    );
    const newScriptPath = path.join(newDir, "S.server.luau");
    assert.strictEqual(
      path.resolve(process.cwd(), scriptNode.filePaths[0]),
      path.resolve(newScriptPath),
      "descendant script's filePaths point at its new location",
    );
  } finally {
    await daemon?.stop();
    config.syncDir = prevSyncDir;
    config.sourcemapPath = prevSourcemapPath;
    config.port = prevPort;
    config.liveFsSync = prevLiveFsSync;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("sourcemap prunes the entry when a folder is deleted on disk", async () => {
  const tmp = makeTempDir();
  const prevSyncDir = config.syncDir;
  const prevSourcemapPath = config.sourcemapPath;
  const prevPort = config.port;
  const prevLiveFsSync = config.liveFsSync;
  let daemon: SyncDaemon | undefined;

  try {
    config.syncDir = tmp;
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;
    config.liveFsSync = { ...prevLiveFsSync, enabled: true };

    daemon = new SyncDaemon();
    const tree = (daemon as any).tree;

    tree.applyFullSnapshot([
      {
        guid: "rs",
        className: "ReplicatedStorage",
        name: "ReplicatedStorage",
        path: ["ReplicatedStorage"],
        parentGuid: "root",
      },
      {
        guid: "gP",
        className: "Folder",
        name: "Parent",
        path: ["ReplicatedStorage", "Parent"],
        parentGuid: "rs",
      },
      {
        guid: "gS",
        className: "Script",
        name: "S",
        path: ["ReplicatedStorage", "Parent", "S"],
        parentGuid: "gP",
        source: "print(1)",
      },
    ]);

    (daemon as any).fileWriter.writeTree(tree.getAllNodes());
    (daemon as any).recordInodes();
    (daemon as any).regenerateSourcemap();
    (daemon as any).ipc.send = () => true;

    assert.ok(
      findInSourcemap(readSourcemap(), ["ReplicatedStorage", "Parent"]),
      "sanity: initial sourcemap has the folder",
    );

    const parentDir = path.join(tmp, "ReplicatedStorage", "Parent");
    const script = path.join(parentDir, "S.server.luau");
    fs.rmSync(parentDir, { recursive: true, force: true });

    // Real ordering: the descendant script's unlink fires before the folder's.
    (daemon as any).handleFileDelete(script);
    (daemon as any).handleDirDelete(parentDir);

    // No matching add arrives — let the buffered deletes flush for real.
    await wait(650);

    const after = await readSettledSourcemap();
    assert.strictEqual(
      findInSourcemap(after, ["ReplicatedStorage", "Parent"]),
      undefined,
      "folder entry pruned",
    );
    assert.strictEqual(
      findInSourcemap(after, ["ReplicatedStorage", "Parent", "S"]),
      undefined,
      "descendant script entry pruned too",
    );
  } finally {
    await daemon?.stop();
    config.syncDir = prevSyncDir;
    config.sourcemapPath = prevSourcemapPath;
    config.port = prevPort;
    config.liveFsSync = prevLiveFsSync;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("sourcemap has no stale entry after a script is renamed on disk", async () => {
  const tmp = makeTempDir();
  const prevSyncDir = config.syncDir;
  const prevSourcemapPath = config.sourcemapPath;
  const prevPort = config.port;
  const prevLiveFsSync = config.liveFsSync;
  let daemon: SyncDaemon | undefined;

  try {
    config.syncDir = tmp;
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;
    config.liveFsSync = { ...prevLiveFsSync, enabled: true };

    daemon = new SyncDaemon();
    const tree = (daemon as any).tree;

    tree.applyFullSnapshot([
      {
        guid: "rs",
        className: "ReplicatedStorage",
        name: "ReplicatedStorage",
        path: ["ReplicatedStorage"],
        parentGuid: "root",
      },
      {
        guid: "gM",
        className: "ModuleScript",
        name: "Module",
        path: ["ReplicatedStorage", "Module"],
        parentGuid: "rs",
        source: "return {}",
      },
    ]);

    (daemon as any).fileWriter.writeTree(tree.getAllNodes());
    (daemon as any).recordInodes();
    (daemon as any).regenerateSourcemap();
    (daemon as any).ipc.send = () => true;

    assert.ok(
      findInSourcemap(readSourcemap(), ["ReplicatedStorage", "Module"]),
      "sanity: initial sourcemap has the script",
    );

    const oldScript = path.join(tmp, "ReplicatedStorage", "Module.luau");
    const newScript = path.join(tmp, "ReplicatedStorage", "IGotRenamed.luau");
    fs.renameSync(oldScript, newScript);

    (daemon as any).handleFileDelete(oldScript);
    (daemon as any).handleFileAdd(
      newScript,
      fs.readFileSync(newScript, "utf8"),
    );

    const after = await readSettledSourcemap();
    assert.strictEqual(
      findInSourcemap(after, ["ReplicatedStorage", "Module"]),
      undefined,
      "no stale entry left at the old name",
    );

    const node = findInSourcemap(after, ["ReplicatedStorage", "IGotRenamed"]);
    assert.ok(node, "entry exists at the new name");
    assert.strictEqual(node.guid, "gM");
    assert.strictEqual(
      path.resolve(process.cwd(), node.filePaths[0]),
      path.resolve(newScript),
      "filePaths point at the renamed file",
    );
  } finally {
    await daemon?.stop();
    config.syncDir = prevSyncDir;
    config.sourcemapPath = prevSourcemapPath;
    config.port = prevPort;
    config.liveFsSync = prevLiveFsSync;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("sourcemap has no stale entries after a script (with a nested descendant) is moved on disk", async () => {
  const tmp = makeTempDir();
  const prevSyncDir = config.syncDir;
  const prevSourcemapPath = config.sourcemapPath;
  const prevPort = config.port;
  const prevLiveFsSync = config.liveFsSync;
  let daemon: SyncDaemon | undefined;

  try {
    config.syncDir = tmp;
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;
    config.liveFsSync = { ...prevLiveFsSync, enabled: true };

    daemon = new SyncDaemon();
    const tree = (daemon as any).tree;

    // ReplicatedStorage > Module(ModuleScript) > Script1(Script, nested).
    tree.applyFullSnapshot([
      {
        guid: "rs",
        className: "ReplicatedStorage",
        name: "ReplicatedStorage",
        path: ["ReplicatedStorage"],
        parentGuid: "root",
      },
      {
        guid: "ws",
        className: "Workspace",
        name: "Workspace",
        path: ["Workspace"],
        parentGuid: "root",
      },
      {
        guid: "gM",
        className: "ModuleScript",
        name: "Module",
        path: ["ReplicatedStorage", "Module"],
        parentGuid: "rs",
        source: "return {}",
      },
      {
        guid: "gS1",
        className: "Script",
        name: "Script1",
        path: ["ReplicatedStorage", "Module", "Script1"],
        parentGuid: "gM",
        source: "print(1)",
      },
    ]);

    (daemon as any).fileWriter.writeTree(tree.getAllNodes());
    (daemon as any).recordInodes();
    (daemon as any).regenerateSourcemap();
    (daemon as any).ipc.send = () => true;

    const before = readSourcemap();
    assert.ok(findInSourcemap(before, ["ReplicatedStorage", "Module"]));
    assert.ok(
      findInSourcemap(before, ["ReplicatedStorage", "Module", "Script1"]),
    );

    // Only the script FILE is moved (the sibling children folder is not
    // touched by the OS operation itself — Azul has to relocate it).
    const oldScript = path.join(tmp, "ReplicatedStorage", "Module.luau");
    const newScript = path.join(tmp, "Workspace", "Module.luau");
    fs.mkdirSync(path.dirname(newScript), { recursive: true });
    fs.renameSync(oldScript, newScript);

    (daemon as any).handleFileDelete(oldScript);
    (daemon as any).handleFileAdd(
      newScript,
      fs.readFileSync(newScript, "utf8"),
    );

    const after = await readSettledSourcemap();
    assert.strictEqual(
      findInSourcemap(after, ["ReplicatedStorage", "Module"]),
      undefined,
      "no stale entry left at the old location",
    );

    const moduleNode = findInSourcemap(after, ["Workspace", "Module"]);
    assert.ok(moduleNode, "script entry exists at the new location");
    assert.strictEqual(moduleNode.guid, "gM");
    assert.strictEqual(
      path.resolve(process.cwd(), moduleNode.filePaths[0]),
      path.resolve(newScript),
    );

    const nestedNode = findInSourcemap(after, [
      "Workspace",
      "Module",
      "Script1",
    ]);
    assert.ok(
      nestedNode,
      "nested descendant entry exists under the new location",
    );
    assert.strictEqual(nestedNode.guid, "gS1");
    const newNestedPath = path.join(
      tmp,
      "Workspace",
      "Module",
      "Script1.server.luau",
    );
    assert.strictEqual(
      path.resolve(process.cwd(), nestedNode.filePaths[0]),
      path.resolve(newNestedPath),
      "nested descendant's filePaths point at its relocated file, not the old one",
    );
  } finally {
    await daemon?.stop();
    config.syncDir = prevSyncDir;
    config.sourcemapPath = prevSourcemapPath;
    config.port = prevPort;
    config.liveFsSync = prevLiveFsSync;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("sourcemap prunes the entry when a script is deleted on disk", async () => {
  const tmp = makeTempDir();
  const prevSyncDir = config.syncDir;
  const prevSourcemapPath = config.sourcemapPath;
  const prevPort = config.port;
  const prevLiveFsSync = config.liveFsSync;
  let daemon: SyncDaemon | undefined;

  try {
    config.syncDir = tmp;
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;
    config.liveFsSync = { ...prevLiveFsSync, enabled: true };

    daemon = new SyncDaemon();
    const tree = (daemon as any).tree;

    tree.applyFullSnapshot([
      {
        guid: "rs",
        className: "ReplicatedStorage",
        name: "ReplicatedStorage",
        path: ["ReplicatedStorage"],
        parentGuid: "root",
      },
      {
        guid: "gM",
        className: "ModuleScript",
        name: "Module",
        path: ["ReplicatedStorage", "Module"],
        parentGuid: "rs",
        source: "return {}",
      },
    ]);

    (daemon as any).fileWriter.writeTree(tree.getAllNodes());
    (daemon as any).recordInodes();
    (daemon as any).regenerateSourcemap();
    (daemon as any).ipc.send = () => true;

    assert.ok(
      findInSourcemap(readSourcemap(), ["ReplicatedStorage", "Module"]),
      "sanity: initial sourcemap has the script",
    );

    const scriptPath = path.join(tmp, "ReplicatedStorage", "Module.luau");
    fs.rmSync(scriptPath);
    (daemon as any).handleFileDelete(scriptPath);

    // No matching add arrives — let the buffered delete flush for real.
    await wait(650);

    const after = await readSettledSourcemap();
    assert.strictEqual(
      findInSourcemap(after, ["ReplicatedStorage", "Module"]),
      undefined,
      "script entry pruned",
    );
  } finally {
    await daemon?.stop();
    config.syncDir = prevSyncDir;
    config.sourcemapPath = prevSourcemapPath;
    config.port = prevPort;
    config.liveFsSync = prevLiveFsSync;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("live sync stamps _azul.placeId on the sourcemap and clears it for unsaved places", async () => {
  const tmp = makeTempDir();
  const prevSyncDir = config.syncDir;
  const prevSourcemapPath = config.sourcemapPath;
  const prevPort = config.port;
  let daemon: SyncDaemon | undefined;

  try {
    config.syncDir = tmp;
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;

    daemon = new SyncDaemon();
    (daemon as any).ipc.send = () => true;

    const snapshot = [
      {
        guid: "rs",
        className: "ReplicatedStorage",
        name: "ReplicatedStorage",
        path: ["ReplicatedStorage"],
        parentGuid: "root",
      },
    ];

    (daemon as any).handleStudioMessage({
      type: "fullSnapshot",
      data: snapshot,
      placeId: 123456789,
    });

    assert.strictEqual(readSourcemap()._azul?.placeId, 123456789);

    // A later snapshot from an unsaved place (PlaceId 0) drops it, so
    // 'azul open-studio' errors instead of opening the previous place
    (daemon as any).handleStudioMessage({
      type: "fullSnapshot",
      data: snapshot,
      placeId: 0,
    });

    assert.strictEqual(readSourcemap()._azul?.placeId, undefined);
  } finally {
    await daemon?.stop();
    config.syncDir = prevSyncDir;
    config.sourcemapPath = prevSourcemapPath;
    config.port = prevPort;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("a burst of Studio changes produces one sourcemap write and one directory cleanup, and identical regens skip the write", async () => {
  const tmp = makeTempDir();
  const prevSyncDir = config.syncDir;
  const prevSourcemapPath = config.sourcemapPath;
  const prevPort = config.port;
  let daemon: SyncDaemon | undefined;

  try {
    config.syncDir = tmp;
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;

    daemon = new SyncDaemon();
    (daemon as any).ipc.send = () => true;

    (daemon as any).handleStudioMessage({
      type: "fullSnapshot",
      data: [
        {
          guid: "rs",
          className: "ReplicatedStorage",
          name: "ReplicatedStorage",
          path: ["ReplicatedStorage"],
          parentGuid: "root",
        },
      ],
    });

    const generator = (daemon as any).sourcemapGenerator;
    let writes = 0;
    const originalWrite = generator.write.bind(generator);
    generator.write = (...args: any[]) => {
      writes++;
      return originalWrite(...args);
    };

    let cleanups = 0;
    const fileWriter = (daemon as any).fileWriter;
    const originalCleanup = fileWriter.cleanupEmptyDirectories.bind(fileWriter);
    fileWriter.cleanupEmptyDirectories = (...args: any[]) => {
      cleanups++;
      return originalCleanup(...args);
    };

    const messages = Array.from({ length: 50 }, (_, i) => ({
      type: "instanceUpdated",
      data: {
        guid: `f${i}`,
        className: "Folder",
        name: `F${i}`,
        path: ["ReplicatedStorage", `F${i}`],
        parentGuid: "rs",
      },
    }));
    (daemon as any).handleStudioMessage({ type: "batch", messages });

    const after = await readSettledSourcemap();
    assert.equal(writes, 1, "50 updates coalesce into one write");
    assert.equal(cleanups, 1, "50 updates share one directory walk");
    assert.ok(findInSourcemap(after, ["ReplicatedStorage", "F49"]));

    // Regenerating an unchanged tree leaves the file untouched
    const mtimeBefore = fs.statSync(config.sourcemapPath).mtimeMs;
    await wait(20);
    (daemon as any).regenerateSourcemap();
    assert.equal(fs.statSync(config.sourcemapPath).mtimeMs, mtimeBefore);
  } finally {
    await daemon?.stop();
    config.syncDir = prevSyncDir;
    config.sourcemapPath = prevSourcemapPath;
    config.port = prevPort;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("same-name siblings stay separate in the sourcemap through duplicate, rename, and delete", async () => {
  const tmp = makeTempDir();
  const prevSyncDir = config.syncDir;
  const prevSourcemapPath = config.sourcemapPath;
  const prevPort = config.port;
  let daemon: SyncDaemon | undefined;

  const guidsAt = (sourcemap: any, name: string): string[] =>
    findInSourcemap(sourcemap, ["ReplicatedStorage"])
      .children.filter((c: any) => c.name === name)
      .map((c: any) => c.guid)
      .sort();

  const script = (guid: string, name: string) => ({
    guid,
    className: "ModuleScript",
    name,
    path: ["ReplicatedStorage", name],
    parentGuid: "rs",
    source: `return "${guid}"`,
  });

  try {
    config.syncDir = tmp;
    config.sourcemapPath = path.join(tmp, "sourcemap.json");
    config.port = 0;

    daemon = new SyncDaemon();
    (daemon as any).ipc.send = () => true;

    (daemon as any).handleStudioMessage({
      type: "fullSnapshot",
      data: [
        {
          guid: "rs",
          className: "ReplicatedStorage",
          name: "ReplicatedStorage",
          path: ["ReplicatedStorage"],
          parentGuid: "root",
        },
        script("a", "Mod"),
      ],
    });

    // Duplicating in Studio: new guid, identical name/class/path
    (daemon as any).handleStudioMessage({
      type: "instanceUpdated",
      data: script("b", "Mod"),
    });
    assert.deepEqual(guidsAt(await readSettledSourcemap(), "Mod"), ["a", "b"]);

    // Editing one copy doesn't merge or drop the other
    (daemon as any).handleStudioMessage({
      type: "scriptChanged",
      data: script("a", "Mod"),
    });
    assert.deepEqual(guidsAt(await readSettledSourcemap(), "Mod"), ["a", "b"]);

    // Renaming one leaves the other in place
    (daemon as any).handleStudioMessage({
      type: "instanceUpdated",
      data: script("b", "Other"),
    });
    let after = await readSettledSourcemap();
    assert.deepEqual(guidsAt(after, "Mod"), ["a"]);
    assert.deepEqual(guidsAt(after, "Other"), ["b"]);

    // Deleting one of two same-name siblings keeps the survivor
    (daemon as any).handleStudioMessage({
      type: "instanceUpdated",
      data: script("c", "Mod"),
    });
    (daemon as any).handleStudioMessage({
      type: "deleted",
      data: { guid: "a" },
    });
    after = await readSettledSourcemap();
    assert.deepEqual(guidsAt(after, "Mod"), ["c"]);
    assert.deepEqual(guidsAt(after, "Other"), ["b"]);
  } finally {
    await daemon?.stop();
    config.syncDir = prevSyncDir;
    config.sourcemapPath = prevSourcemapPath;
    config.port = prevPort;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("isVersionCompatible only cares about major.minor", () => {
  assert.equal(isVersionCompatible("2.0.0", "2.0.3"), true);
  assert.equal(isVersionCompatible("2.0.0", "2.1.0"), false);
  assert.equal(isVersionCompatible("2.0.0", "3.0.0"), false);
});
