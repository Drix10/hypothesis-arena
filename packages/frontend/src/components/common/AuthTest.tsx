/**
 * Auth Test Component
 *
 * Tests backend authentication flow.
 *
 * SECURITY NOTE: This component stores tokens in localStorage for testing purposes.
 * In production, consider using httpOnly cookies for refresh tokens to prevent XSS attacks.
 * Access tokens in memory + refresh tokens in httpOnly cookies is the recommended pattern.
 */

import React, { useState } from "react";
import { apiClient } from "../../services/api";

interface AuthState {
  isLoggedIn: boolean;
  user: any | null;
  accessToken: string | null;
  refreshToken: string | null;
}

export const AuthTest: React.FC = () => {
  const [authState, setAuthState] = useState<AuthState>({
    isLoggedIn: false,
    user: null,
    accessToken: null,
    refreshToken: null,
  });

  const [formData, setFormData] = useState({
    email: "",
    username: "",
    password: "",
  });

  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const showMessage = (type: "success" | "error", text: string) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 5000);
  };

  const handleRegister = async () => {
    setIsLoading(true);
    try {
      const response = await apiClient.post<any>("/auth/register", {
        email: formData.email,
        username: formData.username,
        password: formData.password,
      });

      // Validate response structure
      if (!response?.tokens?.accessToken || !response?.user) {
        throw new Error("Invalid response from server");
      }

      apiClient.setToken(response.tokens.accessToken);
      // Store refresh token in localStorage for token refresh flow
      if (response.tokens.refreshToken) {
        localStorage.setItem("refresh_token", response.tokens.refreshToken);
      }
      setAuthState({
        isLoggedIn: true,
        user: response.user,
        accessToken: response.tokens.accessToken,
        refreshToken: response.tokens.refreshToken || null,
      });
      showMessage("success", "Registration successful!");
    } catch (error: any) {
      showMessage("error", error.message || "Registration failed");
    } finally {
      setIsLoading(false);
    }
  };

  const handleLogin = async () => {
    setIsLoading(true);
    try {
      const response = await apiClient.post<any>("/auth/login", {
        email: formData.email,
        password: formData.password,
      });

      // Validate response structure
      if (!response?.tokens?.accessToken || !response?.user) {
        throw new Error("Invalid response from server");
      }

      apiClient.setToken(response.tokens.accessToken);
      // Store refresh token in localStorage for token refresh flow
      if (response.tokens.refreshToken) {
        localStorage.setItem("refresh_token", response.tokens.refreshToken);
      }
      setAuthState({
        isLoggedIn: true,
        user: response.user,
        accessToken: response.tokens.accessToken,
        refreshToken: response.tokens.refreshToken || null,
      });
      showMessage("success", "Login successful!");
    } catch (error: any) {
      showMessage("error", error.message || "Login failed");
    } finally {
      setIsLoading(false);
    }
  };

  const handleGetMe = async () => {
    setIsLoading(true);
    try {
      const response = await apiClient.get<any>("/auth/me");

      // Validate response structure
      if (!response?.user) {
        throw new Error("Invalid response from server");
      }

      setAuthState((prev) => ({ ...prev, user: response.user }));
      showMessage("success", "User data fetched!");
    } catch (error: any) {
      showMessage("error", error.message || "Failed to get user");
    } finally {
      setIsLoading(false);
    }
  };

  const handleRefresh = async () => {
    if (!authState.refreshToken) {
      showMessage("error", "No refresh token available");
      return;
    }

    setIsLoading(true);
    try {
      const response = await apiClient.post<any>("/auth/refresh", {
        refreshToken: authState.refreshToken,
      });

      // Validate response structure
      if (!response?.accessToken) {
        throw new Error("Invalid response from server");
      }

      apiClient.setToken(response.accessToken);
      setAuthState((prev) => ({
        ...prev,
        accessToken: response.accessToken,
        refreshToken: response.refreshToken || prev.refreshToken,
      }));
      showMessage("success", "Token refreshed!");
    } catch (error: any) {
      showMessage("error", error.message || "Refresh failed");
    } finally {
      setIsLoading(false);
    }
  };

  const handleLogout = () => {
    apiClient.logout();
    setAuthState({
      isLoggedIn: false,
      user: null,
      accessToken: null,
      refreshToken: null,
    });
    showMessage("success", "Logged out");
  };

  return (
    <div
      style={{
        padding: "24px",
        background: "linear-gradient(165deg, #0d1117 0%, #080b0f 100%)",
        borderRadius: "16px",
        border: "1px solid rgba(255,255,255,0.08)",
        maxWidth: "500px",
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
        🔐 Auth Test
      </h2>

      {message && (
        <div
          style={{
            padding: "12px",
            marginBottom: "16px",
            borderRadius: "8px",
            background:
              message.type === "success"
                ? "rgba(34,197,94,0.15)"
                : "rgba(239,68,68,0.15)",
            border: `1px solid ${
              message.type === "success"
                ? "rgba(34,197,94,0.3)"
                : "rgba(239,68,68,0.3)"
            }`,
            color: message.type === "success" ? "#22c55e" : "#ef4444",
            fontSize: "14px",
          }}
        >
          {message.text}
        </div>
      )}

      {!authState.isLoggedIn ? (
        <>
          <div style={{ marginBottom: "16px" }}>
            <input
              type="email"
              placeholder="Email"
              value={formData.email}
              onChange={(e) =>
                setFormData((prev) => ({ ...prev, email: e.target.value }))
              }
              style={inputStyle}
            />
          </div>
          <div style={{ marginBottom: "16px" }}>
            <input
              type="text"
              placeholder="Username (for register)"
              value={formData.username}
              onChange={(e) =>
                setFormData((prev) => ({ ...prev, username: e.target.value }))
              }
              style={inputStyle}
            />
          </div>
          <div style={{ marginBottom: "16px" }}>
            <input
              type="password"
              placeholder="Password"
              value={formData.password}
              onChange={(e) =>
                setFormData((prev) => ({ ...prev, password: e.target.value }))
              }
              style={inputStyle}
            />
          </div>
          <div style={{ display: "flex", gap: "12px" }}>
            <button
              onClick={handleLogin}
              disabled={isLoading}
              style={{ ...buttonStyle, flex: 1 }}
            >
              {isLoading ? "Loading..." : "Login"}
            </button>
            <button
              onClick={handleRegister}
              disabled={isLoading}
              style={{
                ...buttonStyle,
                flex: 1,
                background: "rgba(255,255,255,0.1)",
              }}
            >
              {isLoading ? "Loading..." : "Register"}
            </button>
          </div>
        </>
      ) : (
        <>
          <div
            style={{
              padding: "16px",
              background: "rgba(0,0,0,0.3)",
              borderRadius: "12px",
              marginBottom: "16px",
            }}
          >
            <div
              style={{
                color: "#94a3b8",
                fontSize: "12px",
                marginBottom: "8px",
              }}
            >
              Logged in as:
            </div>
            <div style={{ color: "#fff", fontWeight: "bold" }}>
              {authState.user?.username || authState.user?.email}
            </div>
            <div
              style={{ color: "#64748b", fontSize: "12px", marginTop: "4px" }}
            >
              {authState.user?.email}
            </div>
          </div>

          <div
            style={{
              padding: "12px",
              background: "rgba(0,240,255,0.05)",
              borderRadius: "8px",
              marginBottom: "16px",
              fontSize: "11px",
              fontFamily: "monospace",
              color: "#94a3b8",
              wordBreak: "break-all",
            }}
          >
            <div style={{ color: "#00f0ff", marginBottom: "4px" }}>
              Access Token:
            </div>
            {authState.accessToken?.substring(0, 50)}...
          </div>

          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <button
              onClick={handleGetMe}
              disabled={isLoading}
              style={smallButtonStyle}
            >
              Get Me
            </button>
            <button
              onClick={handleRefresh}
              disabled={isLoading}
              style={smallButtonStyle}
            >
              Refresh Token
            </button>
            <button
              onClick={handleLogout}
              style={{
                ...smallButtonStyle,
                background: "rgba(239,68,68,0.2)",
                borderColor: "rgba(239,68,68,0.3)",
              }}
            >
              Logout
            </button>
          </div>
        </>
      )}

      <div
        style={{
          marginTop: "20px",
          padding: "12px",
          background: "rgba(255,215,0,0.05)",
          borderRadius: "8px",
          border: "1px solid rgba(255,215,0,0.2)",
        }}
      >
        <p style={{ color: "#94a3b8", fontSize: "12px", margin: 0 }}>
          <strong style={{ color: "#ffd700" }}>Note:</strong> Requires backend
          running with database. Use{" "}
          <code style={{ color: "#00f0ff" }}>npm run dev</code> to start both
          frontend and backend.
        </p>
      </div>
    </div>
  );
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "12px",
  background: "rgba(255,255,255,0.05)",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: "8px",
  color: "#fff",
  fontSize: "14px",
  boxSizing: "border-box",
};

const buttonStyle: React.CSSProperties = {
  padding: "14px",
  background: "linear-gradient(135deg, #00f0ff 0%, #0080ff 100%)",
  border: "none",
  borderRadius: "8px",
  color: "#fff",
  fontSize: "14px",
  fontWeight: "bold",
  cursor: "pointer",
};

const smallButtonStyle: React.CSSProperties = {
  padding: "10px 16px",
  background: "rgba(255,255,255,0.05)",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: "8px",
  color: "#fff",
  fontSize: "12px",
  cursor: "pointer",
};

export default AuthTest;
