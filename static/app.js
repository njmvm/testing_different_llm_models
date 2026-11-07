/* Model Compare Chat — front-end logic (no build step, plain JS). */
"use strict";

const $ = (sel) => document.querySelector(sel);
const STORAGE_KEY = "modelCompare.v1";
const PRESETS_KEY = "modelCompare.presets.v1";
const MAX_MODELS = 8;

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */
const state = {
  catalog: [],             // models from OpenRouter
  catalogById: new Map(),
  selected: [],            // model ids, in selection order
  systemPrompt: "",
  temperature: 0.7,
  maxTokens: "",
  reasoning: "",
  blind: false,
  revealed: false,
  blindOrder: [],          // shuffled model ids for blind mode
  threads: {},             // modelId -> [{role, content, turn, reasoning, stats, error, rating}]
  turn: 0,                 // number of questions asked
};
const running = new Map(); // modelId -> AbortController

function persist() {
  const { catalog, catalogById, ...rest } = state;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(rest)); } catch { /* quota / private mode */ }
}

function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (saved) Object.assign(state, saved);
  } catch { /* ignore */ }
  // Answers that were streaming when the page closed are incomplete.
  for (const thread of Object.values(state.threads)) {
    for (const m of thread) {
      if (m.pending) { m.pending = false; m.error = m.error || "Interrupted (page was reloaded)"; }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderMarkdown(text) {
  if (window.marked && window.DOMPurify) {
    try { return DOMPurify.sanitize(marked.parse(text || "")); } catch { /* fall through */ }
  }
  return `<div class="plain">${escapeHtml(text || "")}</div>`;
}

function toast(msg, ms = 2600) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, ms);
}

function fmtPrice(perToken) {
  if (perToken == null) return "?";
  if (perToken === 0) return "free";
  const perM = perToken * 1e6;
  return `$${perM < 1 ? perM.toFixed(2) : perM.toFixed(perM < 10 ? 2 : 0)}`;
}

function fmtCtx(n) {
  if (!n) return "";
  return n >= 1e6 ? `${(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M ctx` : `${Math.round(n / 1000)}K ctx`;
}

function fmtCost(c) {
  if (c == null) return "";
  if (c === 0) return "$0";
  return c < 0.01 ? `$${c.toFixed(5)}` : `$${c.toFixed(3)}`;
}

function modelName(id) {
  const m = state.catalogById.get(id);
  return m ? m.name : id;
}

function labelFor(id) {
  if (state.blind && !state.revealed) {
    const idx = state.blindOrder.indexOf(id);
    return `Model ${String.fromCharCode(65 + (idx < 0 ? 0 : idx))}`;
  }
  return modelName(id);
}

function displayOrder() {
  if (state.blind) {
    // Keep blindOrder in sync with the selection.
    state.blindOrder = state.blindOrder.filter((id) => state.selected.includes(id));
    for (const id of state.selected) if (!state.blindOrder.includes(id)) state.blindOrder.push(id);
    return state.blindOrder;
  }
  return state.selected;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ------------------------------------------------------------------ */
/* Model catalog & picker                                              */
/* ------------------------------------------------------------------ */
async function loadConfig() {
  try {
    const cfg = await (await fetch("/api/config")).json();
    $("#keyWarning").hidden = cfg.has_key;
    if (!state.selected.length && Array.isArray(cfg.default_models)) {
      state.selected = cfg.default_models.slice(0, MAX_MODELS);
    }
  } catch {
    toast("Cannot reach the local server — is server.py running?");
  }
}

async function loadCatalog() {
  $("#modelResults").innerHTML = `<div class="muted pad">Loading models…</div>`;
  try {
    const res = await fetch("/api/models");
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || res.statusText);
    state.catalog = json.data || [];
    state.catalogById = new Map(state.catalog.map((m) => [m.id, m]));
  } catch (err) {
    $("#modelResults").innerHTML =
      `<div class="muted pad">Could not load the model list (${escapeHtml(err.message)}).<br/>
       You can still type an exact model id (e.g. <code>openai/gpt-6.1-sol</code>) and press Enter.</div>`;
    return;
  }
  renderPicker();
  renderColumns();
}

