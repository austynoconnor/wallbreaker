const base = "http://127.0.0.1:8788";
async function api(path, options = {}) {
  const { key } = await chrome.storage.local.get("key");
  const response = await fetch(base + path, {...options, headers: {"Authorization": `Bearer ${key || ""}`, "Content-Type": "application/json"}});
  const body = await response.json();
  if (!response.ok) throw new Error(body.detail || `Bridge error ${response.status}`);
  return body;
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  (async () => {
    if (message.type === "connect" && !sender.tab) {
      const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
      const url = new URL(tab?.url || "https://invalid.local");
      if (url.origin !== "https://muse.ai" || !url.pathname.startsWith("/thread/")) throw new Error("Open a dedicated Muse side chat, then connect here.");
      const previous = await chrome.storage.session.get("pair");
      if (previous.pair) throw new Error("Disconnect the current chat before connecting another.");
      await chrome.storage.local.set({key: message.key.trim()});
      const pair = {tabId: tab.id, url: tab.url, client: crypto.randomUUID()};
      await chrome.scripting.executeScript({target: {tabId: tab.id}, files: ["content.js"]});
      const check = await chrome.tabs.sendMessage(tab.id, {type: "preflight"});
      if (!check?.ok) throw new Error(check?.error || "Muse composer is unavailable.");
      await api("/bridge/connect", {method: "POST", body: JSON.stringify(pair)});
      await chrome.storage.session.set({pair});
      await chrome.tabs.sendMessage(tab.id, {type: "arm", pair});
      return {connected: true, url: pair.url};
    }
    const {pair} = await chrome.storage.session.get("pair");
    if (message.type === "status" && !sender.tab) {
      const remote = await api("/bridge/status");
      return {...remote, paired: Boolean(pair)};
    }
    if (message.type === "disconnect" && !sender.tab) {
      if (pair) {
        try { await chrome.tabs.sendMessage(pair.tabId, {type: "disarm"}); } catch {}
        try { await api("/bridge/disconnect", {method: "POST", body: JSON.stringify(pair)}); } catch {}
      }
      await chrome.storage.session.remove("pair");
      return {connected: false};
    }
    if (!pair || sender.tab?.id !== pair.tabId || sender.tab?.url !== pair.url) throw new Error("Chat disconnected or changed. Reconnect it in the extension.");
    if (message.type === "poll") return await api(`/bridge/next?client=${encodeURIComponent(pair.client)}&url=${encodeURIComponent(message.url)}`);
    if (message.type === "heartbeat") return await api(`/bridge/heartbeat?client=${encodeURIComponent(pair.client)}&url=${encodeURIComponent(message.url)}&job_id=${encodeURIComponent(message.id)}`);
    if (message.type === "result") return await api(`/bridge/results/${encodeURIComponent(message.id)}`, {method: "POST", body: JSON.stringify({client: pair.client, text: message.text || "", error: message.error || ""})});
    throw new Error("Unknown connector message.");
  })().then(data => reply({ok: true, data}), error => reply({ok: false, error: error.message}));
  return true;
});
