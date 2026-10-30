/**
 * ClientResponseError is a custom Error class that is intended to wrap
 * and normalize any error thrown by `Client.send()`.
 */
export class ClientResponseError extends Error {
  url: string = "";
  status: number = 0;
  response: { [key: string]: any } = {};
  isAbort: boolean = false;
  originalError: any = null;

  /**
   * The OAuth2 error code of the OAuth2 protocol error responses
   * (e.g. "invalid_grant"; empty for the regular API errors).
   */
  oauth2Error: string = "";

  /**
   * The OAuth2 `error_description` of the OAuth2 protocol error responses (if any).
   */
  oauth2ErrorDescription: string = "";

  constructor(errData?: any) {
    super("ClientResponseError");

    // Set the prototype explicitly.
    // https://github.com/Microsoft/TypeScript-wiki/blob/main/Breaking-Changes.md#extending-built-ins-like-error-array-and-map-may-no-longer-work
    Object.setPrototypeOf(this, ClientResponseError.prototype);

    if (errData !== null && typeof errData === "object") {
      this.originalError = errData.originalError;
      this.url = typeof errData.url === "string" ? errData.url : "";
      this.status = typeof errData.status === "number" ? errData.status : 0;

      // note: DOMException is not implemented yet in React Native
      // and aborting a fetch throws a plain Error with message "Aborted".
      this.isAbort =
        !!errData.isAbort || errData.name === "AbortError" || errData.message === "Aborted";

      if (errData.response !== null && typeof errData.response === "object") {
        this.response = errData.response;
      } else if (errData.data !== null && typeof errData.data === "object") {
        this.response = errData.data;
      } else {
        this.response = {};
      }
    }

    if (!this.originalError && !(errData instanceof ClientResponseError)) {
      this.originalError = errData;
    }

    // OAuth2 protocol errors (RFC 6749 section 5.2)
    if (typeof this.response?.error === "string") {
      this.oauth2Error = this.response.error;
      this.oauth2ErrorDescription =
        typeof this.response.error_description === "string" ? this.response.error_description : "";
    } else if (errData instanceof ClientResponseError) {
      this.oauth2Error = errData.oauth2Error;
      this.oauth2ErrorDescription = errData.oauth2ErrorDescription;
    }

    this.name = "ClientResponseError " + this.status;
    this.message = this.response?.message || this.oauth2ErrorDescription || this.oauth2Error;
    if (!this.message) {
      if (this.isAbort) {
        this.message =
          "The request was aborted (most likely autocancelled by a newer request with the same requestKey; pass `requestKey: null` to disable it).";
      } else if (this.originalError?.cause?.message?.includes("ECONNREFUSED ::1")) {
        this.message =
          "Failed to connect to the PocketBomb server. Try changing the client URL from localhost to 127.0.0.1.";
      } else {
        this.message = "Something went wrong.";
      }
    }

    // set this.cause so that JS debugging tools can automatically connect
    // the dots between the original error and the wrapped one
    this.cause = this.originalError;
  }

  /**
   * Alias for `this.response` for backward compatibility.
   */
  get data() {
    return this.response;
  }

  /**
   * Make a POJO's copy of the current error class instance.
   * @see https://github.com/vuex-orm/vuex-orm/issues/255
   */
  toJSON() {
    return { ...this };
  }
}