function renderPicker() {
  // Selected chips
  const chips = $("#selectedModels");
  chips.innerHTML = "";
  for (const id of state.selected) {
    const m = state.catalogById.get(id);
    const chip = document.createElement("span");
    chip.className = "chip" + (state.catalog.length && !m ? " unknown" : "");
    chip.title = m ? `${m.id}\n${fmtPrice(m.prompt_price)} in / ${fmtPrice(m.completion_price)} out per 1M tokens` :
      (state.catalog.length ? `${id} — not found in the OpenRouter catalog` : id);
    chip.innerHTML = `<span>${escapeHtml(m ? m.name : id)}</span><button aria-label="Remove">×</button>`;
    chip.querySelector("button").onclick = () => toggleModel(id);
    chips.appendChild(chip);
  }
  $("#modelCount").textContent = `${state.selected.length}/${MAX_MODELS}`;

  // Search results
  const q = $("#modelSearch").value.trim().toLowerCase();
  const freeOnly = $("#freeOnly").checked;
  const box = $("#modelResults");
  if (!state.catalog.length) return;
  let list = state.catalog;
  if (freeOnly) list = list.filter((m) => m.prompt_price === 0 && m.completion_price === 0);
  if (q) {
    const terms = q.split(/\s+/);
    list = list.filter((m) => terms.every((t) => m.id.toLowerCase().includes(t) || m.name.toLowerCase().includes(t)));
  }
  const shown = list.slice(0, 40);
  box.innerHTML = shown.length ? "" : `<div class="muted pad">No match. Press Enter to add “${escapeHtml(q)}” as a raw model id.</div>`;
  for (const m of shown) {
    const row = document.createElement("button");
    row.className = "model-row" + (state.selected.includes(m.id) ? " selected" : "");
    row.title = m.description || m.id;
    row.innerHTML = `
      <span class="tick">${state.selected.includes(m.id) ? "✓" : "+"}</span>
      <span class="mname">${escapeHtml(m.name)}<small>${escapeHtml(m.id)}</small></span>
      <span class="mmeta">${fmtPrice(m.prompt_price)} / ${fmtPrice(m.completion_price)}<small>${fmtCtx(m.context_length)}</small></span>`;
    row.onclick = () => toggleModel(m.id);
    box.appendChild(row);
  }
  if (list.length > shown.length) {
    box.insertAdjacentHTML("beforeend", `<div class="muted pad">${list.length - shown.length} more — refine your search.</div>`);
  }
}

function toggleModel(id) {
  const i = state.selected.indexOf(id);
  if (i >= 0) {
    if (running.has(id)) running.get(id).abort();
    state.selected.splice(i, 1);
  } else {
    if (state.selected.length >= MAX_MODELS) { toast(`Up to ${MAX_MODELS} models at a time.`); return; }
    state.selected.push(id);
    if (state.turn > 0 && !(state.threads[id] || []).length) {
      toast("Added mid-conversation: this model will only see questions asked from now on.", 4000);
    }
  }
  persist();
  renderPicker();
  renderColumns();
}

/* ------------------------------------------------------------------ */
/* Columns rendering                                                   */
/* ------------------------------------------------------------------ */
function renderColumns() {
  const wrap = $("#columns");
  const order = displayOrder();
  $("#revealBtn").hidden = !(state.blind && !state.revealed && state.turn > 0);
  if (!order.length) {
    wrap.innerHTML = `<div class="empty"><h2>Pick some models in the sidebar</h2>
      <p>Search the OpenRouter catalog and add up to ${MAX_MODELS} models to compare.</p></div>`;
    updateTotals();
    return;
  }
  wrap.innerHTML = "";
  wrap.style.setProperty("--cols", String(order.length));
  for (const id of order) wrap.appendChild(buildColumn(id));
  updateTotals();
}

