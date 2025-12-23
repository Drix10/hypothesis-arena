/**
 * WEEX Connection Test Component
 *
 * Tests backend auth and WEEX API connectivity.
 */

import React, { useState } from "react";
import { weexApi, apiClient } from "../../services/api";

interface TestResult {
  name: string;
  status: "pending" | "success" | "error";
  data?: any;
  error?: string;
  duration?: number;
}

export const WeexTest: React.FC = () => {
  const [results, setResults] = useState<TestResult[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [authToken, setAuthToken] = useState("");

  const updateResult = (name: string, update: Partial<TestResult>) => {
    setResults((prev) =>
      prev.map((r) => (r.name === name ? { ...r, ...update } : r))
    );
  };

  const runTest = async (name: string, fn: () => Promise<any>) => {
    const start = Date.now();
    try {
      const data = await fn();
      updateResult(name, {
        status: "success",
        data,
        duration: Date.now() - start,
      });
      return true;
    } catch (error: any) {
      updateResult(name, {
        status: "error",
        error: error.message,
        duration: Date.now() - start,
      });
      return false;
    }
  };

  const runAllTests = async () => {
    setIsRunning(true);

    // Initialize test list
    const tests: TestResult[] = [
      { name: "WEEX Status", status: "pending" },
      { name: "Get Tickers", status: "pending" },
      { name: "Get BTC Ticker", status: "pending" },
      { name: "Get Orderbook", status: "pending" },
      { name: "Get Candles", status: "pending" },
      { name: "Get Contracts", status: "pending" },
    ];

    // Add auth tests if token is set
    if (authToken) {
      tests.push(
        { name: "Auth Test (Account)", status: "pending" },
        { name: "Auth Test (Positions)", status: "pending" },
        { name: "Auth Test (Assets)", status: "pending" },
        { name: "Full Auth Test", status: "pending" }
      );
    }

    setResults(tests);

    // Run public tests
    await runTest("WEEX Status", () => weexApi.getStatus());
    await runTest("Get Tickers", () => weexApi.getTickers());
    await runTest("Get BTC Ticker", () => weexApi.getTicker("cmt_btcusdt"));
    await runTest("Get Orderbook", () => weexApi.getDepth("cmt_btcusdt", 5));
    await runTest("Get Candles", () =>
      weexApi.getCandles("cmt_btcusdt", "1m", 10)
    );
    await runTest("Get Contracts", () => weexApi.getContracts());

    // Run auth tests if token is set
    if (authToken) {
      const previousToken = apiClient.getToken() ?? null;
      apiClient.setToken(authToken);
      try {
        await runTest("Auth Test (Account)", () => weexApi.getAccount());
        await runTest("Auth Test (Positions)", () => weexApi.getPositions());
        await runTest("Auth Test (Assets)", () => weexApi.getAssets());
        await runTest("Full Auth Test", () => weexApi.testAuth());
      } finally {
        // Restore previous token or clear it
        if (previousToken) {
          apiClient.setToken(previousToken);
        } else {
          apiClient.setToken(null);
        }
      }
    }

    setIsRunning(false);
  };

  const getStatusColor = (status: TestResult["status"]) => {
    switch (status) {
      case "success":
        return "#22c55e";
      case "error":
        return "#ef4444";
      default:
        return "#ffd700";
    }
  };

  const getStatusIcon = (status: TestResult["status"]) => {
    switch (status) {
      case "success":
        return "✓";
      case "error":
        return "✗";
      default:
        return "⏳";
    }
  };

  return (
    <div
      style={{
        padding: "24px",
        background: "linear-gradient(165deg, #0d1117 0%, #080b0f 100%)",
        borderRadius: "16px",
        border: "1px solid rgba(255,255,255,0.08)",
        maxWidth: "600px",
        margin: "20px auto",
      }}
    >
      <h2
        style={{
          color: "#fff",
          marginBottom: "20px",
          fontFamily: "'Space Grotesk', sans-serif",
        }}
      >
        🔌 WEEX Connection Test
      </h2>

      <div style={{ marginBottom: "20px" }}>
        <label
          style={{
            color: "#94a3b8",
            fontSize: "14px",
            display: "block",
            marginBottom: "8px",
          }}
        >
          Auth Token (optional - for private endpoints):
        </label>
        <input
          type="text"
          value={authToken}
          onChange={(e) => setAuthToken(e.target.value)}
          placeholder="Enter JWT token to test auth..."
          style={{
            width: "100%",
            padding: "12px",
            background: "rgba(255,255,255,0.05)",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: "8px",
            color: "#fff",
            fontSize: "14px",
          }}
        />
      </div>

      <button
        onClick={runAllTests}
        disabled={isRunning}
        style={{
          width: "100%",
          padding: "14px",
          background: isRunning
            ? "rgba(255,255,255,0.1)"
            : "linear-gradient(135deg, #00f0ff 0%, #0080ff 100%)",
          border: "none",
          borderRadius: "8px",
          color: "#fff",
          fontSize: "16px",
          fontWeight: "bold",
          cursor: isRunning ? "not-allowed" : "pointer",
          marginBottom: "20px",
        }}
      >
        {isRunning ? "Running Tests..." : "Run All Tests"}
      </button>

      {results.length > 0 && (
        <div
          style={{
            background: "rgba(0,0,0,0.3)",
            borderRadius: "12px",
            padding: "16px",
          }}
        >
          {results.map((result, i) => (
            <div
              key={result.name}
              style={{
                padding: "12px",
                borderBottom:
                  i < results.length - 1
                    ? "1px solid rgba(255,255,255,0.05)"
                    : "none",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: result.status !== "pending" ? "8px" : 0,
                }}
              >
                <span style={{ color: "#fff", fontWeight: "500" }}>
                  <span
                    style={{
                      color: getStatusColor(result.status),
                      marginRight: "8px",
                    }}
                  >
                    {getStatusIcon(result.status)}
                  </span>
                  {result.name}
                </span>
                {result.duration !== undefined && (
                  <span style={{ color: "#64748b", fontSize: "12px" }}>
                    {result.duration}ms
                  </span>
                )}
              </div>

              {result.status === "error" && result.error && (
                <div
                  style={{
                    color: "#ef4444",
                    fontSize: "12px",
                    background: "rgba(239,68,68,0.1)",
                    padding: "8px",
                    borderRadius: "4px",
                    marginTop: "4px",
                  }}
                >
                  {result.error}
                </div>
              )}

              {result.status === "success" && result.data && (
                <div
                  style={{
                    color: "#94a3b8",
                    fontSize: "11px",
                    background: "rgba(255,255,255,0.03)",
                    padding: "8px",
                    borderRadius: "4px",
                    marginTop: "4px",
                    fontFamily: "monospace",
                    maxHeight: "100px",
                    overflow: "auto",
                  }}
                >
                  {JSON.stringify(result.data, null, 2).substring(0, 500)}
                  {JSON.stringify(result.data).length > 500 && "..."}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div
        style={{
          marginTop: "20px",
          padding: "12px",
          background: "rgba(0,240,255,0.05)",
          borderRadius: "8px",
          border: "1px solid rgba(0,240,255,0.2)",
        }}
      >
        <p style={{ color: "#94a3b8", fontSize: "12px", margin: 0 }}>
          <strong style={{ color: "#00f0ff" }}>Note:</strong> Public endpoints
          test WEEX API connectivity. Private endpoints require a valid JWT
          token from /api/auth/login.
        </p>
      </div>
    </div>
  );
};

export default WeexTest;
