import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type net from "node:net";
import path from "node:path";
import { buildSchema, introspectionFromSchema, type GraphQLSchema } from "graphql";
import { afterAll, afterEach, assert, beforeAll, describe, expect, test } from "vitest";
import {
  codegen,
  generate,
  introspect,
  introspectionToEnv,
  introspectionToSDL,
  watchCodegen,
  withoutEmptyDescriptions,
} from "./codegen";
import { run } from "./index";

const SDL = `
"RFC3339 date time string."
scalar DateTime
scalar JSON

type PageInfo { hasNextPage: Boolean! hasPreviousPage: Boolean! startCursor: String endCursor: String }
type Product { id: ID! title: String handle: String created: DateTime meta: JSON }
type ProductConnection { nodes: [Product!]! pageInfo: PageInfo! totalCount: Int! }
type Query {
  products(first: Int, after: String, last: Int, before: String, sort: String): ProductConnection
  product(handle: String): Product
}
`;

/** A mock PocketBomb GraphQL endpoint answering the introspection of the current schema. */
class MockApi {
  schema: GraphQLSchema = buildSchema(SDL);
  requests: Array<{ headers: http.IncomingHttpHeaders; body: any }> = [];
  status = 200;
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      this.requests.push({ headers: req.headers, body: JSON.parse(raw || "{}") });
      res.writeHead(this.status, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          this.status === 200
            ? { data: introspectionFromSchema(this.schema) }
            : { message: "missing_client_credentials" },
        ),
      );
    });
  });
  url = "";

  async start() {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = "http://127.0.0.1:" + (this.server.address() as net.AddressInfo).port;
  }

  stop() {
    return new Promise((r) => this.server.close(r));
  }
}

const tmpRoot = path.join(__dirname, "../../.test-tmp");
let tmp = "";
const api = new MockApi();