function buildColumn(id) {
  const m = state.catalogById.get(id);
  const hidden = state.blind && !state.revealed;
  const col = document.createElement("article");
  col.className = "column";
  col.dataset.model = id;
  col.innerHTML = `
    <header class="col-head">
      <div class="col-title">
        <strong>${escapeHtml(labelFor(id))}</strong>
        ${hidden ? "" : `<small>${escapeHtml(id)}${m ? ` · ${fmtPrice(m.prompt_price)} / ${fmtPrice(m.completion_price)} per 1M` : ""}</small>`}
      </div>
      <div class="col-stats muted"></div>
    </header>
    <div class="messages"></div>`;
  const box = col.querySelector(".messages");
  const thread = state.threads[id] || [];
  thread.forEach((msg, idx) => box.appendChild(buildMessage(id, msg, idx === thread.length - 1)));
  if (!thread.length) box.innerHTML = `<div class="muted pad center">Waiting for your first question…</div>`;
  updateColumnStats(col, id);
  requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
  return col;
}

function buildMessage(modelId, msg, isLast) {
  const el = document.createElement("div");
  el.className = `msg ${msg.role}`;
  if (msg.role === "user") {
    el.innerHTML = `<div class="bubble">${escapeHtml(msg.content)}</div>`;
    return el;
  }
  el.innerHTML = `
    <details class="reasoning" ${msg.reasoning ? "" : "hidden"}><summary>Reasoning</summary><div class="reasoning-body"></div></details>
    <div class="content md"></div>
    <div class="error" hidden></div>
    <div class="msg-foot">
      <span class="stats muted"></span>
      <span class="actions">
        <span class="rating" title="Rate this answer (1–5)">${[1, 2, 3, 4, 5].map((n) => `<button data-score="${n}">${n}</button>`).join("")}</span>
        <button class="ghost small copy" title="Copy answer">Copy</button>
        ${isLast ? `<button class="ghost small retry" title="Regenerate this answer">Retry</button>` : ""}
      </span>
    </div>`;
  paintMessage(el, msg);
  el.querySelectorAll(".rating button").forEach((b) => {
    b.onclick = () => {
      const score = Number(b.dataset.score);
      msg.rating = msg.rating === score ? null : score;
      persist();
      paintMessage(el, msg);
      updateColumnStats(el.closest(".column"), modelId);
    };
  });
  el.querySelector(".copy").onclick = async () => {
    try { await navigator.clipboard.writeText(msg.content || ""); toast("Copied"); } catch { toast("Copy failed"); }
  };
  const retry = el.querySelector(".retry");
  if (retry) retry.onclick = () => retryLast(modelId);
  return el;
}

function paintMessage(el, msg) {
  const content = el.querySelector(".content");
  if (msg.pending && !msg.content) {
    content.innerHTML = `<span class="typing"><i></i><i></i><i></i></span>`;
  } else {
    content.innerHTML = renderMarkdown(msg.content);
    if (msg.pending) content.insertAdjacentHTML("beforeend", `<span class="cursor">▍</span>`);
  }
  const r = el.querySelector(".reasoning");
  if (msg.reasoning) {
    r.hidden = false;
    r.querySelector(".reasoning-body").textContent = msg.reasoning;
  }
  const err = el.querySelector(".error");
  err.hidden = !msg.error;
  err.textContent = msg.error || "";
  el.querySelector(".stats").textContent = statsText(msg);
  const noAnswer = !!msg.pending || !msg.content;
  el.querySelector(".rating").hidden = noAnswer;
  el.querySelector(".copy").hidden = noAnswer;
  el.querySelectorAll(".rating button").forEach((b) => b.classList.toggle("on", Number(b.dataset.score) <= (msg.rating || 0)));
  const retry = el.querySelector(".retry");
  if (retry) retry.hidden = !!msg.pending;
}

