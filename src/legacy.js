const $ = (id) => document.getElementById(id);
const state = { currentCampaignId: null, pollTimer: null, active: false, uploadedEmails: [] };

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
function showNotice(id, message, kind = "") {
  const el = $(id);
  el.textContent = message || "";
  el.className = `notice ${kind}`.trim();
}
function escapeText(value) {
  return String(value ?? "");
}
function dateText(value) {
  return value ? new Date(value).toLocaleString() : "—";
}
function statusCell(status) {
  const span = document.createElement("span");
  span.className = `status-${status}`;
  span.textContent = status;
  return span;
}
function appendCell(row, value, className = "") {
  const cell = document.createElement("td");
  if (value instanceof Node) cell.appendChild(value);
  else cell.textContent = escapeText(value);
  if (className) cell.className = className;
  row.appendChild(cell);
  return cell;
}

async function checkSession() {
  try {
    const data = await api("/api/session");
    if (data.authenticated) showApp(data.email);
    else showLogin();
  } catch {
    showLogin();
    showNotice("loginError", "Cannot connect to the server. Check MongoDB and server logs.", "error");
  }
}
function showLogin() {
  $("loginView").hidden = false;
  $("appView").hidden = true;
}
async function showApp(email) {
  $("loginView").hidden = true;
  $("appView").hidden = false;
  $("userEmail").textContent = email;
  $("from").value = "";
  try {
    const config = await api("/api/config");
    $("from").value = config.sender || "";
  } catch {}
  await refreshDashboard();
  await refreshUnsubscribes();
}

$("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  showNotice("loginError", "");
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const data = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ email: $("loginEmail").value, password: $("loginPassword").value })
    });
    await showApp(data.email);
  } catch (err) {
    showNotice("loginError", err.message, "error");
  } finally {
    button.disabled = false;
  }
});

$("logoutButton").addEventListener("click", async () => {
  try { await api("/api/logout", { method: "POST" }); } catch {}
  if (state.pollTimer) clearTimeout(state.pollTimer);
  state.currentCampaignId = null;
  showLogin();
});

$("leads").addEventListener("change", async () => {
  state.uploadedEmails = [];
  const file = $("leads").files[0];
  if (!file) {
    $("leadInfo").textContent = "No leads file selected.";
    return;
  }
  if (!file.name.toLowerCase().endsWith(".txt") || file.size > 1024 * 1024) {
    $("leads").value = "";
    $("leadInfo").textContent = "Choose a .txt file no larger than 1 MB.";
    return;
  }
  try {
    const text = await file.text();
    const entries = text.split(/[\s,;]+/).filter(Boolean);
    const valid = [];
    let invalid = 0;
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    for (const entry of entries) {
      const email = entry.trim().toLowerCase();
      if (emailRegex.test(email)) valid.push(email);
      else invalid++;
    }
    state.uploadedEmails = [...new Set(valid)];
    $("leadInfo").textContent = `${state.uploadedEmails.length} unique valid email(s) found.${invalid ? ` ${invalid} invalid entries skipped.` : ""}`;
    if (state.uploadedEmails.length) $("to").value = state.uploadedEmails[0];
  } catch {
    $("leadInfo").textContent = "Unable to read the file.";
  }
});

$("clearButton").addEventListener("click", () => {
  $("campaignForm").reset();
  state.uploadedEmails = [];
  $("leadInfo").textContent = "No leads file selected.";
  showNotice("campaignNotice", "");
});

$("campaignForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.active) return;
  const recipients = state.uploadedEmails.length ? state.uploadedEmails : [$("to").value.trim().toLowerCase()];
  if (!state.uploadedEmails.length && !recipients[0]) {
    showNotice("campaignNotice", "Enter a To address or upload a valid TXT leads file.", "error");
    return;
  }
  if (state.uploadedEmails.length === 0 && !$("to").checkValidity()) {
    showNotice("campaignNotice", "Enter a valid recipient email address.", "error");
    return;
  }
  state.active = true;
  $("sendButton").disabled = true;
  showNotice("campaignNotice", "Submitting campaign…");
  try {
    const data = await api("/api/campaigns", {
      method: "POST",
      body: JSON.stringify({
        from: $("from").value.trim(),
        subject: $("subject").value.trim(),
        message: $("message").value.trim(),
        recipients
      })
    });
    state.currentCampaignId = data.campaignId;
    $("activePanel").hidden = false;
    $("activeSubject").textContent = $("subject").value.trim();
    showNotice("campaignNotice", "Campaign started. You can monitor progress below.", "success");
    await refreshDashboard();
    pollCampaign();
  } catch (err) {
    showNotice("campaignNotice", err.message, "error");
    state.active = false;
    $("sendButton").disabled = false;
  }
});

