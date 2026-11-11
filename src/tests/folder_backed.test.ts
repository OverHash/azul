import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SyncDaemon } from "../index.js";
import { config } from "../config.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Synthetic Studio messages and an ephemeral port: never connect to a game or
// initialize the user's global configuration. Keep this suite on the feature
// branch so future integrations carry its compatibility checks with them.
async function withDaemon(
  run: (daemon: any, tmp: string, sent: any[]) => Promise<void>,
) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "azul-folder-backed-"));
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

function snapshot(daemon: any, className = "ModuleScript") {
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

test("folder-backed export supports script classes, suffixes, extensions and sourcemaps", async () => {
  await withDaemon(async (daemon, tmp) => {
    for (const extension of [".lua", ".luau"]) {
      config.scriptExtension = extension;
      for (const [className, suffix, moduleSuffix] of [
        ["ModuleScript", "", false],
        ["ModuleScript", ".module", true],
        ["Script", ".server", false],
        ["LocalScript", ".client", false],
      ] as const) {
        config.suffixModuleScripts = moduleSuffix;
        snapshot(daemon, className);
        const init = path.join(
          tmp,
          "ReplicatedStorage",
          "Parent",
          `init${suffix}${extension}`,
        );
        assert.equal(daemon.fileWriter.getMapping("parent").filePath, init);
        assert.equal(fs.readFileSync(init, "utf8"), "return {}");
        assert.equal(daemon.fileWriter.getGuidByPath(init), "parent");
        const sourcemap = JSON.parse(
          fs.readFileSync(config.sourcemapPath, "utf8"),
        );
        const parent = sourcemap.children
          .find((n: any) => n.name === "ReplicatedStorage")
          .children.find((n: any) => n.name === "Parent");
        assert.equal(parent.className, className);
        assert.ok(
          parent.filePaths.some((p: string) =>
            p.endsWith(`init${suffix}${extension}`),
          ),
        );
      }
    }
  });
});

test("explicit init remains stable after deleting its last script child and remains editable", async () => {
  await withDaemon(async (daemon, tmp, sent) => {
    snapshot(daemon);
    daemon.handleDeleted({ guid: "child" });
    const init = path.join(tmp, "ReplicatedStorage", "Parent", "init.luau");
    assert.ok(fs.existsSync(init));
    daemon.handleFileChange(init, "return 3");
    assert.ok(
      sent.some(
        (m) =>
          m.type === "patchScript" &&
          m.guid === "parent" &&
          m.source === "return 3",
      ),
    );
  });
});

test("new init files create their containing instance, not init children or duplicate Folders", async () => {
  await withDaemon(async (daemon, tmp, sent) => {
    for (const [name, className] of [
      ["init.luau", "ModuleScript"],
      ["init.module.lua", "ModuleScript"],
      ["init.server.luau", "Script"],
      ["init.client.lua", "LocalScript"],
    ]) {
      const dir = path.join(tmp, "ReplicatedStorage", className + name);
      fs.mkdirSync(dir, { recursive: true });
      const init = path.join(dir, name);
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
  test(`folder-backed move preserves GUIDs, Parts and mappings (${fileFirst ? "file" : "directory"} add first)`, async () => {
    await withDaemon(async (daemon, tmp, sent) => {
      snapshot(daemon);
      const oldDir = path.join(tmp, "ReplicatedStorage", "Parent");
      const newDir = path.join(tmp, "ReplicatedStorage", "Renamed");
      fs.renameSync(oldDir, newDir);
      daemon.handleFileDelete(path.join(oldDir, "Child.luau"));
      daemon.handleFileDelete(path.join(oldDir, "init.luau"));
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
        daemon.fileWriter.getGuidByPath(path.join(newDir, "init.luau")),
        "parent",
      );
      const child = path.join(newDir, "Child.luau");
      assert.equal(daemon.fileWriter.getGuidByPath(child), "child");
      daemon.handleFileChange(child, "return 4");
      assert.ok(
        sent.some((m) => m.type === "patchScript" && m.guid === "child"),
      );
      await wait(650);
      assert.equal(sent.filter((m) => m.type === "deleteInstance").length, 0);
      assert.ok(daemon.tree.getNode("part"));
    });
  });
}

test("init suffix rename changes the containing script's class without destroying descendants", async () => {
  await withDaemon(async (daemon, tmp, sent) => {
    snapshot(daemon);
    const dir = path.join(tmp, "ReplicatedStorage", "Parent");
    const oldInit = path.join(dir, "init.luau");
    const newInit = path.join(dir, "init.server.luau");
    fs.renameSync(oldInit, newInit);
    daemon.handleFileDelete(oldInit);
    daemon.handleFileAdd(newInit, "print(1)");
    assert.deepEqual(
      sent.find((m) => m.type === "moveInstance"),
      {
        type: "moveInstance",
        guid: "parent",
        parentPath: ["ReplicatedStorage"],
        name: "Parent",
        className: "Script",
        source: "print(1)",
      },
    );
    assert.equal(daemon.fileWriter.getGuidByPath(newInit), "parent");
    assert.ok(daemon.tree.getNode("part"));
  });
});

test("removing only init demotes to Folder without destroying descendants", async () => {
  await withDaemon(async (daemon, tmp, sent) => {
    snapshot(daemon);
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

test("atomic init replacement is an edit, not a delayed Folder demotion", async () => {
  await withDaemon(async (daemon, tmp, sent) => {
    snapshot(daemon);
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
      sent.filter((m) => ["moveInstance", "deleteInstance"].includes(m.type))
        .length,
      0,
    );
  });
});

test("live watcher follows init-layout moves and suppresses Studio ancestor-promotion echoes", async () => {
  await withDaemon(async (daemon, tmp, sent) => {
    snapshot(daemon);
    daemon.fileWatcher.watch(tmp);
    await new Promise<void>((resolve) =>
      daemon.fileWatcher.watcher.once("ready", resolve),
    );
    await wait(1100);
    const oldDir = path.join(tmp, "ReplicatedStorage", "Parent");
    const newDir = path.join(tmp, "ReplicatedStorage", "Moved");
    fs.renameSync(oldDir, newDir);
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
    fs.writeFileSync(path.join(newDir, "Child.luau"), "return 6");
    await wait(600);
    assert.ok(
      sent.some(
        (m) =>
          m.type === "patchScript" &&
          m.guid === "child" &&
          m.source === "return 6",
      ),
    );
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
    );
  });
});
