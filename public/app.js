// Hypothesis Arena - Frontend
const API_BASE = "/api";

// State
let refreshInterval = null;
const MAX_LOGS = 100;
let lastEngineStatus = null; // Track to avoid duplicate logs

// Initialize
document.addEventListener("DOMContentLoaded", () => {
  refreshStatus();
  startAutoRefresh();
});

// Auto refresh every 10 seconds
function startAutoRefresh() {
  if (refreshInterval) clearInterval(refreshInterval);
  refreshInterval = setInterval(refreshStatus, 10000);
}

// Refresh all status
async function refreshStatus() {
  await Promise.all([
    fetchEngineStatus(),
    fetchPortfolio(),
    fetchPositions(),
    fetchRecentActivity(),
  ]);
}

// Fetch engine status
async function fetchEngineStatus() {
  try {
    const res = await fetch(`${API_BASE}/autonomous/status`);
    const data = await res.json();

    // Handle response structure: { success, data: { isRunning, dryRun, ... } }
    const status = data.data || data;

    updateElement(
      "engine-status",
      status.isRunning ? "Running" : "Stopped",
      status.isRunning ? "online" : "offline"
    );
    updateElement(
      "mode-status",
      status.dryRun ? "Dry Run" : "Live Trading",
      status.dryRun ? "offline" : "online"
    );
    updateElement(
      "last-cycle",
      status.lastCycleTime ? formatTime(status.lastCycleTime) : "Never"
    );

    // Update button states
    document.getElementById("btn-start").disabled = status.isRunning;
    document.getElementById("btn-stop").disabled = !status.isRunning;

    // Only log if status changed
    const currentStatus = status.isRunning ? "Running" : "Stopped";
    if (lastEngineStatus !== currentStatus) {
      addLog("info", `Engine status: ${currentStatus}`);
      lastEngineStatus = currentStatus;
    }
  } catch (err) {
    updateElement("engine-status", "Error", "offline");
    addLog("error", `Failed to fetch engine status: ${err.message}`);
  }

  // Fetch health for DB status
  try {
    const res = await fetch("/health");
    const data = await res.json();
    updateElement(
      "db-status",
      data.services?.database || "Unknown",
      data.services?.database === "connected" ? "online" : "offline"
    );
  } catch (err) {
    updateElement("db-status", "Error", "offline");
  }
}

// Fetch portfolio from WEEX
async function fetchPortfolio() {
  try {
    const res = await fetch(`${API_BASE}/weex/assets`);
    const data = await res.json();

    // Handle response structure: { assets: { equity, available, ... } }
    const assets = data.assets || data.data || {};

    updateElement("balance", formatCurrency(assets.available || 0));
    updateElement("equity", formatCurrency(assets.equity || 0));

    const pnl = parseFloat(assets.unrealizedPL) || 0;
    updateElement(
      "unrealized-pnl",
      formatCurrency(pnl),
      pnl >= 0 ? "positive" : "negative"
    );
  } catch (err) {
    // Silent fail - don't spam logs
  }
}

// Fetch positions from WEEX
async function fetchPositions() {
  try {
    const res = await fetch(`${API_BASE}/weex/positions`);
    const data = await res.json();

    const container = document.getElementById("positions-list");
    const countEl = document.getElementById("positions-count");

    // Handle response structure: { positions: [...] }
    const positions = data.positions || data.data || [];

    if (Array.isArray(positions) && positions.length > 0) {
      countEl.textContent = positions.length;
      container.innerHTML = positions
        .map(
          (pos) => `
                <div class="position-card">
                    <div>
                        <span class="symbol">${escapeHtml(
                          pos.symbol || ""
                        )}</span>
                        <span class="side-${(
                          pos.side || ""
                        ).toLowerCase()}">${escapeHtml(pos.side || "")}</span>
                    </div>
                    <div>
                        <span class="label">Size</span>
                        <span class="value">${formatNumber(
                          pos.size || 0
                        )}</span>
                    </div>
                    <div>
                        <span class="label">Entry</span>
                        <span class="value">${formatNumber(
                          pos.entryPrice || pos.avgPrice || 0
                        )}</span>
                    </div>
                    <div>
                        <span class="label">Mark</span>
                        <span class="value">${formatNumber(
                          pos.markPrice || 0
                        )}</span>
                    </div>
                    <div>
                        <span class="label">PnL</span>
                        <span class="value ${
                          (parseFloat(pos.unrealizedPL || pos.unrealizePnl) ||
                            0) >= 0
                            ? "positive"
                            : "negative"
                        }">
                            ${formatCurrency(
                              pos.unrealizedPL || pos.unrealizePnl || 0
                            )}
                        </span>
                    </div>
                    <div>
                        <span class="label">Leverage</span>
                        <span class="value">${pos.leverage || 1}x</span>
                    </div>
                </div>
            `
        )
        .join("");
    } else {
      countEl.textContent = "0";
      container.innerHTML = '<p class="empty">No open positions</p>';
    }
  } catch (err) {
    // Silent fail
  }
}

