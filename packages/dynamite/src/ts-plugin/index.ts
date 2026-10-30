// @pocketbomb/dynamite/ts-plugin
//
// The TypeScript language service plugin of the PocketBomb apps: `@0no-co/graphqlsp`
// preconfigured for the dynamite `graphql()` documents (GraphQL completions, hover and
// diagnostics from the codegen schema).
//
// tsconfig.json:
//   { "compilerOptions": { "plugins": [{ "name": "@pocketbomb/dynamite/ts-plugin" }] } }
import graphqlsp from "@0no-co/graphqlsp";
import type ts from "typescript/lib/tsserverlibrary";
import { graphqlspConfig } from "./config";

const init: ts.server.PluginModuleFactory = (modules) => {
  const plugin = (graphqlsp as unknown as ts.server.PluginModuleFactory)(modules);

  return {
    ...plugin,
    create(info) {
      info.config = graphqlspConfig(info.config);
      return plugin.create(info);
    },
  };
};

export default init;
