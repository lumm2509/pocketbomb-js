import type { Client } from "../client";
import { BaseService } from "../services/base";
import { RecordService } from "../records/records";
import { ListResult, RecordModel } from "../tools/dtos";
import { CommonOptions, ListOptions } from "../tools/options";

export interface WebhookModel extends RecordModel {
  name: string;
  uri: string;
  topics: Array<string>;
  filter: string;
  fields: string;
  active: boolean;
  disabledReason: string;
  actorRef: string;
  client: string;
  applicationInstallationRef: string;
}

export interface WebhookTopicInfo {
  topic: string;
  label: string;
  description?: string;
}

export interface WebhookTopicsList {
  collections: Array<{
    id: string;
    name: string;
    type: string;
    system: boolean;
    topics: Array<WebhookTopicInfo>;
  }>;
  wildcards: Array<WebhookTopicInfo>;
  custom: Array<WebhookTopicInfo>;
}

export interface WebhookSecret {
  id: string;
  secret: string;
}

export interface WebhookDeliveryModel {
  [key: string]: any;

  id: string;
  webhook: string;
  eventId: string;
  topic: string;
  topicName: string;
  apiVersion: string;
  triggeredAt: string;
  status: string;
  attempts: number;
  nextAttemptAt: string;
  payload: any;
  requestHeaders: { [key: string]: string };
  requestBody: string;
  responseStatus: number;
  responseHeaders: { [key: string]: string };
  responseBody: string;
  error: string;
  durationMs: number;
  test: boolean;
  redeliveryOf: string;
  created: string;
  updated: string;
}

export interface WebhookDeliveriesStatsOptions extends CommonOptions {
  interval?: "minute" | "hour" | "day";
  groupBy?: "status" | "topic" | "webhook";
  filter?: string;
}

/**
 * WebhookDeliveryService handles the webhook deliveries log.
 */
export class WebhookDeliveryService extends BaseService {
  /**
   * Returns paginated webhook deliveries list
   * (only the deliveries of the webhooks accessible to the actor).
   *
   * @throws {ClientResponseError}
   */
  async getList(
    page = 1,
    perPage = 30,
    options?: ListOptions,
  ): Promise<ListResult<WebhookDeliveryModel>> {
    options = Object.assign({ method: "GET" }, options);
    options.query = Object.assign({ page, perPage }, options.query);

    return this.client.send("/api/webhooks/deliveries", options);
  }

  /**
   * Returns a single webhook delivery by its id.
   *
   * @throws {ClientResponseError}
   */
  async getOne(id: string, options?: CommonOptions): Promise<WebhookDeliveryModel> {
    options = Object.assign({ method: "GET" }, options);

    return this.client.send("/api/webhooks/deliveries/" + encodeURIComponent(id), options);
  }

  /**
   * Returns the webhook deliveries statistics.
   *
   * @throws {ClientResponseError}
   */
  async getStats(options?: WebhookDeliveriesStatsOptions): Promise<Array<any>> {
    options = Object.assign({ method: "GET" }, options);

    return this.client.send("/api/webhooks/deliveries/stats", options);
  }

  /**
   * Queues a new delivery attempt of the specified delivery.
   *
   * @throws {ClientResponseError}
   */
  async redeliver(id: string, options?: CommonOptions): Promise<WebhookDeliveryModel> {
    options = Object.assign({ method: "POST" }, options);

    return this.client.send(
      "/api/webhooks/deliveries/" + encodeURIComponent(id) + "/redeliver",
      options,
    );
  }

  /**
   * Deletes all webhook deliveries.
   *
   * @throws {ClientResponseError}
   */
  async truncate(options?: CommonOptions): Promise<boolean> {
    options = Object.assign({ method: "DELETE" }, options);

    return this.client.send("/api/webhooks/deliveries", options).then(() => true);
  }
}

/**
 * WebhookService handles the webhook subscriptions.
 *
 * The subscriptions CRUD uses the regular records API of the `_webhooks` system
 * collection (inherited `getList`, `getOne`, `create`, `update`, `delete`, etc.).
 */
export class WebhookService extends RecordService<WebhookModel> {
  /**
   * The webhook deliveries log.
   */
  readonly deliveries: WebhookDeliveryService;

  constructor(client: Client) {
    super(client, "_webhooks");

    this.deliveries = new WebhookDeliveryService(client);
  }

  /**
   * Returns the available webhook topics (per collection, wildcards and custom topics).
   *
   * @throws {ClientResponseError}
   */
  async topics(options?: CommonOptions): Promise<WebhookTopicsList> {
    options = Object.assign({ method: "GET" }, options);

    return this.client.send("/api/webhooks/topics", options);
  }

  /**
   * Reveals the current plain signing secret of the specified subscription.
   *
   * @throws {ClientResponseError}
   */
  async revealSecret(id: string, options?: CommonOptions): Promise<WebhookSecret> {
    options = Object.assign({ method: "GET" }, options);

    return this.client.send(this.subscriptionPath(id) + "/secret", options);
  }

  /**
   * Generates a new signing secret for the specified subscription.
   *
   * @throws {ClientResponseError}
   */
  async rotateSecret(id: string, options?: CommonOptions): Promise<WebhookSecret> {
    options = Object.assign({ method: "POST" }, options);

    return this.client.send(this.subscriptionPath(id) + "/rotate-secret", options);
  }

  /**
   * Sends a test delivery of the specified subscription
   * (optionally for a specific topic) and returns the delivery result.
   *
   * @throws {ClientResponseError}
   */
  async test(id: string, topic?: string, options?: CommonOptions): Promise<WebhookDeliveryModel> {
    options = Object.assign({ method: "POST", body: topic ? { topic } : {} }, options);

    return this.client.send(this.subscriptionPath(id) + "/test", options);
  }

  private subscriptionPath(id: string): string {
    return "/api/webhooks/subscriptions/" + encodeURIComponent(id);
  }
}
