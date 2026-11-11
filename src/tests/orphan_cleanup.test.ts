import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SyncDaemon } from "../index.js";
import { config } from "../config.js";

test("snapshot cleanup preserves non-scripts and mapped scripts, honoring per-place overrides", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "azul-orphan-cleanup-"));
  const previous = { ...config };
  let daemon: SyncDaemon | undefined;
  try {
    Object.assign(config, {
      syncDir: tmp,
      sourcemapPath: path.join(tmp, "sourcemap.json"),
      port: 0,
      deleteOrphansOnConnect: true,
    });
    // This branch is independent of folder-backed-scripts. When integrated
    // together, the same regression also verifies mapped init files survive.
    const folderBacked = "folderBackedScriptsWithChildren" in config;
    if (folderBacked)
      Object.assign(config, { folderBackedScriptsWithChildren: true });
    const dir = path.join(tmp, "ReplicatedStorage", "Parent");
    fs.mkdirSync(dir, { recursive: true });
    const preserved = ["AGENTS.md", "asset.json", "notes.txt", "image.png"];
    const orphans = ["orphan.lua", "orphan.luau", "orphan.server.luau"];
    for (const file of preserved)
      fs.writeFileSync(path.join(dir, file), "keep me");
    for (const file of orphans)
      fs.writeFileSync(path.join(dir, file), "remove me");

    daemon = new SyncDaemon();
    const internal = daemon as any;
    internal.handleStudioMessage({
      type: "fullSnapshot",
      data: [
        {
          guid: "rs",
          className: "ReplicatedStorage",
          name: "ReplicatedStorage",
          path: ["ReplicatedStorage"],
        },
        {
          guid: "parent",
          className: "ModuleScript",
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
      ],
    });

    const checkPreserved = () => {
      for (const file of preserved)
        assert.equal(fs.readFileSync(path.join(dir, file), "utf8"), "keep me");
      const parentPath = internal.fileWriter.getMapping("parent").filePath;
      assert.equal(fs.readFileSync(parentPath, "utf8"), "return {}");
      assert.equal(
        path.basename(parentPath),
        folderBacked ? "init.luau" : "Parent.luau",
      );
      assert.equal(
        fs.readFileSync(path.join(dir, "Child.luau"), "utf8"),
        "return 1",
      );
    };
    checkPreserved();
    for (const file of orphans)
      assert.equal(fs.existsSync(path.join(dir, file)), false);

    config.deleteOrphansOnConnect = true;
    internal.applyPlaceConfig({ deleteOrphansOnConnect: false });
    for (const file of orphans)
      fs.writeFileSync(path.join(dir, file), "keep until enabled");
    internal.cleanupOrphanFiles();
    for (const file of orphans) assert.ok(fs.existsSync(path.join(dir, file)));

    config.deleteOrphansOnConnect = false;
    internal.applyPlaceConfig({ deleteOrphansOnConnect: true });
    internal.cleanupOrphanFiles();
    for (const file of orphans)
      assert.equal(fs.existsSync(path.join(dir, file)), false);
    checkPreserved();
  } finally {
    await daemon?.stop();
    Object.assign(config, previous);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
