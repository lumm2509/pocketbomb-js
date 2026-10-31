// `dynamite check`: validates the graphql() documents of a project against the codegen schema.
//
// Why not gql.tada's `gql-tada check`: it isn't a dependency (@gql.tada/cli-utils), and it finds the schema in a
// tsconfig plugin entry named after gql.tada/graphqlsp, while the projects here use pocketbomb-dynamite/ts-plugin.
// The check itself is small: the TypeScript parser finds the documents and graphql-js validates them.
import fs from "node:fs";
import path from "node:path";
import {
  buildSchema,
  GraphQLError,
  Kind,
  NoUnusedFragmentsRule,
  parse,
  specifiedRules,
  validate,
  visit,
  type DocumentNode,
  type FragmentDefinitionNode,
  type GraphQLSchema,
} from "graphql";
import { DEFAULT_SCHEMA_FILE } from "./codegen";

const IGNORED_DIRS = new Set([
  "node_modules",
  "build",
  "dist",
  ".git",
  ".react-router",
  ".turbo",
  ".next",
  ".dynamite",
]);

export interface CheckProblem {
  file: string;
  line: number;
  column: number;
  message: string;
}

export interface CheckResult {
  documents: number;
  problems: Array<CheckProblem>;
}

interface FoundDocument {
  file: string;
  /** The zero based position of the document text start in its file. */
  line: number;
  column: number;
  text: string;
}

function sourceFiles(dir: string, result: Array<string> = []): Array<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) sourceFiles(path.join(dir, entry.name), result);
    } else if (/\.(ts|tsx|mts|cts)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      result.push(path.join(dir, entry.name));
    }
  }
  return result;
}

async function loadTypeScript(): Promise<typeof import("typescript")> {
  try {
    const ts: any = await import("typescript");
    return ts.default || ts;
  } catch {
    throw new Error("dynamite check needs the typescript package installed in the project.");
  }
}

function findDocuments(ts: typeof import("typescript"), file: string): Array<FoundDocument> {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const result: Array<FoundDocument> = [];

  const visitNode = (node: import("typescript").Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "graphql"
    ) {
      const arg = node.arguments[0];
      if (arg && (ts.isNoSubstitutionTemplateLiteral(arg) || ts.isStringLiteral(arg))) {
        // +1: the opening quote
        const start = source.getLineAndCharacterOfPosition(arg.getStart(source) + 1);
        result.push({ file, line: start.line, column: start.character, text: arg.text });
      } else if (arg) {
        const start = source.getLineAndCharacterOfPosition(arg.getStart(source));
        result.push({ file, line: start.line, column: start.character, text: "" });
      }
    }
    ts.forEachChild(node, visitNode);
  };
  visitNode(source);

  return result;
}

function usedFragments(root: DocumentNode, all: Map<string, FragmentDefinitionNode>) {
  const used = new Map<string, FragmentDefinitionNode>();
  const collect = (node: DocumentNode | FragmentDefinitionNode) => {
    visit(node, {
      FragmentSpread(spread) {
        const fragment = all.get(spread.name.value);
        if (fragment && !used.has(spread.name.value)) {
          used.set(spread.name.value, fragment);
          collect(fragment);
        }
      },
    });
  };
  collect(root);
  return used;
}

function problemOf(doc: FoundDocument, error: GraphQLError): CheckProblem {
  const location = error.locations?.[0];
  return {
    file: doc.file,
    // the first line of the text continues the source line of the opening quote
    line: doc.line + (location?.line ?? 1),
    column: location?.line === 1 ? doc.column + location.column : (location?.column ?? 1),
    message: error.message,
  };
}

/**
 * Validates every `graphql()` document of a project (fragments are resolved by name across
 * the project; a document that isn't a plain string can't be checked and is reported).
 */
export async function check(
  options: { cwd?: string; schemaFile?: string; schema?: GraphQLSchema } = {},
): Promise<CheckResult> {
  const cwd = path.resolve(options.cwd || process.cwd());
  const schemaFile = path.resolve(cwd, options.schemaFile || DEFAULT_SCHEMA_FILE);
  const ts = await loadTypeScript();

  const documents = sourceFiles(cwd).flatMap((file) => findDocuments(ts, file));
  if (!documents.length) {
    return { documents: 0, problems: [] };
  }

  if (!options.schema && !fs.existsSync(schemaFile)) {
    throw new Error(
      "Missing " + path.relative(cwd, schemaFile) + ": run `dynamite codegen` first.",
    );
  }
  const schema = options.schema || buildSchema(fs.readFileSync(schemaFile, "utf8"));
  const problems: Array<CheckProblem> = [];
  const parsed: Array<{ doc: FoundDocument; ast: DocumentNode }> = [];
  const fragments = new Map<string, FragmentDefinitionNode>();
  const fragmentOwners = new Map<string, FoundDocument>();

  for (const doc of documents) {
    if (!doc.text) {
      problems.push({
        file: doc.file,
        line: doc.line + 1,
        column: doc.column + 1,
        message: "graphql() needs a plain string document to be checked (no ${} interpolation).",
      });
      continue;
    }
    try {
      const ast = parse(doc.text);
      parsed.push({ doc, ast });
      for (const definition of ast.definitions) {
        if (definition.kind !== Kind.FRAGMENT_DEFINITION) continue;
        const name = definition.name.value;
        if (fragmentOwners.has(name)) {
          problems.push({
            file: doc.file,
            line: doc.line + (definition.loc?.startToken.line ?? 1),
            column: 1,
            message: `Duplicated fragment "${name}" (also in ${path.relative(cwd, fragmentOwners.get(name)!.file)}).`,
          });
        }
        fragments.set(name, definition);
        fragmentOwners.set(name, doc);
      }
    } catch (err) {
      problems.push(problemOf(doc, err as GraphQLError));
    }
  }

  // a document only holding fragments is valid on its own
  const rules = specifiedRules.filter((rule) => rule !== NoUnusedFragmentsRule);

  for (const { doc, ast } of parsed) {
    const own = new Set(
      ast.definitions.flatMap((d) => (d.kind === Kind.FRAGMENT_DEFINITION ? [d.name.value] : [])),
    );
    const imported = [...usedFragments(ast, fragments).entries()]
      .filter(([name]) => !own.has(name))
      .map(([, fragment]) => fragment);

    const errors = validate(
      schema,
      { ...ast, definitions: [...ast.definitions, ...imported] },
      rules,
    );
    for (const error of errors) {
      // an error inside an imported fragment is reported once, by the document that owns it
      if (imported.some((f) => error.nodes?.some((n) => isInside(n, f)))) continue;
      problems.push(problemOf(doc, error));
    }
  }

  problems.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);

  return { documents: documents.length, problems };
}

function isInside(node: { loc?: { source: unknown } }, fragment: FragmentDefinitionNode): boolean {
  return !!node.loc && node.loc.source === fragment.loc?.source;
}
