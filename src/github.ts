export interface Response<T = any> {
  status: number;
  data: T;
}

/** GitHub is the slice of GitHub's API the publisher calls; rest returns every status rather than throwing. */
export interface GitHub {
  rest<T = any>(method: string, path: string, body?: unknown): Promise<Response<T>>;
  graphql<T = any>(query: string, variables: Record<string, unknown>): Promise<T>;
}

const RETRIES = 3;

/** client calls api.github.com as token, retrying reads that fail with 5xx or on the network. */
export function client(token: string, api = "https://api.github.com"): GitHub {
  const call = async (method: string, path: string, body?: unknown): Promise<Response> => {
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(api + path, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
        const text = await res.text();
        const data = text ? JSON.parse(text) : undefined;
        if (res.status < 500 || method !== "GET" || attempt >= RETRIES) return { status: res.status, data };
      } catch (e) {
        if (method !== "GET" || attempt >= RETRIES) return { status: 0, data: { message: String(e) } };
      }
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  };
  return {
    rest: call,
    async graphql(query, variables) {
      const res = await call("POST", "/graphql", { query, variables });
      if (res.status !== 200 || res.data?.errors) throw new Error(`graphql: ${res.status} ${JSON.stringify(res.data?.errors ?? res.data)}`);
      return res.data.data;
    },
  };
}

/** all reads every page of a list endpoint, up to max pages of 100. */
export async function all<T>(gh: GitHub, path: string, max = 30): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= max; page++) {
    const res = await gh.rest<T[]>("GET", `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    if (res.status !== 200) throw new Error(`GET ${path}: ${res.status}`);
    out.push(...res.data);
    if (res.data.length < 100) break;
  }
  return out;
}
