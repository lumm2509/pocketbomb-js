import { BaseService } from "../services/base";
import type { CommonOptions } from "../tools/options";

export interface GraphQLSchemaState {
  schema: string;
  /** "stored" (the last applied schema) or "derived" (from the current collections). */
  source: string;
  /** Whether the schema can be applied (the server has a migrations writer). */
  canApply: boolean;
  /** Whether the stored schema no longer describes the current collections. */
  drifted?: boolean;
}

export interface GraphQLSchemaChange {
  collection: string;
  action: string;
  fields?: Array<string>;
  destructive?: boolean;
}

export interface GraphQLSchemaError {
  line: number;
  column: number;
  message: string;
}

export interface GraphQLSchemaPlan {
  changes: Array<GraphQLSchemaChange>;
  warnings: Array<string>;
  errors: Array<GraphQLSchemaError>;
  /** Passed to {@link GraphQLSchemaService.apply}; empty for a plan with errors. */
  planHash: string;
  canApply: boolean;
}

/**
 * GraphQLSchemaService handles the schema editor API (`/api/graphql/schema`): a collections
 * write operation like the {@link CollectionService} and the same one the dashboard editor uses.
 */
export class GraphQLSchemaService extends BaseService {
  /**
   * Returns the stored schema (or the one derived from the collections if there is none).
   *
   * @throws {ClientResponseError}
   */
  async get(options?: CommonOptions): Promise<GraphQLSchemaState> {
    return this.client.send("/api/graphql/schema", Object.assign({ method: "GET" }, options));
  }

  /**
   * Returns the changes of the provided SDL schema without applying them.
   * An invalid schema is not an error response: see `errors`.
   *
   * @throws {ClientResponseError}
   */
  async plan(schema: string, options?: CommonOptions): Promise<GraphQLSchemaPlan> {
    return this.client.send(
      "/api/graphql/schema/plan",
      Object.assign({ method: "POST", body: { schema } }, options),
    );
  }

  /**
   * Applies a planned schema: the collections change in one transaction and the server
   * writes the migration.
   *
   * @throws {ClientResponseError} e.g. 409 for a stale plan or a server without a migrations writer.
   */
  async apply(
    data: { schema: string; planHash: string; allowDestructive?: boolean },
    options?: CommonOptions,
  ): Promise<GraphQLSchemaPlan> {
    return this.client.send(
      "/api/graphql/schema/apply",
      Object.assign({ method: "POST", body: data }, options),
    );
  }
}
