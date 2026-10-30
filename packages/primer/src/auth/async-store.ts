import { AuthStore, AuthRecord, AuthTokenMeta, extractAuthTokenMeta } from "./store";

export type AsyncSaveFunc = (serializedPayload: string) => Promise<void>;

export type AsyncClearFunc = () => Promise<void>;

type queueFunc = () => Promise<void>;

/**
 * An AsyncStorage-like key-value storage
 * (e.g. `@react-native-async-storage/async-storage`, `expo-secure-store` wrappers, localForage).
 */
export interface AsyncKeyValueStorage {
  getItem(key: string): Promise<string | null | undefined> | string | null | undefined;
  setItem(key: string, value: string): Promise<unknown> | unknown;
  removeItem(key: string): Promise<unknown> | unknown;
}

/**
 * AsyncAuthStore is a helper auth store implementation
 * that could be used with any external async persistent layer
 * (key-value db, local file, etc.).
 *
 * Here is an example with the React Native AsyncStorage package
 * (see also {@link AsyncAuthStore.fromStorage}):
 *
 * ```
 * import AsyncStorage from "@react-native-async-storage/async-storage";
 * import { AsyncAuthStore, createAccountClient } from "@pocketbomb/primer";
 *
 * const authStore = new AsyncAuthStore({
 *     save:    async (serialized) => AsyncStorage.setItem("pb_auth", serialized),
 *     clear:   async () => AsyncStorage.removeItem("pb_auth"),
 *     initial: AsyncStorage.getItem("pb_auth"),
 * });
 * ```
 */
export class AsyncAuthStore extends AuthStore {
  private saveFunc: AsyncSaveFunc;
  private clearFunc?: AsyncClearFunc;
  private queue: Array<queueFunc> = [];

  /**
   * Resolves after the initial state was loaded
   * (await it before reading the store state on startup).
   */
  readonly ready: Promise<void>;

  /**
   * Creates an AsyncAuthStore persisted under `key` of an AsyncStorage-like storage
   * (the state is loaded from the storage and removed from it on clear).
   *
   * Example (React Native):
   *
   * ```
   * import AsyncStorage from "@react-native-async-storage/async-storage";
   *
   * const authStore = AsyncAuthStore.fromStorage(AsyncStorage, "my_app_auth");
   * await authStore.ready;
   * ```
   */
  static fromStorage(storage: AsyncKeyValueStorage, key = "pb_auth"): AsyncAuthStore {
    return new AsyncAuthStore({
      save: async (serialized) => {
        await storage.setItem(key, serialized);
      },
      clear: async () => {
        await storage.removeItem(key);
      },
      initial: Promise.resolve().then(() => storage.getItem(key)),
    });
  }

  constructor(config: {
    // The async function that is called every time
    // when the auth store state needs to be persisted.
    save: AsyncSaveFunc;

    /// An *optional* async function that is called every time
    /// when the auth store needs to be cleared.
    ///
    /// If not explicitly set, `saveFunc` with empty data will be used.
    clear?: AsyncClearFunc;

    // An *optional* initial data to load into the store.
    initial?: string | Promise<any>;
  }) {
    super();

    this.saveFunc = config.save;
    this.clearFunc = config.clear;

    let loaded: () => void = () => {};
    this.ready = new Promise((resolve) => (loaded = resolve));

    this._enqueue(() => this._loadInitial(config.initial).finally(loaded));
  }

  /**
   * @inheritdoc
   */
  save(token: string, record?: AuthRecord, meta?: AuthTokenMeta | null): void {
    super.save(token, record, meta);

    let value = "";
    try {
      value = JSON.stringify(Object.assign({}, this.meta, { token, record }));
    } catch (err) {
      console.warn("AsyncAuthStore: failed to stringify the new state");
    }

    this._enqueue(() => this.saveFunc(value));
  }

  /**
   * @inheritdoc
   */
  clear(): void {
    super.clear();

    if (this.clearFunc) {
      this._enqueue(() => this.clearFunc!());
    } else {
      this._enqueue(() => this.saveFunc(""));
    }
  }

  /**
   * Resolves once all pending (queued) storage writes are completed.
   */
  flush(): Promise<void> {
    return new Promise((resolve) => {
      this._enqueue(async () => resolve());
    });
  }

  /**
   * Initializes the auth store state.
   */
  private async _loadInitial(payload?: string | Promise<any>) {
    try {
      payload = await payload;

      if (payload) {
        let parsed;
        if (typeof payload === "string") {
          parsed = JSON.parse(payload) || {};
        } else if (typeof payload === "object") {
          parsed = payload;
        }

        this.save(parsed.token || "", parsed.record || null, extractAuthTokenMeta(parsed));
      }
    } catch (_) {}
  }

  /**
   * Appends an async function to the queue.
   */
  private _enqueue(asyncCallback: () => Promise<void>) {
    this.queue.push(asyncCallback);

    if (this.queue.length == 1) {
      this._dequeue();
    }
  }

  /**
   * Starts the queue processing.
   */
  private _dequeue() {
    if (!this.queue.length) {
      return;
    }

    this.queue[0]().finally(() => {
      this.queue.shift();

      if (!this.queue.length) {
        return;
      }

      this._dequeue();
    });
  }
}
