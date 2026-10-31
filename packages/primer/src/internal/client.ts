import { Client, type ClientOptions } from "../client";
import { attachAccount, defaultAccountAuthStore, type AccountClientOptions } from "../factories";
import {
  OAuth2GrantType,
  OAuth2TokenType,
  oauth2FormRequest,
  oauth2IssuerPath,
  type OAuth2TokenResponse,
} from "../auth/oauth2";
import { ApplicationService } from "./applications";
import { BackupService } from "./backups";
import { CollectionService } from "./collections";
import { CronService } from "./crons";
import { GraphQLSchemaService } from "./graphql-schema";
import { LLMService } from "./llm";
import { LogService } from "./logs";
import { OAuth2ClientService } from "./oauth2-clients";
import { RoleService } from "./roles";
import { SessionService } from "./sessions";
import { SettingsService } from "./settings";
import { SQLService } from "./sql";
import { WebhookService } from "./webhooks";

/**
 * DashboardClient is the client of the PocketBomb dashboard (staff tooling):
 * the regular {@link Client} with the dashboard internal services.
 *
 * NB! The dashboard internal endpoints are not a public API (they may change without notice).
 */
export class DashboardClient extends Client {
  /** The **Settings** internal API. */
  readonly settings: SettingsService;
  /** The **Collections** internal API. */
  readonly collections: CollectionService;
  /** The **Logs** internal API. */
  readonly logs: LogService;
  /** The **Backups** internal API. */
  readonly backups: BackupService;
  /** The **Crons** internal API. */
  readonly crons: CronService;
  /** The **SQL** internal API. */
  readonly sql: SQLService;
  /** The **RBAC roles** internal API. */
  readonly roles: RoleService;
  /** The **OAuth2 clients and API keys** internal API. */
  readonly oauth2Clients: OAuth2ClientService;
  /** The **Webhooks** internal API. */
  readonly webhooks: WebhookService;
  /** The **LLM** internal API. */
  readonly llm: LLMService;
  /** The **Applications** internal API. */
  readonly applications: ApplicationService;
  /** The staff **auth sessions** internal API. */
  readonly sessions: SessionService;
  /** The **GraphQL schema editor** API. */
  readonly graphqlSchema: GraphQLSchemaService;

  constructor(baseURL = "/", options: ClientOptions = {}) {
    super(baseURL, options);

    this.settings = new SettingsService(this);
    this.graphqlSchema = new GraphQLSchemaService(this);
    this.collections = new CollectionService(this);
    this.logs = new LogService(this);
    this.backups = new BackupService(this);
    this.crons = new CronService(this);
    this.sql = new SQLService(this);
    this.roles = new RoleService(this);
    this.oauth2Clients = new OAuth2ClientService(this);
    this.webhooks = new WebhookService(this);
    this.llm = new LLMService(this);
    this.applications = new ApplicationService(this);
    this.sessions = new SessionService(this);
  }

  /**
   * Issues an impersonation access token for the specified auth record
   * (RFC 8693 token exchange with the current account access token as actor token).
   *
   * The token is returned (it is not stored); use it for example with
   * `new Client(url)` + `client.authStore.save(token)`.
   *
   * @throws {ClientResponseError}
   */
  async impersonate(collectionIdOrName: string, recordId: string): Promise<OAuth2TokenResponse> {
    const account = this.account;

    const exchange = () =>
      oauth2FormRequest<OAuth2TokenResponse>(
        this,
        oauth2IssuerPath(collectionIdOrName) + "/token",
        {
          grant_type: OAuth2GrantType.tokenExchange,
          subject_token: recordId,
          subject_token_type: OAuth2TokenType.recordId,
          actor_token: this.authStore.token,
          actor_token_type: OAuth2TokenType.accessToken,
        },
        { clientId: account.config.clientId },
      );

    try {
      return await exchange();
    } catch (err: any) {
      // retry once with a refreshed actor token
      if (err?.status == 400 && (await account.refresh())) {
        return exchange();
      }
      throw err;
    }
  }
}

/**
 * Creates the dashboard account client: a {@link DashboardClient} signed in with the
 * OAuth2 account flow of a staff issuer (e.g. `_superusers` + `pb_dashboard`).
 */
export function createDashboardClient(options: AccountClientOptions): DashboardClient {
  const client = new DashboardClient(options.url, {
    authStore: options.authStore || defaultAccountAuthStore(options.collection, options.clientId),
    lang: options.lang,
    publicKey: options.publicKey,
    fetch: options.fetch,
    autoCancellation: options.autoCancellation,
  });

  return attachAccount(client, options);
}
