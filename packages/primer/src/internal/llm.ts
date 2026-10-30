import type { Client } from "../client";
import { BaseService } from "../services/base";
import { ListResult, RecordModel } from "../tools/dtos";
import { CommonOptions, ListOptions, SendOptions } from "../tools/options";

export interface LLMPart {
  [key: string]: any;

  type: "text" | "image" | "tool_call" | "tool_result" | string;
  text?: string;
  image?: { url?: string; data?: string; mimeType?: string };
  toolCall?: { id: string; name: string; arguments: any };
  toolResult?: {
    toolCallId: string;
    name?: string;
    content: string;
    isError?: boolean;
  };
}

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool" | string;
  content?: string;
  parts?: Array<LLMPart>;
}

export interface LLMTool {
  name: string;
  description?: string;
  inputSchema?: { [key: string]: any };
}

export interface LLMChatRequest {
  messages: Array<LLMMessage>;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: Array<LLMTool>;
  toolChoice?: { mode: string; name?: string };
}

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LLMChatResponse {
  model: string;
  message: { role: string; parts: Array<LLMPart> };
  text: string;
  stopReason: string;
  usage: LLMUsage;
}

/**
 * A single normalized stream event (the "delta" SSE events).
 */
export interface LLMStreamEvent {
  [key: string]: any;

  type: string;
  text?: string;
  toolCall?: { index: number; id?: string; name?: string; argumentsDelta?: string };
  usage?: LLMUsage;
  stopReason?: string;
  model?: string;
}

export interface LLMChatStreamOptions extends SendOptions {
  /**
   * Called for every "delta" stream event.
   */
  onDelta?: (event: LLMStreamEvent) => void;
}

export interface LLMProvidersResponse {
  drivers: Array<any>;
  providers: Array<any>;
}

export interface LLMTestProviderData {
  name?: string;
  provider?: string;
  baseURL?: string;
  apiKey?: string;
  defaultModel?: string;
  timeout?: number;
  model?: string;
  prompt?: string;
}

export interface LLMLogsStatsOptions extends CommonOptions {
  interval?: "minute" | "hour" | "day";
  groupBy?: "provider" | "model" | "profile" | "user" | "status";
  filter?: string;
}

export interface LLMLogsTopUsersOptions extends CommonOptions {
  by?: "user" | "ip";
  sort?: "tokens" | "requests";
  limit?: number;
  filter?: string;
}

/**
 * LLMLogService handles the LLM requests log.
 */
export class LLMLogService extends BaseService {
  /**
   * Returns paginated LLM logs list.
   *
   * @throws {ClientResponseError}
   */
  async getList(
    page = 1,
    perPage = 30,
    options?: ListOptions,
  ): Promise<ListResult<{ [key: string]: any }>> {
    options = Object.assign({ method: "GET" }, options);
    options.query = Object.assign({ page, perPage }, options.query);

    return this.client.send("/api/llm/logs", options);
  }

  /**
   * Returns a single LLM log by its id.
   *
   * @throws {ClientResponseError}
   */
  async getOne(id: string, options?: CommonOptions): Promise<{ [key: string]: any }> {
    options = Object.assign({ method: "GET" }, options);

    return this.client.send("/api/llm/logs/" + encodeURIComponent(id), options);
  }

  /**
   * Returns the LLM logs statistics.
   *
   * @throws {ClientResponseError}
   */
  async getStats(options?: LLMLogsStatsOptions): Promise<Array<any>> {
    options = Object.assign({ method: "GET" }, options);

    return this.client.send("/api/llm/logs/stats", options);
  }

  /**
   * Returns the top LLM users (by auth record or IP).
   *
   * @throws {ClientResponseError}
   */
  async getTopUsers(
    options?: LLMLogsTopUsersOptions,
  ): Promise<Array<{ [key: string]: any; record: RecordModel | null }>> {
    options = Object.assign({ method: "GET" }, options);

    return this.client.send("/api/llm/logs/top-users", options);
  }

  /**
   * Deletes all LLM logs.
   *
   * @throws {ClientResponseError}
   */
  async truncate(options?: CommonOptions): Promise<boolean> {
    options = Object.assign({ method: "DELETE" }, options);

    return this.client.send("/api/llm/logs", options).then(() => true);
  }
}

/**
 * LLMService handles the LLM gateway APIs.
 */
