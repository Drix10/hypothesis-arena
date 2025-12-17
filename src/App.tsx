/**
 * Hypothesis Arena - Stock Investment Analysis
 * Premium dark theme with professional UI/UX
 */

import React, { useState, useEffect, lazy, Suspense } from "react";
import { getApiKey, setApiKey } from "./services/apiKeyManager";

const StockArena = lazy(() => import("./components/stock/StockArena"));

const App: React.FC = () => {
  const [apiKey, setApiKeyState] = useState<string>("");
  const [isKeySet, setIsKeySet] = useState(false);
  const [inputKey, setInputKey] = useState("");
  const [isFocused, setIsFocused] = useState(false);

  useEffect(() => {
    const savedKey = getApiKey();
    if (savedKey) {
      setApiKeyState(savedKey);
      setIsKeySet(true);
    }
  }, []);

  const handleSetKey = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputKey.trim()) {
      setApiKey(inputKey.trim());
      setApiKeyState(inputKey.trim());
      setIsKeySet(true);
    }
  };

  if (!isKeySet) {
    return (
      <div className="min-h-screen bg-void flex flex-col items-center justify-center p-6 relative">
        <div className="absolute inset-0 bg-grid opacity-40" />

        {/* Gradient orbs */}
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-electric-cyan/10 rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-acid-purple/10 rounded-full blur-3xl" />

        <div className="relative z-10 max-w-md w-full">
          {/* Logo */}
          <div className="text-center mb-12">
            <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-gradient-to-br from-electric-cyan/20 to-acid-purple/20 border border-white/10 mb-6">
              <span className="text-4xl">⚔️</span>
            </div>
            <h1 className="font-serif text-4xl font-bold text-white mb-3 tracking-tight">
              Hypothesis Arena
            </h1>
            <p className="text-slate-400 text-lg">
              Where AI analysts battle for the best investment thesis
            </p>
          </div>

          {/* Card */}
          <div className="bg-surface/80 backdrop-blur-xl rounded-2xl border border-white/5 p-8">
            <form onSubmit={handleSetKey} className="space-y-6">
              <div>
                <label className="block text-sm font-medium text-slate-400 mb-2">
                  Gemini API Key
                </label>
                <div
                  className={`relative rounded-xl transition-all duration-300 ${
                    isFocused ? "ring-2 ring-electric-cyan/50" : ""
                  }`}
                >
                  <input
                    type="password"
                    value={inputKey}
                    onChange={(e) => setInputKey(e.target.value)}
                    onFocus={() => setIsFocused(true)}
                    onBlur={() => setIsFocused(false)}
                    placeholder="Enter your API key"
                    className="w-full px-4 py-4 bg-void/50 border border-white/10 rounded-xl text-white placeholder-slate-600 focus:outline-none transition-colors"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={!inputKey.trim()}
                className="w-full py-4 px-6 rounded-xl font-semibold text-void bg-gradient-to-r from-electric-cyan to-cyan-400 hover:from-cyan-400 hover:to-electric-cyan disabled:opacity-30 disabled:cursor-not-allowed transition-all duration-300 transform hover:scale-[1.02] active:scale-[0.98]"
              >
                Enter the Arena
              </button>
            </form>

            <div className="mt-6 pt-6 border-t border-white/5">
              <p className="text-sm text-slate-500 text-center">
                Get your free API key from{" "}
                <a
                  href="https://aistudio.google.com/app/apikey"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-electric-cyan hover:text-cyan-300 transition-colors"
                >
                  Google AI Studio →
                </a>
              </p>
            </div>
          </div>

          {/* Features */}
          <div className="mt-8 grid grid-cols-3 gap-4">
            {[
              { icon: "🤖", label: "8 AI Analysts" },
              { icon: "⚔️", label: "Live Debates" },
              { icon: "📊", label: "Real Data" },
            ].map((f) => (
              <div
                key={f.label}
                className="text-center p-4 rounded-xl bg-white/[0.02] border border-white/5"
              >
                <div className="text-2xl mb-2">{f.icon}</div>
                <div className="text-xs text-slate-500">{f.label}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-void flex items-center justify-center">
          <div className="text-center">
            <div className="w-16 h-16 border-2 border-electric-cyan/30 border-t-electric-cyan rounded-full animate-spin mx-auto mb-4" />
            <p className="text-slate-500">Loading arena...</p>
          </div>
        </div>
      }
    >
      <StockArena apiKey={apiKey} />
    </Suspense>
  );
};

export default App;
