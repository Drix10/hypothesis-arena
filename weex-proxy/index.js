/**
 * WEEX API Proxy Server
 *
 * Routes requests through a whitelisted IP to WEEX API.
 * No dependencies - uses Node.js built-ins only.
 *
 * Environment Variables:
 *   PROXY_TOKEN       - Secret token for auth (required for security)
 *   PROXY_PORT        - Port to listen on (default: 3080)
 *   WEEX_PROXY_TOKEN  - Alternative token name (for consistency with backend)
 */

const http = require("http");
const https = require("https");

const PORT = parseInt(
  process.env.PROXY_PORT || process.env.SERVER_PORT || "3080",
  10
);
const PROXY_TOKEN =
  process.env.PROXY_TOKEN || process.env.WEEX_PROXY_TOKEN || "";
const WEEX_HOST = "api-contract.weex.com";
const MAX_REQUEST_SIZE = 1024 * 1024; // 1MB max request body

// Hop-by-hop headers that should not be forwarded (RFC 2616)
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "x-proxy-token",
]);

// Methods that can have a request body
const METHODS_WITH_BODY = new Set(["POST", "PUT", "PATCH", "DELETE"]);

if (!PROXY_TOKEN) {
  console.log("⚠️  WARNING: No PROXY_TOKEN set. Set it for security!");
  console.log("   Add PROXY_TOKEN=your-secret to your startup config.\n");
}

/**
 * Safe response sender - prevents double responses
 */
function createResponseSender(res) {
  let sent = false;
  let cleaned = false;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
  };

  return {
    isSent: () => sent,
    send: (statusCode, data) => {
      if (sent) return false;
      sent = true;
      try {
        res.writeHead(statusCode, { "Content-Type": "application/json" });
        res.end(typeof data === "string" ? data : JSON.stringify(data));
      } catch (e) {
        // Response already ended or destroyed
      }
      cleanup();
      return true;
    },
    pipe: (statusCode, headers, sourceStream) => {
      if (sent) return false;
      sent = true;

      try {
        res.writeHead(statusCode, headers);
      } catch (e) {
        cleanup();
        return false;
      }

      // Handle source stream errors
      const onSourceError = (err) => {
        sourceStream.unpipe(res);
        try {
          res.destroy(err);
        } catch (e) {
          // Ignore
        }
        cleanup();
      };

      // Handle response errors/close
      const onResError = () => {
        sourceStream.unpipe(res);
        sourceStream.destroy();
        cleanup();
      };

      const onEnd = () => {
        sourceStream.removeListener("error", onSourceError);
        res.removeListener("error", onResError);
        res.removeListener("close", onResError);
        cleanup();
      };

      sourceStream.on("error", onSourceError);
      sourceStream.on("end", onEnd);
      res.on("error", onResError);
      res.on("close", onResError);

      sourceStream.pipe(res);
      return true;
    },
  };
}

