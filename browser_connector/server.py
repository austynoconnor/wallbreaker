"""OpenAI text transport backed by an explicitly connected Chrome tab.

Run with .venv/Scripts/python -m browser_connector.server. Credentials stay local;
this service neither reads Chrome cookies nor calls Muse's private APIs.
"""
from __future__ import annotations

import asyncio
import hmac
import json
import secrets
import time
from pathlib import Path
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

STATE = Path(__file__).resolve().parent / ".local"


def load_key() -> str:
    STATE.mkdir(exist_ok=True)
    path = STATE / "bridge.key"
    if not path.exists():
        # Exclusive creation avoids two launchers generating different keys.
        try:
            with path.open("x", encoding="utf-8") as out:
                out.write(secrets.token_urlsafe(32))
        except FileExistsError:
            pass
    return path.read_text(encoding="utf-8").strip()


class Connection(BaseModel):
    url: str
    client: str = Field(min_length=16, max_length=100)


class Result(BaseModel):
    client: str
    text: str = Field(default="", max_length=1_000_000)
    error: str = Field(default="", max_length=2000)


def prompt_from(body: dict) -> str:
    if body.get("model") != "muse-browser":
        raise HTTPException(400, "Select the muse-browser model.")
    if body.get("tools") or body.get("functions"):
        raise HTTPException(400, "Browser transport supports text targets, not API tool calls.")
    messages = body.get("messages")
    if not isinstance(messages, list) or not messages or any(not isinstance(m, dict) for m in messages):
        raise HTTPException(400, "messages must be a nonempty array.")
    if any(m.get("role") not in {"user", "assistant"} for m in messages):
        raise HTTPException(400, "Muse owns its system instructions. Remove system/developer/tool messages.")
    if messages[-1].get("role") != "user":
        raise HTTPException(400, "The last message must be a user prompt.")
    content = messages[-1].get("content")
    if isinstance(content, list):
        if any(not isinstance(p, dict) or p.get("type") != "text" or not isinstance(p.get("text"), str) for p in content):
            raise HTTPException(400, "Only text prompts are supported.")
        content = "\n".join(p.get("text", "") for p in content)
    if not isinstance(content, str) or not content.strip() or len(content) > 100_000:
        raise HTTPException(400, "Provide a text prompt between 1 and 100000 characters.")
    return content


