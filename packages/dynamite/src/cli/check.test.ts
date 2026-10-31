import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, assert, describe, test } from "vitest";
import { check } from "./check";
import { run } from "./index";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "dynamite-check-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const SCHEMA = `type Todo { id: ID! title: String! }
type Query { todos(first: Int): [Todo!]! }
`;

function project(name: string, files: Record<string, string>): string {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, ".dynamite"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".dynamite/schema.graphql"), SCHEMA);
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  return dir;
}

const io = () => {
  const out: Array<string> = [];
  const err: Array<string> = [];
  return { out, err, io: { log: (l: string) => out.push(l), error: (l: string) => err.push(l) } };
};

describe("dynamite check", function () {
  test("valid documents, fragments across files, ignored dirs", async function () {
    const cwd = project("ok", {
      "app/fragments.ts": "export const F = graphql(`fragment F on Todo { title }`);\n",
      "app/page.tsx": "const Q = graphql(`query { todos(first: 1) { id ...F } }`, [F]);\n",
      "node_modules/x/index.ts": "graphql(`query { nope }`);\n",
      "build/index.ts": "graphql(`query { nope }`);\n",
      "other.ts": "somethingElse(`query { nope }`);\n",
    });

    const result = await check({ cwd });
    assert.deepEqual(result, { documents: 2, problems: [] });

    const a = io();
    assert.equal(await run(["check", "--cwd", cwd], a.io), 0);
    assert.include(a.out[0], "2 documents OK");
  });

  test("an unknown field, a bad argument and a syntax error point to file:line:column", async function () {
    const cwd = project("bad", {
      "app/q.ts": [
        "export const A = graphql(`",
        "  query A {",
        "    todos(first: 1) {",
        "      nope",
        "    }",
        "  }",
        "`);",
        "export const B = graphql(`query B { todos(last: 1) { id } }`);",
        "export const C = graphql(`query C {`);",
        "",
      ].join("\n"),
    });

    const { documents, problems } = await check({ cwd });
    assert.equal(documents, 3);
    assert.deepEqual(
      problems.map((p) => [path.relative(cwd, p.file), p.line, p.message.substring(0, 20)]),
      [
        ["app/q.ts", 4, 'Cannot query field "'],
        ["app/q.ts", 8, 'Unknown argument "la'],
        ["app/q.ts", 9, "Syntax Error: Expect"],
      ],
    );
    assert.equal(problems[0].column, 7);
    // the first line of the text is the source line of the quote: the column continues it
    assert.equal(
      problems[1].column,
      "export const B = graphql(`".length + "query B { todos(".length + 1,
    );

    const a = io();
    assert.equal(await run(["check", "--cwd", cwd], a.io), 1);
    assert.include(a.err[0], "app/q.ts:4:7 Cannot query field");
    assert.include(a.err[3], "3 problem(s) in 3 documents");
  });

  test("an error in a fragment is reported once, at the fragment", async function () {
    const cwd = project("fragment", {
      "a.ts": "export const F = graphql(`fragment F on Todo { nope }`);\n",
      "b.ts": "const Q = graphql(`query { todos { ...F } }`, [F]);\n",
      "c.ts": "const R = graphql(`query { todos { ...Missing } }`);\n",
    });

    const { problems } = await check({ cwd });
    assert.deepEqual(
      problems.map((p) => [path.basename(p.file), p.message]),
      [
        ["a.ts", 'Cannot query field "nope" on type "Todo".'],
        ["c.ts", 'Unknown fragment "Missing".'],
      ],
    );
  });

  test("a document that can't be read, a missing schema", async function () {
    const cwd = project("dynamic", { "a.ts": "const Q = graphql(`query { ${x} }`);\n" });
    const { problems } = await check({ cwd });
    assert.match(problems[0].message, /plain string document/);
    assert.equal(problems[0].line, 1);

    fs.rmSync(path.join(cwd, ".dynamite"), { recursive: true });
    const a = io();
    assert.equal(await run(["check", "--cwd", cwd], a.io), 2);
    assert.include(a.err[0], "run `dynamite codegen` first");

    // no documents: nothing to check, the schema isn't needed (e.g. an application without GraphQL)
    const empty = fs.mkdtempSync(path.join(root, "empty-"));
    const b = io();
    assert.equal(await run(["check", "--cwd", empty], b.io), 0);
    assert.include(b.out[0], "0 documents OK");
  });
});
