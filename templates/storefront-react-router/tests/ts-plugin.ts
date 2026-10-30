// Smoke test of the dynamite TypeScript plugin (@pocketbomb/dynamite/ts-plugin, configured in
// tsconfig.json): a real tsserver returns GraphQL completions and diagnostics for the
// `graphql()` documents of the template (from the codegen schema .dynamite/schema.graphql).
//
// Usage: node tests/ts-plugin.ts   (after `pnpm codegen`)
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const tsserverPath = path.join(path.dirname(require.resolve("typescript")), "tsserver.js");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error("ts-plugin smoke assertion failed: " + message);
  }
}

// a document of the template app opened in the editor (written for the test, removed after)
const probeFile = path.join(root, "tests/ts-plugin-probe.generated.ts");
const probe = `import { graphql } from "@pocketbomb/dynamite/graphql";

export const COMPLETE = graphql(\`
  query Complete {
    products(first: 1) {
      nodes {
        ti
      }
    }
  }
\`);

export const INVALID = graphql(\`
  query Invalid {
    products(first: 1) {
      nodes {
        nope
      }
    }
  }
\`);
`;

/** A minimal tsserver protocol client. */
class TsServer {
  private seq = 0;
  private buffer = "";
  private pending = new Map<number, (body: any) => void>();
  readonly events: Array<any> = [];
  readonly proc = spawn(
    process.execPath,
    [
      tsserverPath,
      "--allowLocalPluginLoads",
      "--pluginProbeLocations",
      root,
      "--disableAutomaticTypingAcquisition",
    ],
    { cwd: root, stdio: ["pipe", "pipe", "inherit"] },
  );

  constructor() {
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      for (;;) {
        const header = this.buffer.match(/Content-Length: (\d+)\r\n\r\n/);
        if (!header || header.index === undefined) {
          return;
        }
        const start = header.index + header[0].length;
        const length = parseInt(header[1], 10);
        if (Buffer.byteLength(this.buffer.substring(start)) < length) {
          return;
        }
        const bytes = Buffer.from(this.buffer.substring(start));
        const json = bytes.subarray(0, length).toString("utf8");
        this.buffer = bytes.subarray(length).toString("utf8");

        const message = JSON.parse(json);
        if (message.type === "response" && this.pending.has(message.request_seq)) {
          this.pending.get(message.request_seq)!(message);
          this.pending.delete(message.request_seq);
        } else if (message.type === "event") {
          this.events.push(message);
        }
      }
    });
  }

  request(command: string, args: unknown): Promise<any> {
    const seq = ++this.seq;
    return new Promise((resolve) => {
      this.pending.set(seq, resolve);
      this.proc.stdin.write(
        JSON.stringify({ seq, type: "request", command, arguments: args }) + "\n",
      );
    });
  }

  close() {
    this.proc.kill();
  }
}

function positionOf(text: string, marker: string): { line: number; offset: number } {
  const index = text.indexOf(marker) + marker.length;
  const before = text.substring(0, index).split("\n");
  return { line: before.length, offset: before[before.length - 1].length + 1 };
}

fs.writeFileSync(probeFile, probe);
const server = new TsServer();
try {
  await server.request("configure", { preferences: { includeCompletionsWithInsertText: true } });
  await server.request("open", {
    file: probeFile,
    fileContent: probe,
    scriptKindName: "TS",
    projectRootPath: root,
  });

  const project = await server.request("projectInfo", { file: probeFile, needFileNameList: false });
  assert(
    path.resolve(project.body.configFileName) === path.join(root, "tsconfig.json"),
    "the template tsconfig project",
  );

  // graphqlsp loads the schema asynchronously: the request is repeated until the schema
  // is available (the language service returns no GraphQL entries before)
  const at = positionOf(probe, "        ti");
  let names: Array<string> = [];
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const completions = await server.request("completionInfo", { file: probeFile, ...at });
    names = (completions.body?.entries || []).map((e: any) => e.name);
    if (names.includes("title")) {
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  assert(names.includes("title"), "GraphQL field completions: " + names.slice(0, 20).join(", "));
  assert(!names.includes("totalCount"), "only the Product fields (not the connection ones)");

  const diagnostics = await server.request("semanticDiagnosticsSync", { file: probeFile });
  const messages: Array<string> = diagnostics.body.map((d: any) => d.text);
  assert(
    messages.some((m) => m.includes('Cannot query field "nope" on type "Product"')),
    "the GraphQL validation diagnostic: " + JSON.stringify(messages),
  );

  console.log(
    "ts-plugin smoke OK: " +
      names.filter((n) => n === "title").join(", ") +
      " completion; diagnostic: " +
      messages.find((m) => m.includes("nope")),
  );
} finally {
  server.close();
  fs.rmSync(probeFile, { force: true });
}