def create_app(key: str, timeout: float = 180, stale_after: float = 15) -> FastAPI:
    app = FastAPI(title="Wallbreaker Muse browser bridge")
    state = {"connection": None, "heartbeat": 0.0, "job": None}
    app.state.bridge = state

    @app.middleware("http")
    async def authenticate(request: Request, call_next):
        # Reject DNS rebinding and never expose credentials through a webpage.
        host = request.headers.get("host", "").split(":")[0]
        if host not in {"127.0.0.1", "localhost", "testserver"}:
                return JSONResponse({"detail": "Localhost only"}, 403)
        if request.url.path != "/health":
            supplied = request.headers.get("authorization", "").removeprefix("Bearer ")
            if not supplied or not hmac.compare_digest(supplied, key):
                return JSONResponse({"detail": "Bridge key required"}, 401)
        return await call_next(request)

    def connected():
        return bool(state["connection"] and time.monotonic() - state["heartbeat"] < stale_after)

    def abort(reason: str):
        job = state["job"]
        if job and not job["future"].done():
            job["future"].set_result({"error": reason})

    def check_client(client: str):
        if not state["connection"] or state["connection"]["client"] != client:
            raise HTTPException(409, "This tab is not the connected tab.")

    @app.get("/health")
    async def health():
        return {"name": "wallbreaker-muse-bridge", "ready": connected()}

    @app.get("/bridge/status")
    async def status():
        return {"connected": connected(), "url": (state["connection"] or {}).get("url"),
                "busy": state["job"] is not None}

    @app.post("/bridge/connect")
    async def connect(connection: Connection):
        parsed = urlparse(connection.url)
        if parsed.scheme != "https" or parsed.netloc != "muse.ai" or not parsed.path.startswith("/thread/") or parsed.path.rstrip("/") == "/thread/new":
            raise HTTPException(400, "Open a dedicated Muse side chat before connecting.")
        if state["job"]:
            raise HTTPException(409, "Finish or disconnect the current request first.")
        state["connection"] = connection.model_dump()
        state["heartbeat"] = time.monotonic()
        return {"connected": True}

    @app.post("/bridge/disconnect")
    async def disconnect(connection: Connection):
        check_client(connection.client)
        abort("Browser disconnected. A sent prompt is never retried automatically.")
        state["connection"] = None
        return {"connected": False}

    def heartbeat(client: str, url: str):
        check_client(client)
        if url != state["connection"]["url"]:
            abort("Connected Muse thread changed. Reconnect the intended chat.")
            state["connection"] = None
            raise HTTPException(409, "Thread changed; disconnected.")
        state["heartbeat"] = time.monotonic()

    @app.get("/bridge/heartbeat")
    async def browser_heartbeat(client: str, url: str, job_id: str):
        heartbeat(client, url)
        return {"active": bool(state["job"] and state["job"]["id"] == job_id)}

    @app.get("/bridge/next")
    async def next_job(client: str, url: str):
        heartbeat(client, url)
        job = state["job"]
        if not job or job["claimed"]:
            return {"job": None}
        job["claimed"] = True
        return {"job": {"id": job["id"], "prompt": job["prompt"], "url": url, "timeout": timeout}}

    @app.post("/bridge/results/{job_id}")
    async def result(job_id: str, result: Result):
        check_client(result.client)
        job = state["job"]
        if not job or job["id"] != job_id or not job["claimed"] or job["future"].done():
            raise HTTPException(409, "Request expired or already completed. Do not resend.")
        if not result.text and not result.error:
            raise HTTPException(400, "An empty response is not a completed reply.")
        job["future"].set_result(result.model_dump())
        return {"accepted": True}

    @app.get("/v1/models")
    async def models():
        return {"object": "list", "data": [{"id": "muse-browser", "object": "model", "owned_by": "connected-browser"}]}

    @app.post("/v1/chat/completions")
    async def completion(request: Request):
        try:
            body = await request.json()
        except (ValueError, TypeError):
            raise HTTPException(400, "Invalid JSON")
        if not isinstance(body, dict):
            raise HTTPException(400, "Expected a JSON object")
        prompt = prompt_from(body)
        if not connected():
            raise HTTPException(503, "Connect the Chrome extension to a Muse side chat first.")
        if state["job"]:
            raise HTTPException(409, "Muse handles one prompt at a time. Wait for the current reply.")
        future = asyncio.get_running_loop().create_future()
        job = {"id": "chatcmpl-" + secrets.token_hex(12), "prompt": prompt, "claimed": False, "future": future}
        state["job"] = job

        async def wait_result():
            try:
                deadline = time.monotonic() + timeout
                while not future.done():
                    if await request.is_disconnected():
                        raise HTTPException(499, "Caller disconnected; no automatic retry.")
                    if not connected():
                        raise HTTPException(503, "Browser went offline; verify the chat before retrying.")
                    if time.monotonic() >= deadline:
                        raise HTTPException(504, "Muse reply timed out. Check the chat before retrying.")
                    await asyncio.sleep(0.1)
                answer = future.result()
                if answer.get("error"):
                    raise HTTPException(502, answer["error"])
                return answer["text"]
            finally:
                if state["job"] is job:
                    state["job"] = None
                if not future.done():
                    future.cancel()

        # Complete before emitting SSE headers so failures remain real HTTP errors.
        text = await wait_result()
        base = {"id": job["id"], "created": int(time.time()), "model": "muse-browser"}
        if body.get("stream"):
            async def events():
                for delta, finish in [({"role": "assistant", "content": text}, None), ({}, "stop")]:
                    chunk = {**base, "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
                    yield "data: " + json.dumps(chunk) + "\n\n"
                yield "data: [DONE]\n\n"
            return StreamingResponse(events(), media_type="text/event-stream")
        return {**base, "object": "chat.completion", "choices": [{"index": 0,
                "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}]}

    return app


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(create_app(load_key()), host="127.0.0.1", port=8788, access_log=False)
