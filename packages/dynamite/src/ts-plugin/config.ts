import { DEFAULT_SCHEMA_FILE } from "../shared/constants";

/**
 * The plugin options (all optional; the other graphqlsp options are passed through).
 */
export interface DynamiteTsPluginConfig {
  /** The schema SDL/introspection file or URL (default to `.dynamite/schema.graphql`). */
  schema?: string;
  [key: string]: unknown;
}

/**
 * Returns the graphqlsp configuration of a PocketBomb app: the codegen schema and the
 * gql.tada `graphql()` call documents.
 *
 * The gql.tada env is written by `dynamite codegen` (not by the editor), so `tadaOutputLocation`
 * isn't set by default.
 */
export function graphqlspConfig(config: DynamiteTsPluginConfig = {}): Record<string, unknown> {
  return {
    schema: DEFAULT_SCHEMA_FILE,
    templateIsCallExpression: true,
    template: "graphql",
    trackFieldUsage: false,
    shouldCheckForColocatedFragments: false,
    ...config,
  };
}
