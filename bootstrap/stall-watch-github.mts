// Thin GitHub REST layer for bootstrap/stall-watch.mts (issue #744) and
// bootstrap/ci-rerun.mts (issue #973).
//
// `get` reads one object.
// `list` follows the `Link: rel="next"` header with per_page=100 and fails
// when a list has more pages than the caller allows: a capped read is an
// error, never a short list. A next link that leaves the API origin is refused,
// so the token is never sent anywhere else. Any non-2xx answer throws.

import { field } from "./shape.mts";

export interface GithubClient {
  get(path: string): Promise<unknown>;
  list(path: string, key: string | null, maxPages: number): Promise<unknown[]>;
  post(path: string, body: unknown): Promise<void>;
}

export interface ClientOptions { api: string; token: string; fetch: typeof fetch }

export function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const [target, ...params] = part.split(";").map((piece) => piece.trim());
    if (params.includes('rel="next"') && target.startsWith("<") && target.endsWith(">")) return target.slice(1, -1);
  }
  return null;
}

export function githubClient(options: ClientOptions): GithubClient {
  let end = options.api.length;
  while (end > 0 && options.api[end - 1] === "/") end--;
  const api = options.api.slice(0, end);
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${options.token}`,
    "x-github-api-version": "2022-11-28",
    "user-agent": "kherep-stall-watch",
  };

  async function call(url: string, init: RequestInit = {}): Promise<Response> {
    if (!url.startsWith(`${api}/`)) throw new Error(`refused a request outside ${api}`);
    const response = await options.fetch(url, { ...init, headers: { ...headers, ...(init.body ? { "content-type": "application/json" } : {}) } });
    if (!response.ok) throw new Error(`${init.method ?? "GET"} ${new URL(url).pathname} answered HTTP ${response.status}`);
    return response;
  }

  return {
    async get(path) {
      return (await call(`${api}${path}`)).json();
    },
    async list(path, key, maxPages) {
      const items: unknown[] = [];
      const label = path.split("?")[0];
      let url: string | null = `${api}${path}${path.includes("?") ? "&" : "?"}per_page=100`;
      for (let page = 0; url; page++) {
        if (page === maxPages) throw new Error(`${label} has more than ${maxPages} page(s) of 100`);
        const response: Response = await call(url);
        const body: unknown = await response.json();
        const list = key ? field(body, key) : body;
        if (!Array.isArray(list)) throw new Error(`${label} did not answer a list`);
        items.push(...list);
        url = nextLink(response.headers.get("link"));
      }
      return items;
    },
    async post(path, body) {
      await call(`${api}${path}`, { method: "POST", body: JSON.stringify(body) });
    },
  };
}
