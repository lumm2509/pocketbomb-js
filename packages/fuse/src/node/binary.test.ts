import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, assert, beforeEach, describe, test } from "vitest";
import { defaultCacheDir, resolveFuseBinary, sourceHash } from "./binary";

let tmp = "";
const silent = () => {};

function write(rel: string, content: string) {
  const file = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** A minimal Go module with an examples/base main package (fast to build). */
function fakeRepo() {
  write("go.mod", "module example.com/fake\n\ngo 1.22\n");
  write("examples/base/main.go", 'package main\n\nfunc main() { println("v1") }\n');
}

describe("fuse binary resolution", function () {
  const savedEnv = { ...process.env };

  beforeEach(function () {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fuse-binary-test-"));
    delete process.env.POCKETBOMB_BIN;
    delete process.env.POCKETBOMB_SRC;
    delete process.env.POCKETBOMB_FUSE_CACHE;
  });

  afterEach(function () {
    fs.rmSync(tmp, { recursive: true, force: true });
    process.env = { ...savedEnv };
  });

  test("sourceHash() covers the Go sources and the embedded ui/dist only", function () {
    fakeRepo();
    write("ui/dist/index.html", "<html>");
    write("ui/src/main.js", "a");
    write("node_modules/x/y.go", "package y");
    write(".git/HEAD", "ref");
    write("README.md", "a");

    const h1 = sourceHash(tmp);
    assert.match(h1, /^[0-9a-f]{64}$/);
    assert.equal(sourceHash(tmp), h1, "stable");

    // ignored changes
    write("ui/src/main.js", "b");
    write("node_modules/x/y.go", "package z");
    write("README.md", "b");
    assert.equal(sourceHash(tmp), h1);

    // relevant changes
    write("ui/dist/index.html", "<html>!");
    const h2 = sourceHash(tmp);
    assert.notEqual(h2, h1);
    write("examples/base/main.go", 'package main\n\nfunc main() { println("v2") }\n');
    assert.notEqual(sourceHash(tmp), h2);
  });

  test("bin option and POCKETBOMB_BIN", function () {
    write("bin/pocketbomb", "#!/bin/sh\n");
    const bin = path.join(tmp, "bin/pocketbomb");

    assert.deepEqual(resolveFuseBinary({ bin, log: silent }), { bin, source: "bin" });

    process.env.POCKETBOMB_BIN = bin;
    assert.deepEqual(resolveFuseBinary({ log: silent }), { bin, source: "env" });

    assert.throws(() => resolveFuseBinary({ bin: bin + ".missing" }), /doesn't exist/);
  });

  test("clear errors without a binary or a source repository", function () {
    assert.throws(
      () => resolveFuseBinary({ log: silent }),
      /POCKETBOMB_BIN.*POCKETBOMB_SRC.*no downloadable releases/s,
    );
    assert.throws(() => resolveFuseBinary({ src: tmp, log: silent }), /no examples\/base/);
  });

  test("builds from src (POCKETBOMB_SRC) and caches by the source hash", function () {
    fakeRepo();
    const cacheDir = path.join(tmp, ".cache-test");
    const logs: Array<string> = [];
    process.env.POCKETBOMB_SRC = tmp;

    const first = resolveFuseBinary({ cacheDir, log: (l) => logs.push(l) });
    assert.equal(first.source, "build");
    assert.equal(first.hash, sourceHash(tmp));
    assert.isTrue(first.bin.startsWith(cacheDir));
    assert.include(
      spawnSync(first.bin, { encoding: "utf8" }).stderr,
      "v1",
      "the built program runs",
    );
    assert.lengthOf(logs, 1);

    const second = resolveFuseBinary({ cacheDir, log: (l) => logs.push(l) });
    assert.deepEqual(second, { ...first, source: "cache" });
    assert.lengthOf(logs, 1, "no rebuild");

    write("examples/base/main.go", 'package main\n\nfunc main() { println("v2") }\n');
    const third = resolveFuseBinary({ src: tmp, cacheDir, log: silent });
    assert.equal(third.source, "build");
    assert.notEqual(third.bin, first.bin);
    assert.deepEqual(fs.readdirSync(path.dirname(third.bin)), ["pocketbomb"], "no temp files left");
  });

  test("defaultCacheDir()", function () {
    assert.equal(defaultCacheDir(), path.join(os.homedir(), ".cache", "pocketbomb-fuse"));
    process.env.POCKETBOMB_FUSE_CACHE = "/x/y";
    assert.equal(defaultCacheDir(), "/x/y");
  });
});