// Fetch recent activity
async function fetchRecentActivity() {
  try {
    const res = await fetch(`${API_BASE}/autonomous/history?limit=10`);
    const data = await res.json();

    const container = document.getElementById("activity-log");
    const items = data.data || [];

    if (Array.isArray(items) && items.length > 0) {
      container.innerHTML = items
        .map(
          (item) => `
                <div class="activity-item">
                    <div>
                        <strong>${escapeHtml(
                          item.symbol || "Unknown"
                        )}</strong> - 
                        ${escapeHtml(item.action || item.type || "Activity")}
                        ${item.result ? `(${escapeHtml(item.result)})` : ""}
                    </div>
                    <span class="time">${formatTime(
                      item.timestamp || item.createdAt
                    )}</span>
                </div>
            `
        )
        .join("");
    } else {
      container.innerHTML = '<p class="empty">No recent activity</p>';
    }
  } catch (err) {
    // Silent fail for activity
  }
}

// Engine controls
async function startEngine() {
  try {
    addLog("info", "Starting engine...");
    const res = await fetch(`${API_BASE}/autonomous/start`, { method: "POST" });
    const data = await res.json();

    if (data.success) {
      addLog("info", "✅ Engine started successfully");
      lastEngineStatus = null; // Reset to force log on next refresh
    } else {
      addLog("error", `Failed to start: ${data.error || "Unknown error"}`);
    }

    await refreshStatus();
  } catch (err) {
    addLog("error", `Failed to start engine: ${err.message}`);
  }
}

async function stopEngine() {
  try {
    addLog("info", "Stopping engine...");
    const res = await fetch(`${API_BASE}/autonomous/stop`, { method: "POST" });
    const data = await res.json();

    if (data.success) {
      addLog("info", "⏹ Engine stopped");
      lastEngineStatus = null; // Reset to force log on next refresh
    } else {
      addLog("error", `Failed to stop: ${data.error || "Unknown error"}`);
    }

    await refreshStatus();
  } catch (err) {
    addLog("error", `Failed to stop engine: ${err.message}`);
  }
}

async function triggerCycle() {
  try {
    addLog("info", "🔄 Triggering manual cycle...");
    const res = await fetch(`${API_BASE}/autonomous/trigger`, {
      method: "POST",
    });
    const data = await res.json();

    if (data.success) {
      addLog("info", "✅ Cycle triggered");
    } else {
      addLog("error", `Failed to trigger: ${data.error || "Unknown error"}`);
    }
  } catch (err) {
    addLog("error", `Failed to trigger cycle: ${err.message}`);
  }
}

// Utility functions
function updateElement(id, value, className = "") {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = value;
    el.className = "value" + (className ? ` ${className}` : "");
  }
}

function formatCurrency(value) {
  const num = parseFloat(value) || 0;
  return (num >= 0 ? "+" : "") + "$" + Math.abs(num).toFixed(2);
}

function formatNumber(value) {
  return (parseFloat(value) || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatTime(timestamp) {
  if (!timestamp) return "N/A";
  const date = new Date(timestamp);
  return date.toLocaleTimeString();
}

// XSS protection - escape HTML entities
function escapeHtml(text) {
  if (text === null || text === undefined) return "";
  const str = String(text);
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function addLog(level, message) {
  const container = document.getElementById("logs");
  if (!container) return;

  const entry = document.createElement("p");
  entry.className = `log-entry ${level}`;
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;

  // Keep only last MAX_LOGS entries
  while (container.children.length >= MAX_LOGS) {
    container.removeChild(container.firstChild);
  }

  container.appendChild(entry);
  container.scrollTop = container.scrollHeight;
}
