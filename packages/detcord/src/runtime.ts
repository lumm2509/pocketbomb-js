// The detcord runtime. NB! `installDetcord` must stay self-contained (no references to the
// module scope) because its source is also the classic script form (see `detcordScript`).

export interface DetcordRecord {
  collection: string;
  id: string;
}

export interface Detcord {
  /** Whether the document is embedded in a parent window. */
  readonly embedded: boolean;
  /** Resolved after the dashboard handshake. */
  readonly ready: Promise<void>;
  /** The launch record context (after `ready`). */
  readonly record: DetcordRecord | null;
  /** Returns a valid session token (cached and renewed before it expires). */
  idToken(): Promise<string>;
  navigation: {
    /** Navigates the application (a registered `onChange` listener or a document load) and syncs the dashboard hash. */
    navigate(path: string): void;
    /** Registers a navigation listener (e.g. the app router); returns its remove function. */
    onChange(listener: (path: string) => void): () => void;
  };
  toast: {
    show(message: string, options?: { isError?: boolean }): void;
  };
  modal: {
    open(options: { id?: string; title?: string; message?: string }): void;
    close(): void;
  };
  titleBar: {
    set(title: string): void;
  };
  resize(height: number): void;
  /** Tells the dashboard that the online session has ended (it shows a "session ended" state). */
  sessionEnded(): void;
}

export function installDetcord(win: any): Detcord {
  if (win.detcord) {
    return win.detcord;
  }

  const SOURCE = "detcord";
  const RESPONSE_TIMEOUT = 15000;
  const RENEW_MARGIN = 5000;
  const HIDDEN_PARAMS = ["id_token", "issuer"];

  const embedded = win.parent !== win;

  // the id_token must not stay in the URL (history, referrers, copied links)
  const stripped = new URL(win.location.href);
  if (stripped.searchParams.has("id_token")) {
    stripped.searchParams.delete("id_token");
    win.history.replaceState(win.history.state, "", stripped.href);
  }

  let parentOrigin = "";
  let record: DetcordRecord | null = null;
  let sequence = 0;
  let cached: { token: string; expiresAt: number } | null = null;
  let tokenRequest: Promise<string> | null = null;
  let helloTimer: any = null;
  let resolveReady: () => void = () => {};

  const pending = new Map<number, { resolve: Function; reject: Function; timer: any }>();
  const listeners = new Set<(path: string) => void>();
  const nativeFetch = win.fetch ? win.fetch.bind(win) : null;

  const ready: Promise<void> = new Promise((resolve) => {
    resolveReady = resolve;
  });

  function post(type: string, payload?: unknown, id?: number) {
    if (parentOrigin) {
      win.parent.postMessage({ source: SOURCE, type, id, payload }, parentOrigin);
    }
  }

  function currentPath(): string {
    const url = new URL(win.location.href);
    for (const name of HIDDEN_PARAMS) {
      url.searchParams.delete(name);
    }
    return url.pathname + url.search;
  }

  function reportPath() {
    post("navigation.changed", { path: currentPath() });
  }

  function applyNavigation(path: string) {
    if (listeners.size) {
      listeners.forEach((listener) => listener(path));
    } else {
      win.location.assign(path);
    }
  }

  win.addEventListener("message", (e: any) => {
    if (e.source !== win.parent || !e.data || e.data.source !== SOURCE) {
      return;
    }

    if (!parentOrigin) {
      // the origin of the first parent that answered the handshake (the signature of its session
      // tokens is verified by the application server and its documents have frame-ancestors)
      if (e.data.type !== "init") {
        return;
      }
      parentOrigin = e.origin;
    } else if (e.origin !== parentOrigin) {
      return;
    }

    const { type, id, payload, result, error } = e.data;

    switch (type) {
      case "init":
        record = payload?.record || null;
        clearInterval(helloTimer);
        resolveReady();
        reportPath();
        break;
      case "response": {
        const entry = pending.get(id);
        if (entry) {
          pending.delete(id);
          clearTimeout(entry.timer);
          if (error) {
            entry.reject(new Error(error));
          } else {
            entry.resolve(result);
          }
        }
        break;
      }
      case "navigation.navigate":
        applyNavigation(String(payload?.path || "/"));
        break;
    }
  });

  function request(type: string, payload?: unknown): Promise<any> {
    return ready.then(
      () =>
        new Promise((resolve, reject) => {
          const id = ++sequence;
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error("The dashboard didn't respond."));
          }, RESPONSE_TIMEOUT);
          pending.set(id, { resolve, reject, timer });
          post(type, payload, id);
        }),
    );
  }

  function idToken(): Promise<string> {
    if (!embedded) {
      return Promise.reject(new Error("The application isn't embedded in the dashboard."));
    }

    // note: the lifetime is measured with the local clock so that a clock skew doesn't matter
    if (cached && win.Date.now() < cached.expiresAt - RENEW_MARGIN) {
      return Promise.resolve(cached.token);
    }

    if (!tokenRequest) {
      tokenRequest = request("idToken")
        .then((result: any) => {
          cached = { token: result.token, expiresAt: win.Date.now() + result.expiresIn * 1000 };
          return result.token as string;
        })
        .finally(() => {
          tokenRequest = null;
        });
    }

    return tokenRequest;
  }

  if (embedded) {
    // no secret: it only asks the parent to start the handshake (repeated until it is mounted)
    const hello = () => win.parent.postMessage({ source: SOURCE, type: "hello" }, "*");
    hello();
    helloTimer = setInterval(hello, 250);

    for (const method of ["pushState", "replaceState"]) {
      const native = win.history[method].bind(win.history);
      win.history[method] = (...args: Array<unknown>) => {
        const result = native(...args);
        reportPath();
        return result;
      };
    }
    win.addEventListener("popstate", reportPath);

    if (nativeFetch) {
      win.fetch = async (input: any, init?: any) => {
        let url: URL;
        try {
          url = new URL(input?.url || String(input), win.location.href);
        } catch {
          return nativeFetch(input, init);
        }

        if (url.origin !== win.location.origin) {
          return nativeFetch(input, init);
        }

        const original = new win.Request(input, init);

        const send = async () => {
          const req = original.clone();
          if (!req.headers.has("Authorization")) {
            try {
              req.headers.set("Authorization", "Bearer " + (await idToken()));
            } catch {
              // send it without a token (the server decides)
            }
          }

          return nativeFetch(req);
        };

        const needsReauthorize = (res: any) =>
          res.status === 401 && !!res.headers.get("x-detcord-reauthorize");

        const response = await send();
        if (!needsReauthorize(response)) {
          return response;
        }

        // a new token and only one retry
        cached = null;
        const retried = await send();
        if (needsReauthorize(retried)) {
          post("session.ended");
        }

        return retried;
      };
    }
  }

  const api: Detcord = {
    embedded,
    ready,
    get record() {
      return record;
    },
    idToken,
    navigation: {
      navigate(path) {
        applyNavigation(path);
      },
      onChange(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    toast: {
      show(message, options = {}) {
        post("toast.show", { message, isError: !!options.isError });
      },
    },
    modal: {
      open(options) {
        post("modal.open", options);
      },
      close() {
        post("modal.close");
      },
    },
    titleBar: {
      set(title) {
        post("titleBar.set", { title });
      },
    },
    resize(height) {
      post("resize", { height });
    },
    sessionEnded() {
      ready.then(() => post("session.ended"));
    },
  };

  win.detcord = api;

  return api;
}