beforeAll(async () => {
  await api.start();
});
afterAll(async () => {
  await api.stop();
});
afterEach(() => {
  api.schema = buildSchema(SDL);
  api.status = 200;
  api.requests = [];
  if (tmp) {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

function newTmp(): string {
  fs.mkdirSync(tmpRoot, { recursive: true });
  tmp = fs.mkdtempSync(path.join(tmpRoot, "codegen-"));
  return tmp;
}

describe("codegen", function () {
  test("introspect() sends the introspection query with the public key", async function () {
    const result = await introspect({ url: api.url + "/", publicKey: "pb_pk_1" });

    assert.isDefined(result.__schema);
    assert.equal(api.requests[0].headers["x-pb-public-key"], "pb_pk_1");
    assert.include(api.requests[0].body.query, "__schema");
  });

  test("introspect() throws the HTTP and GraphQL errors", async function () {
    api.status = 401;
    await expect(introspect({ url: api.url })).rejects.toThrow(/401.*missing_client_credentials/);

    const failing = async () =>
      new Response(JSON.stringify({ errors: [{ message: "boom" }] }), { status: 200 });
    await expect(introspect({ url: "http://x", fetch: failing as any })).rejects.toThrow(/boom/);
  });

  test("introspectionToSDL() and introspectionToEnv()", function () {
    const introspection = introspectionFromSchema(buildSchema(SDL));

    const sdl = introspectionToSDL(introspection);
    assert.notInclude(introspectionToSDL(withoutEmptyDescriptions(introspection)), '""""""');
    assert.include(sdl, "type Product {");
    assert.include(sdl, '"""RFC3339 date time string."""');

    const env = introspectionToEnv(introspection);
    assert.include(env, "export type introspection = {");
    assert.include(env, "'Product': { kind: 'OBJECT'; name: 'Product';");
    assert.include(env, 'declare module "pocketbomb-dynamite/graphql"');
    assert.include(env, "interface PocketBombSchema");
  });

  test("withoutEmptyDescriptions() drops the empty descriptions only", function () {
    const input = {
      description: "",
      types: [{ description: "", name: "A" }, { description: "B docs" }],
      other: "",
    };
    assert.deepEqual(withoutEmptyDescriptions(input), {
      description: null,
      types: [{ description: null, name: "A" }, { description: "B docs" }],
      other: "",
    } as any);

    const schema = buildSchema('type Query { "" a: Int }');
    assert.notInclude(introspectionToSDL(introspectionFromSchema(schema)), '""""""');
  });

  test("generate() writes the files only when they change", function () {
    const cwd = newTmp();
    const introspection = introspectionFromSchema(buildSchema(SDL));

    const first = generate(introspection, { cwd });
    assert.isTrue(first.changed);
    assert.equal(first.schemaFile, path.join(cwd, ".dynamite/schema.graphql"));
    assert.equal(first.envFile, path.join(cwd, "pocketbomb-env.d.ts"));

    assert.isFalse(generate(introspection, { cwd }).changed);

    const custom = generate(introspection, { cwd, schemaFile: "s.graphql", envFile: "x/env.d.ts" });
    assert.isTrue(custom.changed);
    assert.isTrue(fs.existsSync(path.join(cwd, "x/env.d.ts")));
  });

  test("the generated env types the graphql() documents (gql.tada + PocketBombSchema augmentation)", async function () {
    const cwd = newTmp();
    await codegen({ url: api.url, publicKey: "pb_pk_1", cwd });

    fs.writeFileSync(
      path.join(cwd, "app.ts"),
      `import { graphql, type ResultOf, type VariablesOf } from "pocketbomb-dynamite/graphql";

const PRODUCTS = graphql(\`
  query Products($first: Int) {
    products(first: $first, sort: "handle") { nodes { id title created meta } totalCount }
  }
\`);

type Data = ResultOf<typeof PRODUCTS>;
const title: string | null | undefined = ({} as Data).products?.nodes[0].title;
const created: string | null | undefined = ({} as Data).products?.nodes[0].created;
const meta: unknown = ({} as Data).products?.nodes[0].meta;
const count: number | undefined = ({} as Data).products?.totalCount;
const vars: VariablesOf<typeof PRODUCTS> = { first: 10 };

// @ts-expect-error the title is a string
const wrong: number | undefined = ({} as Data).products?.nodes[0].title;

// @ts-expect-error wrong variable type
const badVars: VariablesOf<typeof PRODUCTS> = { first: "10" };

export { title, created, meta, count, vars, badVars, wrong };
`,
    );
    fs.writeFileSync(
      path.join(cwd, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          module: "ESNext",
          moduleResolution: "Bundler",
          target: "ES2022",
          skipLibCheck: true,
          types: [],
        },
        include: ["app.ts", "pocketbomb-env.d.ts"],
      }),
    );

    const tsc = path.join(__dirname, "../../node_modules/typescript/bin/tsc");
    let output = "";
    try {
      execFileSync(process.execPath, [tsc, "-p", cwd], { encoding: "utf8", stdio: "pipe" });
    } catch (err: any) {
      output = String(err.stdout) + String(err.stderr);
    }
    assert.equal(output, "", "the typed app typechecks");
  });

  test("watchCodegen() regenerates on schema changes and reports the errors", async function () {
    const cwd = newTmp();
    const changes: Array<string> = [];
    const errors: Array<string> = [];

    let notify: () => void = () => {};
    const waitChange = () => new Promise<void>((r) => (notify = r));

    let next = waitChange();
    const stop = watchCodegen({
      url: api.url,
      cwd,
      interval: 10,
      onChange: (r) => {
        changes.push(fs.readFileSync(r.schemaFile, "utf8"));
        notify();
      },
      onError: (e) => errors.push(String(e)),
    });

    try {
      await next;
      assert.lengthOf(changes, 1);
      assert.notInclude(changes[0], "Review");

      next = waitChange();
      api.schema = buildSchema(
        SDL + "\ntype Review { id: ID! }\nextend type Query { review: Review }",
      );
      await next;
      assert.lengthOf(changes, 2);
      assert.include(changes[1], "type Review");
    } finally {
      stop();
    }
  });
});

describe("dynamite CLI", function () {
  function io() {
    const out: Array<string> = [];
    const err: Array<string> = [];
    return { out, err, io: { log: (l: string) => out.push(l), error: (l: string) => err.push(l) } };
  }

  test("help, version and unknown commands", async function () {
    const a = io();
    assert.equal(await run([], a.io), 0);
    assert.include(a.out[0], "dynamite <command>");

    const b = io();
    assert.equal(await run(["--version"], b.io), 0);
    assert.match(b.out[0], /^\d+\.\d+\.\d+/);

    const c = io();
    assert.equal(await run(["nope"], c.io), 2);
    assert.include(c.err[0], "Unknown command: nope");
  });

  test("codegen", async function () {
    const cwd = newTmp();
    const a = io();
    assert.equal(
      await run(["codegen", "--url", api.url, "--public-key", "pb_pk_2", "--cwd", cwd], a.io),
      0,
    );
    assert.deepEqual(a.out, ["generated .dynamite/schema.graphql, pocketbomb-env.d.ts"]);
    assert.equal(api.requests[0].headers["x-pb-public-key"], "pb_pk_2");

    const b = io();
    await run(["codegen", "--url", api.url, "--cwd", cwd], b.io);
    assert.deepEqual(b.out, ["up to date: .dynamite/schema.graphql, pocketbomb-env.d.ts"]);

    const saved = process.env.POCKETBOMB_URL;
    delete process.env.POCKETBOMB_URL;
    try {
      const c = io();
      assert.equal(await run(["codegen", "--cwd", cwd], c.io), 2);
      assert.include(c.err[0], "missing --url");
    } finally {
      if (saved) process.env.POCKETBOMB_URL = saved;
    }
  });

  test("info", async function () {
    const saved = { ...process.env };
    process.env.POCKETBOMB_URL = "http://pb.local";
    process.env.POCKETBOMB_PUBLIC_KEY = "pb_pk_secretish";
    process.env.POCKETBOMB_PRIVATE_KEY = "pb_sk_never_printed";
    process.env.POCKETBOMB_BIN = "/nonexistent/pocketbomb";
    try {
      const a = io();
      assert.equal(await run(["info"], a.io), 0);
      const text = a.out.join("\n");
      assert.include(text, "POCKETBOMB_URL         http://pb.local");
      assert.include(text, "POCKETBOMB_PUBLIC_KEY  pb_pk_…");
      assert.include(text, "POCKETBOMB_PRIVATE_KEY (set)");
      assert.notInclude(text, "pb_sk_never_printed");
      assert.include(text, "doesn't exist");
    } finally {
      process.env = saved;
    }
  });
});
