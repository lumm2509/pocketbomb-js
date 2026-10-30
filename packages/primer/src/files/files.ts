import { BaseService } from "../services/base";
import { CommonOptions, FileOptions, serializeQueryParams } from "../tools/options";

export class FileService extends BaseService {
  /**
   * Builds and returns an absolute record file url for the provided filename.
   */
  getURL(record: { [key: string]: any }, filename: string, queryParams: FileOptions = {}): string {
    if (!filename || !record?.id || !(record?.collectionId || record?.collectionName)) {
      return "";
    }

    const parts = [];
    parts.push("api");
    parts.push("files");
    parts.push(encodeURIComponent(record.collectionId || record.collectionName));
    parts.push(encodeURIComponent(record.id));
    parts.push(encodeURIComponent(filename));

    let result = this.client.buildURL(parts.join("/"));

    // normalize the download query param for consistency with the Dart sdk
    if (queryParams.download === false) {
      delete queryParams.download;
    }

    const params = serializeQueryParams(queryParams);
    if (params) {
      result += (result.includes("?") ? "&" : "?") + params;
    }

    return result;
  }

  /**
   * Requests a new private file access token for the current auth model.
   *
   * @throws {ClientResponseError}
   */
  async getToken(options?: CommonOptions): Promise<string> {
    options = Object.assign(
      {
        method: "POST",
      },
      options,
    );

    return this.client.send("/api/files/token", options).then((data) => data?.token || "");
  }
}
