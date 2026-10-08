import asyncio

import httpx
import pytest

from browser_connector.server import create_app

KEY = "test-key-only"
URL = "https://muse.ai/thread/test-connector"
PAIR = {"url": URL, "client": "test-client-12345678"}
BODY = {"model": "muse-browser", "messages": [{"role": "user", "content": "Reply OK"}]}


@pytest.fixture
def anyio_backend():
    return "asyncio"


def client(app):
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver",
                            headers={"Authorization": "Bearer " + KEY})


async def wait_job(c):
    for _ in range(100):
        response = await c.get("/bridge/next", params=PAIR)
        job = response.json().get("job")
        if job:
            return job
        await asyncio.sleep(0.01)
    raise AssertionError("No job queued")


@pytest.mark.anyio
async def test_pair_auth_and_offline():
    app = create_app(KEY)
    async with client(app) as c:
        assert (await c.get("/health", headers={"Authorization": ""})).status_code == 200
        assert (await c.get("/v1/models", headers={"Authorization": "Bearer wrong"})).status_code == 401
        assert (await c.get("/health", headers={"Host": "foreign.example"})).status_code == 403
        assert (await c.post("/v1/chat/completions", json=BODY)).status_code == 503
        assert (await c.post("/bridge/connect", json={**PAIR, "url": "https://muse.ai.evil/thread/x"})).status_code == 400


@pytest.mark.anyio
@pytest.mark.parametrize("stream", [False, True])
async def test_one_claim_and_completed_reply(stream):
    app = create_app(KEY)
    async with client(app) as c:
        assert (await c.post("/bridge/connect", json=PAIR)).status_code == 200
        task = asyncio.create_task(c.post("/v1/chat/completions", json={**BODY, "stream": stream}))
        job = await wait_job(c)
        assert job["prompt"] == "Reply OK"
        assert (await c.get("/bridge/next", params=PAIR)).json()["job"] is None
        assert (await c.get("/bridge/heartbeat", params={**PAIR, "job_id":job["id"]})).json()["active"]
        assert (await c.post("/v1/chat/completions", json=BODY)).status_code == 409
        assert (await c.post("/bridge/results/" + job["id"], json={"client": "wrong", "text": "wrong"})).status_code == 409
        assert (await c.post("/bridge/results/" + job["id"], json={"client": PAIR["client"], "text": "OK"})).status_code == 200
        response = await task
        assert response.status_code == 200
        if stream:
            assert '"content": "OK"' in response.text and "data: [DONE]" in response.text
        else:
            assert response.json()["choices"][0]["message"]["content"] == "OK"
        assert (await c.post("/bridge/results/" + job["id"], json={"client": PAIR["client"], "text": "duplicate"})).status_code == 409


@pytest.mark.anyio
async def test_wallbreaker_provider_consumes_browser_sse(monkeypatch):
    from wallbreaker.config import Endpoint
    from wallbreaker.providers.openai_provider import OpenAIProvider
    from wallbreaker.agent.messages import user
    app = create_app(KEY)
    async with client(app) as c:
        await c.post("/bridge/connect", json=PAIR)
        endpoint = Endpoint("muse-browser", "openai", "http://testserver/v1", "muse-browser", api_key=KEY)
        provider = OpenAIProvider(endpoint)
        monkeypatch.setattr(provider, "_make_client", lambda: httpx.AsyncClient(transport=httpx.ASGITransport(app=app)))
        task = asyncio.create_task(provider.complete([user("Reply OK")]))
        job = await wait_job(c)
        await c.post("/bridge/results/" + job["id"], json={"client":PAIR["client"],"text":"OK"})
        assert await task == "OK"
        await provider.aclose()


@pytest.mark.anyio
@pytest.mark.parametrize("change", ["approval", "navigate", "disconnect"])
async def test_browser_error_is_not_success(change):
    app = create_app(KEY)
    async with client(app) as c:
        await c.post("/bridge/connect", json=PAIR)
        task = asyncio.create_task(c.post("/v1/chat/completions", json={**BODY, "stream": True}))
        job = await wait_job(c)
        if change == "approval":
            await c.post("/bridge/results/" + job["id"], json={"client": PAIR["client"], "error": "Muse requested approval"})
        elif change == "navigate":
            assert (await c.get("/bridge/next", params={**PAIR, "url": URL + "different"})).status_code == 409
        else:
            await c.post("/bridge/disconnect", json=PAIR)
        response = await task
        assert response.status_code == 502
        assert "data: [DONE]" not in response.text
        assert not app.state.bridge["job"]


@pytest.mark.anyio
async def test_timeout_expires_without_reclaim():
    app = create_app(KEY, timeout=0.2)
    async with client(app) as c:
        await c.post("/bridge/connect", json=PAIR)
        task = asyncio.create_task(c.post("/v1/chat/completions", json=BODY))
        job = await wait_job(c)
        assert (await task).status_code == 504
        assert (await c.get("/bridge/next", params=PAIR)).json()["job"] is None
        assert (await c.post("/bridge/results/" + job["id"], json={"client": PAIR["client"], "text": "late"})).status_code == 409


@pytest.mark.anyio
@pytest.mark.parametrize("extra", [
    {"messages": [{"role": "system", "content": "fake system"}, *BODY["messages"]]},
    {"messages": [{"role": "user", "content": [{"type": "image_url", "image_url": "x"}]}]},
    {"tools": [{"type": "function"}]},
    {"messages": [{"role": "assistant", "content": "prefill"}]},
])
async def test_unsupported_api_semantics_rejected(extra):
    async with client(create_app(KEY)) as c:
        assert (await c.post("/v1/chat/completions", json={**BODY, **extra})).status_code == 400