export class LLMService extends BaseService {
  /**
   * The LLM requests log (staff).
   */
  readonly logs: LLMLogService;

  constructor(client: Client) {
    super(client);

    this.logs = new LLMLogService(client);
  }

  /**
   * Sends a chat request to the specified LLM profile
   * (governed by the profile rule and quotas).
   *
   * @throws {ClientResponseError}
   */
  async chat(
    profile: string,
    request: LLMChatRequest,
    options?: SendOptions,
  ): Promise<LLMChatResponse> {
    options = Object.assign({ method: "POST", requestKey: null }, options, {
      body: Object.assign({}, request, { stream: false }),
    });

    return this.client.send(this.chatPath(profile), options);
  }

  /**
   * Sends a streamed chat request to the specified LLM profile.
   *
   * `onDelta` is called for every received "delta" event and the
   * returned promise resolves with the final accumulated response
   * (the "done" event). A mid-stream "error" event rejects with a `ClientResponseError`.
   *
   * Note that it requires a fetch implementation with readable stream bodies
   * (browsers, Node.js >= 18, Deno, Bun, edge runtimes).
   *
   * @throws {ClientResponseError}
   */
  async chatStream(
    profile: string,
    request: LLMChatRequest,
    options?: LLMChatStreamOptions,
  ): Promise<LLMChatResponse> {
    const { onDelta, ...sendOptions } = Object.assign({}, options);

    const baseFetch = sendOptions.fetch;

    return this.client.send(
      this.chatPath(profile),
      Object.assign({ method: "POST", requestKey: null }, sendOptions, {
        body: Object.assign({}, request, { stream: true }),
        fetch: async (url: RequestInfo | URL, config?: RequestInit) => {
          const response = await (baseFetch || fetch)(url, config);

          const contentType = response.headers?.get?.("content-type") || "";
          if (!response.ok || !contentType.includes("text/event-stream")) {
            return response; // regular json (error) response
          }

          return consumeLLMStream(response, onDelta);
        },
      }),
    );
  }

  /**
   * Returns the available LLM drivers and the configured providers (staff).
   *
   * @throws {ClientResponseError}
   */
  async providers(options?: CommonOptions): Promise<LLMProvidersResponse> {
    options = Object.assign({ method: "GET" }, options);

    return this.client.send("/api/llm/providers", options);
  }

  /**
   * Tests an LLM provider configuration (staff).
   *
   * @throws {ClientResponseError}
   */
  async testProvider(
    data: LLMTestProviderData,
    options?: CommonOptions,
  ): Promise<{ [key: string]: any }> {
    options = Object.assign({ method: "POST", body: data }, options);

    return this.client.send("/api/llm/test", options);
  }

  private chatPath(profile: string): string {
    return "/api/llm/" + encodeURIComponent(profile) + "/chat";
  }
}

/**
 * Reads the LLM SSE stream ("delta", "done", "error" events) and returns a
 * synthetic JSON response with the "done" payload (or the "error" one with status 502).
 */
async function consumeLLMStream(
  response: Response,
  onDelta?: (event: LLMStreamEvent) => void,
): Promise<Response> {
  const json = (status: number, data: any) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json" },
    });

  if (!response.body) {
    return json(502, { status: 502, message: "Missing LLM stream body." });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let buffer = "";
  let done: any = null;
  let error: any = null;

  const handleEvent = (raw: string) => {
    let name = "message";
    const dataLines: Array<string> = [];

    for (const line of raw.split("\n")) {
      if (line.startsWith("event:")) {
        name = line.substring(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.substring(5).replace(/^ /, ""));
      }
    }

    if (!dataLines.length) {
      return;
    }

    let data: any = null;
    try {
      data = JSON.parse(dataLines.join("\n"));
    } catch (_) {
      return;
    }

    switch (name) {
      case "delta":
        onDelta?.(data);
        break;
      case "done":
        done = data;
        break;
      case "error":
        error = data;
        break;
    }
  };

  while (true) {
    const { value, done: finished } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");

      let idx;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        handleEvent(buffer.substring(0, idx));
        buffer = buffer.substring(idx + 2);
      }
    }

    if (finished) {
      break;
    }
  }

  if (buffer.trim()) {
    handleEvent(buffer);
  }

  if (error || !done) {
    return json(502, {
      status: 502,
      message: error?.message || "The LLM stream ended unexpectedly.",
      data: {},
    });
  }

  return json(200, done);
}
