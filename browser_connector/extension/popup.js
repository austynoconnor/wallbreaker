const $ = id => document.getElementById(id);
async function action(message) {
  $("error").hidden = true;
  $("connect").disabled = true;
  try {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error || "Connector unavailable");
    const state = response.data;
    const connected = state.connected;
    $("status").textContent = connected ? "Connected to Muse" : "Disconnected";
    $("dot").classList.toggle("on", connected);
    $("detail").textContent = connected ? `Ready for Wallbreaker · ${state.url}` : "Open a dedicated Muse side chat and connect it here.";
    $("connect").hidden = connected || state.paired;
    $("disconnect").hidden = !(connected || state.paired);
    $("key").hidden = connected;
    document.querySelector("label").hidden = connected;
  } catch (e) { $("error").textContent = e.message; $("error").hidden = false; }
  finally { $("connect").disabled = false; }
}
$("connect").onclick = () => action({type: "connect", key: $("key").value});
$("disconnect").onclick = () => action({type: "disconnect"});
chrome.storage.local.get("key").then(({key}) => {$("key").value = key || ""; if (key) action({type:"status"});});
