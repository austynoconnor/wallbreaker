# Muse browser connector

This local OpenAI-compatible text target routes a Wallbreaker request through one
explicitly connected Muse side chat. It uses a Chrome extension with `activeTab`:
clicking Connect grants access to the current tab. It has no persistent Muse host
permission and does not extract login cookies or use undocumented Muse endpoints.

## Windows setup

1. Run `browser_connector/start.ps1 -Setup`. The local bridge starts on 127.0.0.1:8788
   and copies its pairing key to the clipboard.
2. Open `chrome://extensions`, enable Developer mode, click **Load unpacked**, and
   select this repository's `browser_connector/extension` folder.
3. Open a dedicated Muse side chat and send a harmless first message to create it.
   Click the extension, paste the pairing key,
   and click **Connect this Muse chat**. Leave that tab open.
4. In Wallbreaker select the `muse-browser` target profile, while retaining an API
   attacker and judge. Start your run explicitly in Wallbreaker.
5. Click **Disconnect chat** when finished. Reloading or navigating the Muse tab
   requires reconnection. Existing in-progress requests fail instead of resending.

Profile (the local launcher loads MUSE_BROWSER_BRIDGE_KEY):

```toml
[profiles.muse-browser]
protocol = "openai"
base_url = "http://127.0.0.1:8788/v1"
api_key_env = "MUSE_BROWSER_BRIDGE_KEY"
model = "muse-browser"
timeout = 210
```

## Behavior and limitations

Only the latest user prompt is sent; the connected chat retains its own history.
Earlier API transcript entries are not replayed. Use a fresh Muse side chat and
reconnect before an independent experiment. This is not stateless API sampling.
System/developer messages, API tool calls, images and assistant-prefill requests
are rejected. Muse's existing system rules remain in effect. Model, temperature,
max-token and seed API controls cannot change the browser service's settings.
No hidden reasoning or token usage is fabricated. SSE returns the completed
visible text as a chunk, not live per-token output.

One request is allowed at a time. Claimed prompts never retry automatically.
Timeouts, lost connections, changed tabs and task approvals surface as errors;
verify the chat before retrying. The extension does not click Review or approve
Muse tasks. Use a fresh chat if there is already a pending approval.

Local bridge credentials live in ignored `.local/bridge.key`. Keep that file and
`config.toml` out of Git. Authentication applies to every endpoint except health;
the bridge binds only to localhost. Only newly generated visible assistant text
is returned to Wallbreaker, where the existing attacker and judge process it.