const server = http.createServer((req, res) => {
  const clientIP = req.socket.remoteAddress;
  const timestamp = new Date().toISOString();
  const sender = createResponseSender(res);

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, X-Proxy-Token, ACCESS-KEY, ACCESS-TIMESTAMP, ACCESS-PASSPHRASE, ACCESS-SIGN, locale",
      "Access-Control-Max-Age": "86400",
    });
    res.end();
    return;
  }

  // Health check endpoint
  if (req.url === "/health" || req.url === "/") {
    sender.send(200, {
      status: "ok",
      proxy: "weex-api",
      target: WEEX_HOST,
      timestamp,
    });
    return;
  }

  // Check outbound IP
  if (req.url === "/my-ip") {
    const ipReq = https.request(
      {
        hostname: "api.ipify.org",
        port: 443,
        path: "/?format=json",
        method: "GET",
        timeout: 10000,
      },
      (ipRes) => {
        let data = "";
        ipRes.on("data", (chunk) => (data += chunk));
        ipRes.on("end", () => {
          try {
            // Parse the JSON response from ipify
            const ipData = JSON.parse(data);
            sender.send(200, {
              status: "ok",
              outboundIP: ipData.ip || ipData,
              message: "This is the IP that WEEX sees from this server",
            });
          } catch (parseError) {
            sender.send(200, {
              status: "error",
              error: "Failed to parse IP response",
              raw: data,
            });
          }
        });
      }
    );
    ipReq.on("error", (e) => {
      sender.send(200, { status: "error", error: e.message });
    });
    ipReq.on("timeout", () => {
      ipReq.destroy();
      sender.send(200, { status: "error", error: "Request timeout" });
    });
    ipReq.end();
    return;
  }

  // Test outbound connectivity to WEEX
  if (req.url === "/test-weex") {
    let testResponseSent = false;

    const testReq = https.request(
      {
        hostname: WEEX_HOST,
        port: 443,
        path: "/capi/v2/market/time",
        method: "GET",
        headers: { "Content-Type": "application/json" },
        timeout: 10000,
      },
      (testRes) => {
        if (testResponseSent) return;

        let data = "";
        testRes.on("data", (chunk) => {
          data += chunk;
          if (data.length > 10000) {
            data = data.substring(0, 10000);
            testRes.destroy();
          }
        });
        testRes.on("end", () => {
          if (testResponseSent) return;
          testResponseSent = true;
          sender.send(200, {
            status: "ok",
            weexStatus: testRes.statusCode,
            weexResponse: data.substring(0, 500),
            message: "Outbound HTTPS to WEEX is working!",
          });
        });
        testRes.on("error", (e) => {
          if (testResponseSent) return;
          testResponseSent = true;
          sender.send(200, {
            status: "error",
            error: e.message,
            message: "Error reading WEEX response",
          });
        });
      }
    );

    testReq.on("error", (e) => {
      if (testResponseSent) return;
      testResponseSent = true;
      sender.send(200, {
        status: "error",
        error: e.message,
        code: e.code,
        message: "Cannot reach WEEX API - outbound HTTPS blocked?",
      });
    });

    testReq.on("timeout", () => {
      if (testResponseSent) return;
      testResponseSent = true;
      testReq.destroy();
      sender.send(200, {
        status: "error",
        message: "Timeout connecting to WEEX",
      });
    });

    testReq.end();
    return;
  }

  // Auth check (if token is configured)
  if (PROXY_TOKEN) {
    const authToken = req.headers["x-proxy-token"];
    if (authToken !== PROXY_TOKEN) {
      console.log(
        `[${timestamp}] DENIED ${req.method} ${req.url} from ${clientIP}`
      );
      sender.send(401, {
        error: "Unauthorized",
        message: "Invalid or missing X-Proxy-Token",
      });
      return;
    }
  }

  // Check content length header upfront
  const contentLength = parseInt(req.headers["content-length"] || "0", 10);
  if (contentLength > MAX_REQUEST_SIZE) {
    sender.send(413, {
      error: "Payload too large",
      message: `Request body exceeds ${MAX_REQUEST_SIZE} bytes`,
    });
    return;
  }

  // Build headers for WEEX - filter out hop-by-hop headers
  const forwardHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      forwardHeaders[key] = value;
    }
  }
  forwardHeaders["host"] = WEEX_HOST;

  console.log(`[${timestamp}] ${req.method} ${req.url} from ${clientIP}`);

  // For methods with body, buffer first then forward
  // For methods without body, forward immediately
  const hasBody = METHODS_WITH_BODY.has(req.method);

  if (hasBody) {
    // Buffer the request body with size limit
    const chunks = [];
    let bodySize = 0;
    let overflow = false;

    req.on("data", (chunk) => {
      if (overflow || sender.isSent()) return;

      bodySize += chunk.length;
      if (bodySize > MAX_REQUEST_SIZE) {
        overflow = true;
        req.destroy();
        sender.send(413, {
          error: "Payload too large",
          message: "Request body too large",
        });
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (overflow || sender.isSent()) return;

      const body = Buffer.concat(chunks);

      // Update content-length to actual body size
      forwardHeaders["content-length"] = body.length.toString();

      const options = {
        hostname: WEEX_HOST,
        port: 443,
        path: req.url,
        method: req.method,
        headers: forwardHeaders,
        // 90 second timeout - WEEX API can be slow, especially for:
        // - Order placement during high volatility
        // - Account queries with many positions
        // - Initial connection establishment
        // Adjust if experiencing frequent timeouts
        timeout: 90000,
      };

      const proxyReq = https.request(options, (proxyRes) => {
        if (sender.isSent()) return;

        const responseHeaders = {};
        for (const [key, value] of Object.entries(proxyRes.headers)) {
          if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
            responseHeaders[key] = value;
          }
        }
        responseHeaders["access-control-allow-origin"] = "*";

        sender.pipe(proxyRes.statusCode, responseHeaders, proxyRes);
      });

      proxyReq.on("error", (e) => {
        console.error(`[${timestamp}] ERROR: ${e.message}`);
        sender.send(502, { error: "Proxy error", message: e.message });
      });

      proxyReq.on("timeout", () => {
        proxyReq.destroy();
        sender.send(504, {
          error: "Gateway timeout",
          message: "Request to WEEX API timed out",
        });
      });

      // Handle client disconnect during buffered request
      req.on("close", () => {
        if (!sender.isSent()) {
          proxyReq.destroy();
          console.log(`[${timestamp}] Client disconnected during request`);
        }
      });

      // Write buffered body and end
      proxyReq.write(body);
      proxyReq.end();
    });

    req.on("error", (e) => {
      if (!sender.isSent()) {
        sender.send(400, { error: "Request error", message: e.message });
      }
    });
  } else {
    // GET/HEAD - no body, forward immediately
    const options = {
      hostname: WEEX_HOST,
      port: 443,
      path: req.url,
      method: req.method,
      headers: forwardHeaders,
      // 90 second timeout - WEEX API can be slow, especially for:
      // - Market data during high traffic
      // - Initial connection establishment
      // Adjust if experiencing frequent timeouts
      timeout: 90000,
    };

    const proxyReq = https.request(options, (proxyRes) => {
      if (sender.isSent()) return;

      const responseHeaders = {};
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
          responseHeaders[key] = value;
        }
      }
      responseHeaders["access-control-allow-origin"] = "*";

      sender.pipe(proxyRes.statusCode, responseHeaders, proxyRes);
    });

    proxyReq.on("error", (e) => {
      console.error(`[${timestamp}] ERROR: ${e.message}`);
      sender.send(502, { error: "Proxy error", message: e.message });
    });

    proxyReq.on("timeout", () => {
      proxyReq.destroy();
      sender.send(504, {
        error: "Gateway timeout",
        message: "Request to WEEX API timed out",
      });
    });

    // Handle client disconnect
    req.on("close", () => {
      if (!sender.isSent()) {
        proxyReq.destroy();
      }
    });

    proxyReq.end();
  }
});

// Handle server errors
server.on("error", (e) => {
  console.error(`Server error: ${e.message}`);
  if (e.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use`);
    process.exit(1);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║              WEEX API Proxy Server                         ║
╠════════════════════════════════════════════════════════════╣
║  Status:  RUNNING                                          ║
║  Port:    ${PORT.toString().padEnd(47)}║
║  Target:  https://${WEEX_HOST.padEnd(39)}║
║  Auth:    ${
    PROXY_TOKEN ? "ENABLED".padEnd(47) : "DISABLED (set PROXY_TOKEN)".padEnd(47)
  }║
╚════════════════════════════════════════════════════════════╝

Ready to proxy requests to WEEX API.
`);
});

// Graceful shutdown
let isShuttingDown = false;

function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n${signal} received, shutting down gracefully...`);

  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });

  // Force exit after 10 seconds
  setTimeout(() => {
    console.error("Forced shutdown after timeout");
    process.exit(1);
  }, 10000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Handle uncaught errors
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  shutdown("uncaughtException");
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});