async function pollCampaign() {
  if (!state.currentCampaignId) return;
  try {
    const data = await api(`/api/campaigns/${encodeURIComponent(state.currentCampaignId)}`);
    renderCampaign(data);
    if (["completed", "failed", "cancelled"].includes(data.status)) {
      state.active = false;
      $("sendButton").disabled = false;
      await refreshDashboard();
      return;
    }
  } catch (err) {
    showNotice("campaignNotice", `Unable to refresh campaign: ${err.message}`, "error");
  }
  state.pollTimer = setTimeout(pollCampaign, 2000);
}

function renderCampaign(data) {
  $("activePanel").hidden = false;
  $("campaignStatus").textContent = data.status;
  $("campaignStatus").className = "pill";
  const done = data.sent + data.failed + data.skipped;
  const percent = data.total ? Math.round(done / data.total * 100) : 0;
  $("progressFill").style.width = `${percent}%`;
  $("progressPercent").textContent = `${percent}%`;
  $("progressCounts").textContent = `Total ${data.total} · Sent ${data.sent} · Failed ${data.failed} · Skipped ${data.skipped} · Remaining ${data.pending}`;
  $("pauseButton").hidden = data.status !== "sending";
  $("resumeButton").hidden = data.status !== "paused";
  $("cancelButton").hidden = !["sending", "paused", "queued"].includes(data.status);
  const rows = $("recipientRows");
  rows.replaceChildren();
  for (const recipient of data.recipients.slice(-100)) {
    const row = document.createElement("tr");
    appendCell(row, recipient.email);
    appendCell(row, statusCell(recipient.status));
    appendCell(row, recipient.error || (recipient.attempts ? `Attempts: ${recipient.attempts}` : "—"));
    rows.appendChild(row);
  }
}

$("pauseButton").addEventListener("click", () => campaignAction("pause"));
$("resumeButton").addEventListener("click", () => campaignAction("resume"));
$("cancelButton").addEventListener("click", async () => {
  if (!confirm("Cancel this campaign? The current in-flight email may still finish.")) return;
  await campaignAction("cancel");
});
async function campaignAction(action) {
  if (!state.currentCampaignId) return;
  try {
    const data = await api(`/api/campaigns/${encodeURIComponent(state.currentCampaignId)}/${action}`, { method: "POST" });
    showNotice("campaignNotice", data.message || `Campaign ${action} requested.`, "success");
    await pollCampaign();
  } catch (err) {
    showNotice("campaignNotice", err.message, "error");
  }
}

$("refreshButton").addEventListener("click", refreshDashboard);
async function refreshDashboard() {
  try {
    const data = await api("/api/dashboard");
    $("totalCampaigns").textContent = data.campaigns.length;
    $("totalSent").textContent = data.campaigns.reduce((sum, c) => sum + c.sent, 0);
    $("totalFailed").textContent = data.campaigns.reduce((sum, c) => sum + c.failed, 0);
    $("totalUnsubscribed").textContent = data.suppressedCount;
    const rows = $("historyRows");
    rows.replaceChildren();
    if (!data.campaigns.length) {
      appendCell(rows.insertRow(), "No campaigns yet.").colSpan = 7;
      return;
    }
    for (const campaign of data.campaigns) {
      const row = document.createElement("tr");
      appendCell(row, campaign.subject);
      appendCell(row, statusCell(campaign.status));
      appendCell(row, campaign.total);
      appendCell(row, campaign.sent);
      appendCell(row, campaign.failed);
      appendCell(row, dateText(campaign.createdAt));
      const actionCell = document.createElement("td");
      const button = document.createElement("button");
      button.className = "button-secondary table-action";
      button.textContent = "View";
      button.addEventListener("click", async () => {
        state.currentCampaignId = String(campaign.id);
        state.active = ["queued", "sending", "paused"].includes(campaign.status);
        $("sendButton").disabled = state.active;
        $("activeSubject").textContent = campaign.subject;
        $("activePanel").hidden = false;
        if (state.pollTimer) clearTimeout(state.pollTimer);
        await pollCampaign();
      });
      actionCell.appendChild(button);
      row.appendChild(actionCell);
      rows.appendChild(row);
    }
  } catch (err) {
    showNotice("campaignNotice", `Dashboard error: ${err.message}`, "error");
  }
}

$("refreshUnsubButton").addEventListener("click", refreshUnsubscribes);
async function refreshUnsubscribes() {
  try {
    const data = await api("/api/unsubscribes");
    const rows = $("unsubRows");
    rows.replaceChildren();
    if (!data.unsubscribes.length) {
      appendCell(rows.insertRow(), "No unsubscribed addresses.").colSpan = 3;
      return;
    }
    for (const entry of data.unsubscribes) {
      const row = document.createElement("tr");
      appendCell(row, entry.email);
      appendCell(row, entry.reason);
      appendCell(row, dateText(entry.createdAt));
      rows.appendChild(row);
    }
  } catch (err) {
    $("unsubRows").replaceChildren();
    appendCell($("unsubRows").insertRow(), err.message).colSpan = 3;
  }
}

checkSession();
