import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
const credentials = (token: string) => Response.json({ tokenHeader: "x-wb-token", token });

it("shares session bootstrap and preserves streaming and JSON headers", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(credentials("first-token"))
    .mockResolvedValue(new Response("ok"));
  vi.stubGlobal("fetch", fetchMock);
  const { dashboardFetch } = await import("../dashboardFetch");
  await Promise.all([
    dashboardFetch("/api/providers", { headers: { "Content-Type": "application/json" } }),
    dashboardFetch("/api/v2/executions/id/events", { headers: { Accept: "text/event-stream" } }),
  ]);
  expect(fetchMock.mock.calls.filter(([url]) => url === "/api/session")).toHaveLength(1);
  for (const [, init] of fetchMock.mock.calls.slice(1)) {
    expect(init.headers.get("x-wb-token")).toBe("first-token");
  }
  expect(fetchMock.mock.calls[1][1].headers.get("Content-Type")).toBe("application/json");
  expect(fetchMock.mock.calls[2][1].headers.get("Accept")).toBe("text/event-stream");
});

it("refreshes a rotated token and retries a rejected request once", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(credentials("old-token"))
    .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
    .mockResolvedValueOnce(credentials("new-token"))
    .mockResolvedValueOnce(new Response("ok"));
  vi.stubGlobal("fetch", fetchMock);
  const { dashboardFetch } = await import("../dashboardFetch");
  expect((await dashboardFetch("/api/providers")).status).toBe(200);
  expect(fetchMock.mock.calls[3][1].headers.get("x-wb-token")).toBe("new-token");
  expect(fetchMock).toHaveBeenCalledTimes(4);
});

it("does not send the session token to another destination", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const { dashboardFetch } = await import("../dashboardFetch");
  await expect(dashboardFetch("https://example.com/api/providers")).rejects.toThrow("local API");
  expect(fetchMock).not.toHaveBeenCalled();
});