function statsText(msg) {
  const s = msg.stats;
  if (!s) return msg.pending ? "thinking…" : "";
  const parts = [];
  if (s.ttft != null) parts.push(`first token ${(s.ttft / 1000).toFixed(1)}s`);
  if (s.total != null) parts.push(`total ${(s.total / 1000).toFixed(1)}s`);
  if (s.completion_tokens != null) parts.push(`${s.completion_tokens} tok`);
  if (s.completion_tokens && s.total && s.ttft != null && s.total > s.ttft) {
    parts.push(`${Math.round(s.completion_tokens / ((s.total - s.ttft) / 1000))} tok/s`);
  }
  if (s.cost != null) parts.push(fmtCost(s.cost));
  if (s.provider) parts.push(`via ${s.provider}`);
  return parts.join(" · ");
}

function updateColumnStats(col, id) {
  if (!col) return;
  const answers = (state.threads[id] || []).filter((m) => m.role === "assistant" && !m.pending && m.content);
  const cost = answers.reduce((sum, m) => sum + (m.stats?.cost || 0), 0);
  const rated = answers.filter((m) => m.rating);
  const avg = rated.length ? (rated.reduce((s, m) => s + m.rating, 0) / rated.length).toFixed(1) : null;
  const parts = [];
  if (answers.length) parts.push(`${answers.length} answer${answers.length > 1 ? "s" : ""}`);
  if (cost) parts.push(fmtCost(cost));
  if (avg) parts.push(`★ ${avg}`);
  col.querySelector(".col-stats").textContent = parts.join(" · ");
}

function updateTotals() {
  let cost = 0;
  for (const thread of Object.values(state.threads)) {
    for (const m of thread) cost += m.stats?.cost || 0;
  }
  $("#totalCost").textContent = cost ? `Session cost: ${fmtCost(cost)}` : "";
}

/* ------------------------------------------------------------------ */
/* Sending & streaming                                                 */
/* ------------------------------------------------------------------ */
function buildRequestMessages(thread) {
  const msgs = [];
  if (state.systemPrompt.trim()) msgs.push({ role: "system", content: state.systemPrompt.trim() });
  for (const m of thread) {
    if (m.pending) continue;
    if (m.role === "assistant" && (m.error && !m.content)) continue; // skip failed answers
    if (!m.content) continue;
    msgs.push({ role: m.role, content: m.content });
  }
  return msgs;
}

function send() {
  const text = $("#userInput").value.trim();
  if (!text) return;
  if (!state.selected.length) { toast("Select at least one model first."); return; }
  if (running.size) { toast("Wait for the current answers (or press Stop)."); return; }

  if (state.turn === 0 && state.blind) {
    state.blindOrder = shuffle(state.selected);
    state.revealed = false;
  }
  state.turn += 1;
  for (const id of state.selected) {
    const thread = (state.threads[id] ||= []);
    thread.push({ role: "user", content: text, turn: state.turn });
  }
  $("#userInput").value = "";
  persist();
  renderColumns();
  for (const id of state.selected) startAnswer(id);
}

function retryLast(id) {
  if (running.has(id)) return;
  const thread = state.threads[id] || [];
  const last = thread[thread.length - 1];
  if (!last || last.role !== "assistant") return;
  thread.pop();
  persist();
  startAnswer(id);
}

function startAnswer(id) {
  const thread = state.threads[id];
  const lastUser = [...thread].reverse().find((m) => m.role === "user");
  const msg = { role: "assistant", content: "", reasoning: "", turn: lastUser?.turn, pending: true, stats: null, rating: null };
  const history = buildRequestMessages(thread);
  thread.push(msg);
  rerenderColumn(id);
  streamAnswer(id, msg, history);
}

