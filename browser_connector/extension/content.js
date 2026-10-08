// Only injected after the user clicks Connect on the intended tab.
(() => {
  if (window.__wallbreakerMuseConnector) return;
  window.__wallbreakerMuseConnector = true;
  let pair = null, busy = false;
  const composer = () => document.querySelector('textarea[aria-label="Message"]');
  const visible = e => Boolean(e && e.getClientRects().length);
  const needsApproval = () => Array.from(document.querySelectorAll('button')).some(e => visible(e) && e.textContent.trim() === 'Review');
  const messages = role => Array.from(document.querySelectorAll(`[aria-label="Chat messages"] [data-message-role="${role}"]`));
  const replyText = e => {
    const clone = e.cloneNode(true);
    clone.querySelectorAll('[data-copy-exclude],button,[aria-hidden="true"]').forEach(n => n.remove());
    clone.querySelectorAll('p,li,h1,h2,h3,h4,pre,blockquote,tr').forEach(n => n.appendChild(document.createTextNode('\n')));
    clone.querySelectorAll('br').forEach(n=>n.replaceWith(document.createTextNode('\n')));
    return clone.textContent.trim();
  };
  const send = async message => {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error || "Extension unavailable");
    return response.data;
  };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  function preflight() {
    if (needsApproval()) throw new Error("Muse has a task awaiting review. Review it yourself or use a fresh side chat.");
    const input = composer();
    if (!visible(input) || input.disabled) throw new Error("Muse message box is not ready.");
    if (input.value.trim()) throw new Error("Clear your draft before connecting or running Wallbreaker.");
    if (document.querySelector('button[aria-label*="Stop"]')) throw new Error("Wait for the current Muse reply to finish.");
  }
  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message.type === "preflight") {
      try { preflight(); reply({ok: true}); } catch (e) { reply({ok: false, error: e.message}); }
    }
    if (message.type === "arm") { pair = message.pair; reply({ok: true}); }
    if (message.type === "disarm") { pair = null; reply({ok: true}); }
  });
  async function execute(job, cancelled) {
    const connectedPair = pair;
    if (!connectedPair || location.href !== job.url) throw new Error("Muse thread changed; prompt was not sent.");
    preflight();
    const before = new Set(messages("assistant").map(e => e.dataset.messageId));
    const users = new Set(messages("user").map(e => e.dataset.messageId));
    const input = composer();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(input, job.prompt);
    input.dispatchEvent(new Event("input", {bubbles: true}));
    await sleep(150);
    if (pair !== connectedPair || location.href !== job.url) throw new Error("Disconnected before send.");
    const buttons = Array.from(document.querySelectorAll('button')).filter(e=> visible(e) && !e.disabled && /^(Send|Send message)$/i.test(e.getAttribute('aria-label') || e.textContent.trim()));
    if (buttons.length !== 1) { input.value = ""; input.dispatchEvent(new Event("input", {bubbles:true})); throw new Error("Muse Send control changed. Prompt was not sent."); }
    buttons[0].click();
    const deadline = Date.now() + job.timeout * 1000;
    let last = "", stableSince = Date.now(), acknowledged = false;
    while (Date.now() < deadline) {
      await sleep(500);
      if (cancelled() || pair !== connectedPair || location.href !== job.url) throw new Error("Disconnected or request expired after send. Check Muse before retrying.");
      if (needsApproval()) throw new Error("Muse requested human approval. Review it in Chrome; the connector will not approve it.");
      acknowledged ||= messages("user").some(e => !users.has(e.dataset.messageId));
      const fresh = messages("assistant").filter(e => !before.has(e.dataset.messageId));
      const text = fresh.map(replyText).filter(Boolean).join("\n\n");
      if (text !== last) { last = text; stableSince = Date.now(); }
      const complete = fresh.length > 0 && fresh.every(e=>e.querySelector('button[aria-label="Copy response"]'));
      const stopping = Array.from(document.querySelectorAll('button')).some(e=>visible(e) && /stop/i.test(e.getAttribute('aria-label') || ""));
      if (acknowledged && complete && !stopping && last && Date.now() - stableSince > 2500) return last;
    }
    throw new Error("Muse reply timed out. A sent prompt is never resent automatically.");
  }
  setInterval(async () => {
    if (!pair || busy) return;
    busy = true;
    try {
      const {job} = await send({type: "poll", url: location.href});
      if (job) {
        let text = "", error = "";
        let cancelled = false;
        // Continue heartbeats while Muse is generating, without claiming a second job.
        const pulse = setInterval(() => send({type:"heartbeat",url:location.href,id:job.id}).then(s=>{cancelled ||= !s.active;}).catch(()=>{cancelled=true;}), 2000);
        try { text = await execute(job, () => cancelled); } catch(e) { error = e.message; }
        finally { clearInterval(pulse); }
        await send({type:"result", id:job.id, text, error});
      }
    } catch (e) { pair = null; console.warn("Wallbreaker Muse connector:", e.message); }
    finally { busy = false; }
  }, 1000);
})();
