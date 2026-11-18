// Issue #965: a route-table fetch for the broker refusal tests. Each request is answered by the first
// route whose method and URL pattern match; nothing reaches a network. Unrouted requests answer 599 so a
// test that forgot a route fails on its assertion instead of passing on an accidental default.

export interface FakeResponse {
  status: number;
  ok: boolean;
  text(): Promise<string>;
  json(): Promise<unknown>;
  arrayBuffer?(): Promise<ArrayBuffer>;
}

export type Answer = FakeResponse | (() => FakeResponse);
export type Route = [method: string, pattern: RegExp, answer: Answer];

export interface Call {
  url: string;
  method: string;
  body?: string;
}

interface CallOptions {
  method?: string;
  body?: unknown;
}

export function reply(status: number, body?: unknown): FakeResponse {
  const raw = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => raw,
    json: async () => JSON.parse(raw),
  };
}

export function bytes(status: number, content: Buffer): FakeResponse {
  return { ...reply(status, ""), arrayBuffer: async () => new Uint8Array(content).buffer };
}

/** Answers once per listed response, in order, then repeats the last one. */
export function sequence(...answers: FakeResponse[]): () => FakeResponse {
  let index = 0;
  return () => answers[Math.min(index++, answers.length - 1)];
}

export function throwing(message = "synthetic transport failure"): () => FakeResponse {
  return () => { throw new Error(message); };
}

export function routed(routes: Route[], defaults: Route[] = []): {
  calls: Call[];
  fetchImpl: (url: string, options?: CallOptions) => Promise<FakeResponse>;
} {
  const calls: Call[] = [];
  const table = [...routes, ...defaults];
  const fetchImpl = async (url: string, options?: CallOptions): Promise<FakeResponse> => {
    const method = options?.method ?? "GET";
    const body = options?.body === undefined ? undefined : Buffer.from(options.body as string | Buffer).toString("utf8");
    calls.push({ url: String(url), method, ...(body === undefined ? {} : { body }) });
    const hit = table.find(([m, pattern]) => m === method && pattern.test(String(url)));
    if (!hit) return reply(599, { errorMessages: [`unrouted ${method}`] });
    return typeof hit[2] === "function" ? hit[2]() : hit[2];
  };
  return { calls, fetchImpl };
}