function rerenderColumn(id) {
  const old = document.querySelector(`.column[data-model="${CSS.escape(id)}"]`);
  if (old) old.replaceWith(buildColumn(id));
  updateTotals();
}

function liveMessageEl(id) {
  const col = document.querySelector(`.column[data-model="${CSS.escape(id)}"]`);
  return col ? col.querySelector(".messages .msg.assistant:last-child") : null;
}

async function streamAnswer(id, msg, history) {
  const ctrl = new AbortController();
  running.set(id, ctrl);
  updateRunningUi();

  const body = { model: id, messages: history, temperature: Number(state.temperature) };
  if (state.maxTokens) body.max_tokens = Number(state.maxTokens);
  if (state.reasoning) body.reasoning = { effort: state.reasoning };

  const t0 = performance.now();
  const stats = { ttft: null, total: null };
  msg.stats = stats;
  let paintQueued = false;
  const schedulePaint = () => {
    if (paintQueued) return;
    paintQueued = true;
    requestAnimationFrame(() => {
      paintQueued = false;
      const el = liveMessageEl(id);
      if (!el) return;
      const box = el.closest(".messages");
      const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
      paintMessage(el, msg);
      if (stick) box.scrollTop = box.scrollHeight;
    });
  };

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      let err = res.statusText;
      try { err = (await res.json()).error || err; } catch { /* ignore */ }
      throw new Error(err);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let done = false;
    while (!done) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue; // ": OPENROUTER PROCESSING" keep-alives etc.
        const data = line.slice(5).trim();
        if (data === "[DONE]") { done = true; break; }
        let chunk;
        try { chunk = JSON.parse(data); } catch { continue; }
        if (chunk.error) throw new Error(chunk.error.message || JSON.stringify(chunk.error));
        const choice = chunk.choices && chunk.choices[0];
        const delta = choice?.delta || {};
        const piece = delta.content || "";
        const thought = delta.reasoning || delta.reasoning_content || "";
        if ((piece || thought) && stats.ttft == null) stats.ttft = performance.now() - t0;
        if (piece) msg.content += piece;
        if (thought) msg.reasoning += thought;
        if (chunk.provider) stats.provider = chunk.provider;
        if (choice?.finish_reason) stats.finish_reason = choice.finish_reason;
        if (chunk.usage) {
          stats.prompt_tokens = chunk.usage.prompt_tokens;
          stats.completion_tokens = chunk.usage.completion_tokens;
          if (chunk.usage.cost != null) stats.cost = chunk.usage.cost;
        }
        if (piece || thought) schedulePaint();
      }
    }
    if (!msg.content && !msg.reasoning) msg.error = "The model returned an empty answer.";
    else if (stats.finish_reason === "length") msg.error = "Answer cut off: max output tokens reached.";
  } catch (err) {
    msg.error = err.name === "AbortError" ? "Stopped." : String(err.message || err);
  } finally {
    stats.total = performance.now() - t0;
    msg.pending = false;
    running.delete(id);
    persist();
    rerenderColumn(id);
    updateRunningUi();
  }
}

function stopAll() {
  for (const ctrl of running.values()) ctrl.abort();
}

function updateRunningUi() {
  const busy = running.size > 0;
  $("#stopBtn").hidden = !busy;
  $("#sendBtn").disabled = busy;
  $("#sendBtn").textContent = busy ? `Answering… (${running.size})` : "Send to all";
}

