type Session = { tokenHeader: string; token: string };
let sessionPromise: Promise<Session> | undefined;

function session(): Promise<Session> {
  if (!sessionPromise) {
    sessionPromise = fetch("/api/session", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error("Could not initialize the dashboard session");
      return response.json() as Promise<Session>;
    }).catch((error) => {
      sessionPromise = undefined;
      throw error;
    });
  }
  return sessionPromise;
}

/** Authenticate both ordinary API calls and streamed dashboard responses. */
export async function dashboardFetch(url: string, init?: RequestInit): Promise<Response> {
  if (!url.startsWith("/api/")) throw new Error("Dashboard requests must use the local API");
  const send = async () => {
    const credentials = await session();
    const headers = new Headers(init?.headers);
    if (credentials.token) headers.set(credentials.tokenHeader, credentials.token);
    return fetch(url, { ...init, headers });
  };
  let response = await send();
  // A restarted backend rotates its token. A rejected request has not reached
  // its handler, so it is safe to bootstrap again and retry it once.
  if (response.status === 401) {
    sessionPromise = undefined;
    response = await send();
  }
  return response;
}
