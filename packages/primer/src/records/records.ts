import type { Client } from "../client";
import { UnsubscribeFunc } from "../realtime/realtime";
import { CrudService } from "./crud";
import { ListResult, RecordModel } from "../tools/dtos";
import {
  CommonOptions,
  RecordFullListOptions,
  RecordListOptions,
  RecordOptions,
  RecordSubscribeOptions,
} from "../tools/options";

export interface RecordSubscription<T = RecordModel> {
  action: string; // eg. create, update, delete
  record: T;
}

export class RecordService<M = RecordModel> extends CrudService<M> {
  readonly collectionIdOrName: string;

  constructor(client: Client, collectionIdOrName: string) {
    super(client);

    this.collectionIdOrName = collectionIdOrName;
  }

  /**
   * @inheritdoc
   */
  get baseCrudPath(): string {
    return this.baseCollectionPath + "/records";
  }

  /**
   * Returns the current collection service base path.
   */
  get baseCollectionPath(): string {
    return "/api/collections/" + encodeURIComponent(this.collectionIdOrName);
  }

  // ---------------------------------------------------------------
  // Realtime handlers
  // ---------------------------------------------------------------

  /**
   * Subscribe to realtime changes to the specified topic ("*" or record id).
   *
   * If `topic` is the wildcard "*", then this method will subscribe to
   * any record changes in the collection.
   *
   * If `topic` is a record id, then this method will subscribe only
   * to changes of the specified record id.
   *
   * It's OK to subscribe multiple times to the same topic.
   * You can use the returned `UnsubscribeFunc` to remove only a single subscription.
   * Or use `unsubscribe(topic)` if you want to remove all subscriptions attached to the topic.
   */
  async subscribe<T = M>(
    topic: string,
    callback: (data: RecordSubscription<T>) => void,
    options?: RecordSubscribeOptions,
  ): Promise<UnsubscribeFunc> {
    if (!topic) {
      throw new Error("Missing topic.");
    }

    if (!callback) {
      throw new Error("Missing subscription callback.");
    }

    return this.client.realtime.subscribe(this.collectionIdOrName + "/" + topic, callback, options);
  }

  /**
   * Unsubscribe from all subscriptions of the specified topic
   * ("*" or record id).
   *
   * If `topic` is not set, then this method will unsubscribe from
   * all subscriptions associated to the current collection.
   */
  async unsubscribe(topic?: string): Promise<void> {
    // unsubscribe from the specified topic
    if (topic) {
      return this.client.realtime.unsubscribe(this.collectionIdOrName + "/" + topic);
    }

    // unsubscribe from everything related to the collection
    return this.client.realtime.unsubscribeByPrefix(this.collectionIdOrName);
  }

  // ---------------------------------------------------------------
  // Crud handers
  // ---------------------------------------------------------------
  /**
   * @inheritdoc
   */
  async getFullList<T = M>(options?: RecordFullListOptions): Promise<Array<T>>;

  /**
   * @inheritdoc
   */
  async getFullList<T = M>(batch?: number, options?: RecordListOptions): Promise<Array<T>>;

  /**
   * @inheritdoc
   */
  async getFullList<T = M>(
    batchOrOptions?: number | RecordFullListOptions,
    options?: RecordListOptions,
  ): Promise<Array<T>> {
    if (typeof batchOrOptions == "number") {
      return super.getFullList<T>(batchOrOptions, options);
    }

    const params = Object.assign({}, batchOrOptions, options);

    return super.getFullList<T>(params);
  }

  /**
   * @inheritdoc
   */
  async getList<T = M>(
    page = 1,
    perPage = 30,
    options?: RecordListOptions,
  ): Promise<ListResult<T>> {
    return super.getList<T>(page, perPage, options);
  }

  /**
   * @inheritdoc
   */
  async getFirstListItem<T = M>(filter: string, options?: RecordListOptions): Promise<T> {
    return super.getFirstListItem<T>(filter, options);
  }

  /**
   * @inheritdoc
   */
  async getOne<T = M>(id: string, options?: RecordOptions): Promise<T> {
    return super.getOne<T>(id, options);
  }

  /**
   * @inheritdoc
   */
  async create<T = M>(
    bodyParams?: { [key: string]: any } | FormData,
    options?: RecordOptions,
  ): Promise<T> {
    return super.create<T>(bodyParams, options);
  }

  /**
   * @inheritdoc
   *
   * If the current `client.authStore.record` matches with the updated id, then
   * on success the `client.authStore.record` will be updated with the new response record fields.
   */
  async update<T = M>(
    id: string,
    bodyParams?: { [key: string]: any } | FormData,
    options?: RecordOptions,
  ): Promise<T> {
    return super.update<RecordModel>(id, bodyParams, options).then((item) => {
      if (
        // is record auth
        this.client.authStore.record?.id === item?.id &&
        (this.client.authStore.record?.collectionId === this.collectionIdOrName ||
          this.client.authStore.record?.collectionName === this.collectionIdOrName)
      ) {
        let authExpand = Object.assign({}, this.client.authStore.record.expand);
        let authRecord = Object.assign({}, this.client.authStore.record, item);
        if (authExpand) {
          // for now "merge" only top-level expand
          authRecord.expand = Object.assign(authExpand, item.expand);
        }

        this.client.authStore.save(this.client.authStore.token, authRecord);
      }

      return item as any as T;
    });
  }

  /**
   * @inheritdoc
   *
   * If the current `client.authStore.record` matches with the deleted id,
   * then on success the `client.authStore` will be cleared.
   */
  async delete(id: string, options?: CommonOptions): Promise<boolean> {
    return super.delete(id, options).then((success) => {
      if (
        success &&
        // is record auth
        this.client.authStore.record?.id === id &&
        (this.client.authStore.record?.collectionId === this.collectionIdOrName ||
          this.client.authStore.record?.collectionName === this.collectionIdOrName)
      ) {
        this.client.authStore.clear();
      }

      return success;
    });
  }

  // ---------------------------------------------------------------
  // Account handlers
  // ---------------------------------------------------------------

  // note: the authentication itself is handled by the OAuth2/OIDC
  // account client (see createAccountClient() and pb.account).

  /**
   * Sends auth record verification email request.
   *
   * @throws {ClientResponseError}
   */
  async requestVerification(email: string, options?: CommonOptions): Promise<boolean> {
    options = Object.assign(
      {
        method: "POST",
        body: { email: email },
      },
      options,
    );

    return this.client
      .send(this.baseCollectionPath + "/request-verification", options)
      .then(() => true);
  }

  /**
   * Sends an email change request to the authenticated record.
   *
   * @throws {ClientResponseError}
   */
  async requestEmailChange(newEmail: string, options?: CommonOptions): Promise<boolean> {
    options = Object.assign(
      {
        method: "POST",
        body: { newEmail: newEmail },
      },
      options,
    );

    return this.client
      .send(this.baseCollectionPath + "/request-email-change", options)
      .then(() => true);
  }
}