function newChat() {
  if (state.turn > 0 && !confirm("Start a new chat? The current conversation will be cleared (export it first if you want to keep it).")) return;
  stopAll();
  state.threads = {};
  state.turn = 0;
  state.revealed = false;
  state.blindOrder = [];
  persist();
  renderColumns();
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */
function exportData() {
  return {
    exported_at: new Date().toISOString(),
    system_prompt: state.systemPrompt,
    parameters: { temperature: Number(state.temperature), max_tokens: state.maxTokens ? Number(state.maxTokens) : null, reasoning: state.reasoning || null },
    blind_mode: state.blind,
    models: state.selected.map((id) => ({ id, name: modelName(id), blind_label: state.blind ? labelFor(id) : undefined })),
    threads: Object.fromEntries(Object.entries(state.threads).map(([id, t]) => [id, t.map(({ pending, ...m }) => m)])),
  };
}

function exportMarkdown() {
  const lines = [];
  const title = (state.systemPrompt.split("\n")[0] || "Model comparison").slice(0, 80);
  lines.push(`# Model comparison — ${title}`, "", `_Exported ${new Date().toLocaleString()}_`, "");
  lines.push("## Setup", "");
  lines.push(`- **Temperature:** ${state.temperature}`);
  if (state.maxTokens) lines.push(`- **Max tokens:** ${state.maxTokens}`);
  if (state.reasoning) lines.push(`- **Reasoning effort:** ${state.reasoning}`);
  lines.push(`- **Models:** ${state.selected.map((id) => `\`${id}\``).join(", ")}`, "");
  if (state.systemPrompt.trim()) lines.push("**System prompt:**", "", "```", state.systemPrompt.trim(), "```", "");

  // Summary table
  lines.push("## Summary", "", "| Model | Answers | Avg rating | Total cost | Avg time |", "|---|---|---|---|---|");
  for (const id of state.selected) {
    const all = (state.threads[id] || []).filter((m) => m.role === "assistant");
    const ans = all.filter((m) => m.content);
    const failed = all.length - ans.length;
    const rated = ans.filter((m) => m.rating);
    const avg = rated.length ? (rated.reduce((s, m) => s + m.rating, 0) / rated.length).toFixed(1) : "–";
    const cost = ans.reduce((s, m) => s + (m.stats?.cost || 0), 0);
    const times = ans.map((m) => m.stats?.total).filter(Boolean);
    const t = times.length ? `${(times.reduce((a, b) => a + b, 0) / times.length / 1000).toFixed(1)}s` : "–";
    lines.push(`| ${modelLabelMd(id)} | ${ans.length}${failed ? ` (+${failed} failed)` : ""} | ${avg} | ${fmtCost(cost) || "–"} | ${t} |`);
  }
  lines.push("");

  for (let turn = 1; turn <= state.turn; turn++) {
    const q = Object.values(state.threads).flat().find((m) => m.role === "user" && m.turn === turn);
    if (!q) continue;
    lines.push(`---`, "", `## Question ${turn}`, "", "> " + q.content.replace(/\n/g, "\n> "), "");
    for (const id of state.selected) {
      const a = (state.threads[id] || []).find((m) => m.role === "assistant" && m.turn === turn);
      if (!a) continue;
      const meta = [statsText(a), a.rating ? `rating ${a.rating}/5` : ""].filter(Boolean).join(" · ");
      lines.push(`### ${modelLabelMd(id)}`, "");
      if (meta) lines.push(`_${meta}_`, "");
      if (a.error) lines.push(`> ⚠️ ${a.error}`, "");
      lines.push(a.content || "_(no answer)_", "");
    }
  }
  return lines.join("\n");
}

function modelLabelMd(id) {
  const name = modelName(id);
  return name === id ? `\`${id}\`` : `${name} (\`${id}\`)`;
}

function download(filename, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function stamp() {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
}

async function saveToServer() {
  if (!state.turn) { toast("Nothing to save yet."); return; }
  try {
    const res = await fetch("/api/transcripts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: state.systemPrompt.split("\n")[0] || "comparison", markdown: exportMarkdown(), data: exportData() }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error);
    toast(`Saved to ${json.saved}`, 4000);
  } catch (err) {
    toast(`Save failed: ${err.message}`);
  }
}

/* ------------------------------------------------------------------ */
/* Presets (saved subject prompts)                                     */
/* ------------------------------------------------------------------ */
function getPresets() {
  try { return JSON.parse(localStorage.getItem(PRESETS_KEY) || "{}"); } catch { return {}; }
}
function setPresets(p) {
  try { localStorage.setItem(PRESETS_KEY, JSON.stringify(p)); } catch { /* ignore */ }
}
function renderPresets() {
  const sel = $("#presetSelect");
  const presets = getPresets();
  sel.innerHTML = `<option value="">— Saved presets —</option>` +
    Object.keys(presets).sort().map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("");
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */
function bindUi() {
  $("#systemPrompt").value = state.systemPrompt;
  $("#temperature").value = state.temperature;
  $("#tempOut").textContent = state.temperature;
  $("#maxTokens").value = state.maxTokens;
  $("#reasoning").value = state.reasoning;
  $("#blindMode").checked = state.blind;

  $("#systemPrompt").addEventListener("input", (e) => { state.systemPrompt = e.target.value; persist(); });
  $("#temperature").addEventListener("input", (e) => { state.temperature = e.target.value; $("#tempOut").textContent = e.target.value; persist(); });
  $("#maxTokens").addEventListener("input", (e) => { state.maxTokens = e.target.value; persist(); });
  $("#reasoning").addEventListener("change", (e) => { state.reasoning = e.target.value; persist(); });
  $("#blindMode").addEventListener("change", (e) => {
    state.blind = e.target.checked;
    state.revealed = false;
    state.blindOrder = state.blind ? shuffle(state.selected) : [];
    persist();
    renderColumns();
  });
  $("#revealBtn").onclick = () => { state.revealed = true; persist(); renderColumns(); };

  $("#modelSearch").addEventListener("input", renderPicker);
  $("#freeOnly").addEventListener("change", renderPicker);
  $("#modelSearch").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const v = e.target.value.trim();
    const first = $("#modelResults .model-row");
    if (first && !state.catalogById.has(v)) { first.click(); }
    else if (v.includes("/") && !state.selected.includes(v)) { toggleModel(v); }
    e.target.value = "";
    renderPicker();
  });

  $("#sendBtn").onclick = send;
  $("#stopBtn").onclick = stopAll;
  $("#newChatBtn").onclick = newChat;
  $("#userInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
  });

  $("#exportMdBtn").onclick = () => state.turn ? download(`comparison-${stamp()}.md`, exportMarkdown(), "text/markdown") : toast("Nothing to export yet.");
  $("#exportJsonBtn").onclick = () => state.turn ? download(`comparison-${stamp()}.json`, JSON.stringify(exportData(), null, 2), "application/json") : toast("Nothing to export yet.");
  $("#saveServerBtn").onclick = saveToServer;
  $("#toggleSidebar").onclick = () => document.body.classList.toggle("sidebar-hidden");

  $("#presetSelect").addEventListener("change", (e) => {
    const p = getPresets()[e.target.value];
    if (p == null) return;
    state.systemPrompt = p;
    $("#systemPrompt").value = p;
    persist();
  });
  $("#savePresetBtn").onclick = () => {
    if (!state.systemPrompt.trim()) { toast("Write a system prompt first."); return; }
    const name = prompt("Preset name:", $("#presetSelect").value || state.systemPrompt.split("\n")[0].slice(0, 40));
    if (!name) return;
    const p = getPresets(); p[name] = state.systemPrompt; setPresets(p);
    renderPresets(); $("#presetSelect").value = name; toast("Preset saved");
  };
  $("#deletePresetBtn").onclick = () => {
    const name = $("#presetSelect").value;
    if (!name) return;
    const p = getPresets(); delete p[name]; setPresets(p); renderPresets();
  };
}

async function init() {
  restore();
  bindUi();
  renderPresets();
  await loadConfig();
  persist();
  renderPicker();
  renderColumns();
  loadCatalog();
}

document.addEventListener("DOMContentLoaded", init);
