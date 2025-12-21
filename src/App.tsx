/**
 * Hypothesis Arena - Strategic Investment Analysis Platform
 * Premium UI/UX with "Strategic Arena" theme
 */

import React, { useState, useEffect, lazy, Suspense } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  getApiKey,
  setApiKey,
  getFmpApiKey,
  setFmpApiKey,
  testApiKey,
  loadSavedKeys,
  isPersistenceEnabled,
  setPersistenceEnabled,
} from "./services/apiKeyManager";
import ErrorBoundary from "./components/common/ErrorBoundary";
import { ApiKeySettings } from "./components/common/ApiKeySettings";

const StockArena = lazy(() => import("./components/layout/StockArena"));

// Animation variants
const fadeInUp = {
  hidden: { opacity: 0, y: 30 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.6, ease: [0.16, 1, 0.3, 1] as const },
  },
};

const staggerContainer = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.1, delayChildren: 0.2 },
  },
};

const scaleIn = {
  hidden: { opacity: 0, scale: 0.9 },
  visible: {
    opacity: 1,
    scale: 1,
    transition: { duration: 0.5, ease: [0.16, 1, 0.3, 1] as const },
  },
};

const App: React.FC = () => {
  const [apiKey, setApiKeyState] = useState<string>("");
  const [isKeySet, setIsKeySet] = useState(false);
  const [inputGeminiKey, setInputGeminiKey] = useState("");
  const [inputFmpKey, setInputFmpKey] = useState("");
  const [isFocusedGemini, setIsFocusedGemini] = useState(false);
  const [isFocusedFmp, setIsFocusedFmp] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isInitializing, setIsInitializing] = useState(true);
  const [showGeminiKey, setShowGeminiKey] = useState(false);
  const [showFmpKey, setShowFmpKey] = useState(false);
  const [error, setError] = useState<string>("");
  const [rememberKeys, setRememberKeys] = useState(isPersistenceEnabled());
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    // Try to load saved keys on startup
    const { geminiKey, fmpKey } = loadSavedKeys();

    if (geminiKey) {
      setApiKeyState(geminiKey);
      setIsKeySet(true);
    }

    // Pre-fill FMP key from saved keys first
    if (fmpKey) {
      setInputFmpKey(fmpKey);
    }

    // Also check env variables as fallback
    const envGeminiKey = getApiKey();
    const envFmpKey = getFmpApiKey();

    if (envGeminiKey && !geminiKey) {
      setApiKeyState(envGeminiKey);
      setIsKeySet(true);
    }

    // Pre-fill FMP key from env if not already set from saved keys
    if (envFmpKey && !fmpKey) {
      setInputFmpKey(envFmpKey);
    }

    setIsInitializing(false);
  }, []);

  const handleSetKey = async (e: React.FormEvent) => {
    e.preventDefault();

    // Silently prevent duplicate submissions
    if (isLoading || !inputGeminiKey.trim()) return;

    setIsLoading(true);
    setError("");

    try {
      // Verify Gemini API key before proceeding
      await testApiKey(inputGeminiKey.trim());

      // Set persistence based on user preference
      setPersistenceEnabled(rememberKeys);

      // Set Gemini key (required)
      setApiKey(inputGeminiKey.trim());
      setApiKeyState(inputGeminiKey.trim());

      // Set FMP key only if provided (otherwise uses "demo")
      if (inputFmpKey.trim()) {
        setFmpApiKey(inputFmpKey.trim());
      }

      setIsKeySet(true);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Invalid API key";
      setError(errorMsg);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeysCleared = () => {
    setIsKeySet(false);
    setApiKeyState("");
    setInputGeminiKey("");
    setInputFmpKey("");
    setShowSettings(false);
  };

  // Show loading while checking for saved keys
  if (isInitializing) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <motion.div
          className="text-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
        >
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-arena-card to-arena-surface border border-white/10 flex items-center justify-center mx-auto mb-4">
            <span className="text-3xl animate-pulse">⚔️</span>
          </div>
          <p className="text-slate-500 text-sm">Loading...</p>
        </motion.div>
      </div>
    );
  }

  if (!isKeySet) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6 relative overflow-hidden">
        {/* Refined ambient glow effects */}
        <div className="absolute top-[-20%] left-[10%] w-[500px] h-[500px] bg-cyan/[0.04] rounded-full blur-[100px] pointer-events-none" />
        <div className="absolute bottom-[-10%] right-[10%] w-[400px] h-[400px] bg-gold/[0.03] rounded-full blur-[80px] pointer-events-none" />

        <motion.div
          className="relative z-10 max-w-md w-full"
          initial="hidden"
          animate="visible"
          variants={staggerContainer}
        >
          {/* Logo & Branding */}
          <motion.div className="text-center mb-10" variants={fadeInUp}>
            <motion.div
              className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-gradient-to-br from-arena-elevated to-arena-card border border-white/[0.08] mb-6"
              style={{ boxShadow: "0 0 40px rgba(6, 182, 212, 0.15)" }}
              whileHover={{ scale: 1.05, rotate: 3 }}
              transition={{ type: "spring", stiffness: 400 }}
            >
              <span className="text-4xl">⚔️</span>
            </motion.div>
            <h1 className="font-serif text-4xl md:text-5xl font-bold text-white mb-3 tracking-tight">
              Hypothesis Arena
            </h1>
            <p className="text-base text-slate-400 max-w-sm mx-auto leading-relaxed">
              8 AI analysts debate to forge your investment thesis
            </p>
          </motion.div>

          {/* API Key Card */}
          <motion.div
            className="glass-card rounded-2xl p-6 sm:p-8"
            variants={scaleIn}
          >
            <form onSubmit={handleSetKey} className="space-y-5">
              {/* Gemini API Key (Required) */}
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-2.5 tracking-wider uppercase">
                  Gemini API Key <span className="text-bear-light">*</span>
                </label>
                <div
                  className={`relative rounded-xl transition-all duration-200 ${
                    isFocusedGemini ? "ring-2 ring-cyan/40" : ""
                  }`}
                >
                  <input
                    type={showGeminiKey ? "text" : "password"}
                    value={inputGeminiKey}
                    onChange={(e) => setInputGeminiKey(e.target.value)}
                    onFocus={() => setIsFocusedGemini(true)}
                    onBlur={() => setIsFocusedGemini(false)}
                    placeholder="Paste your Gemini API key"
                    className="w-full px-4 py-3.5 pr-20 bg-arena-deep border border-white/[0.08] rounded-xl text-white placeholder-slate-500 focus:outline-none transition-all"
                    autoComplete="off"
                    required
                  />
                  <div className="absolute right-3.5 top-1/2 -translate-y-1/2 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setShowGeminiKey(!showGeminiKey)}
                      className="text-slate-500 hover:text-slate-300 transition-colors"
                      tabIndex={-1}
                    >
                      {showGeminiKey ? (
                        <svg
                          className="w-5 h-5"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={1.5}
                            d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"
                          />
                        </svg>
                      ) : (
                        <svg
                          className="w-5 h-5"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={1.5}
                            d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                          />
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={1.5}
                            d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                          />
                        </svg>
                      )}
                    </button>
                    <svg
                      className="w-5 h-5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.5}
                        d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"
                      />
                    </svg>
                  </div>
                </div>
              </div>

              {/* FMP API Key (Optional - uses demo if not provided) */}
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-2.5 tracking-wider uppercase">
                  FMP API Key{" "}
                  <span className="text-slate-500 text-[10px] font-normal">
                    (Optional)
                  </span>
                </label>
                <div
                  className={`relative rounded-xl transition-all duration-200 ${
                    isFocusedFmp ? "ring-2 ring-gold/40" : ""
                  }`}
                >
                  <input
                    type={showFmpKey ? "text" : "password"}
                    value={inputFmpKey}
                    onChange={(e) => setInputFmpKey(e.target.value)}
                    onFocus={() => setIsFocusedFmp(true)}
                    onBlur={() => setIsFocusedFmp(false)}
                    placeholder="Optional - uses demo key if empty"
                    className="w-full px-4 py-3.5 pr-20 bg-arena-deep border border-white/[0.08] rounded-xl text-white placeholder-slate-500 focus:outline-none transition-all"
                    autoComplete="off"
                  />
                  <div className="absolute right-3.5 top-1/2 -translate-y-1/2 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setShowFmpKey(!showFmpKey)}
                      className="text-slate-500 hover:text-slate-300 transition-colors"
                      tabIndex={-1}
                    >
                      {showFmpKey ? (
                        <svg
                          className="w-5 h-5"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={1.5}
                            d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"
                          />
                        </svg>
                      ) : (
                        <svg
                          className="w-5 h-5"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={1.5}
                            d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                          />
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={1.5}
                            d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                          />
                        </svg>
                      )}
                    </button>
                    <svg
                      className="w-5 h-5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.5}
                        d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                      />
                    </svg>
                  </div>
                </div>
              </div>

              {/* Error Message */}
              {error && (
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="p-3 rounded-lg bg-bear-light/10 border border-bear-light/20"
                >
                  <div className="flex items-start gap-2">
                    <svg
                      className="w-5 h-5 text-bear-light flex-shrink-0 mt-0.5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                      />
                    </svg>
                    <p className="text-sm text-bear-light">{error}</p>
                  </div>
                </motion.div>
              )}

              {/* Remember Keys Checkbox */}
              <label className="flex items-center gap-3 cursor-pointer group">
                <div className="relative">
                  <input
                    type="checkbox"
                    checked={rememberKeys}
                    onChange={(e) => setRememberKeys(e.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="w-5 h-5 rounded-md border border-white/20 bg-arena-deep peer-checked:bg-cyan/20 peer-checked:border-cyan/50 transition-all flex items-center justify-center">
                    {rememberKeys && (
                      <svg
                        className="w-3 h-3 text-cyan"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={3}
                          d="M5 13l4 4L19 7"
                        />
                      </svg>
                    )}
                  </div>
                </div>
                <span className="text-sm text-slate-400 group-hover:text-slate-300 transition-colors">
                  Remember my keys for next time
                </span>
              </label>

              <motion.button
                type="submit"
                disabled={!inputGeminiKey.trim() || isLoading}
                className="w-full py-3.5 px-6 rounded-xl font-semibold btn-primary disabled:opacity-30 disabled:cursor-not-allowed"
                whileTap={{ scale: 0.98 }}
              >
                {isLoading ? (
                  <span className="flex items-center justify-center gap-2.5">
                    <svg
                      className="w-5 h-5 animate-spin"
                      viewBox="0 0 24 24"
                      fill="none"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      />
                    </svg>
                    Verifying API key...
                  </span>
                ) : (
                  <span className="flex items-center justify-center gap-2">
                    Enter the Arena
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M13 7l5 5m0 0l-5 5m5-5H6"
                      />
                    </svg>
                  </span>
                )}
              </motion.button>
            </form>

            <div className="mt-6 pt-5 border-t border-white/[0.06] space-y-2">
              <p className="text-sm text-slate-500 text-center">
                Get your free Gemini key from{" "}
                <a
                  href="https://aistudio.google.com/app/apikey"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-cyan hover:text-cyan-light transition-colors font-medium"
                >
                  Google AI Studio →
                </a>
              </p>
              <p className="text-xs text-slate-600 text-center">
                FMP key optional - get yours at{" "}
                <a
                  href="https://financialmodelingprep.com/developer/docs"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-gold hover:text-gold-light transition-colors font-medium"
                >
                  Financial Modeling Prep →
                </a>
              </p>
            </div>
          </motion.div>

          {/* Feature Pills */}
          <motion.div
            className="mt-8 flex flex-wrap justify-center gap-2"
            variants={staggerContainer}
          >
            {[
              { icon: "🤖", label: "8 AI Analysts" },
              { icon: "⚔️", label: "Live Debates" },
              { icon: "📊", label: "Real-Time Data" },
            ].map((feature) => (
              <motion.div
                key={feature.label}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/[0.03] border border-white/[0.06] text-xs text-slate-400"
                variants={fadeInUp}
                whileHover={{
                  scale: 1.03,
                  backgroundColor: "rgba(255,255,255,0.05)",
                }}
              >
                <span>{feature.icon}</span>
                <span>{feature.label}</span>
              </motion.div>
            ))}
          </motion.div>

          {/* Trust indicators */}
          <motion.div className="mt-10 text-center" variants={fadeInUp}>
            <p className="text-[10px] text-slate-600 mb-2 tracking-wider uppercase">
              Powered by
            </p>
            <div className="flex items-center justify-center gap-4 text-slate-500">
              <span className="text-xs font-medium">Gemini 2.0</span>
              <span className="w-1 h-1 bg-slate-700 rounded-full" />
              <span className="text-xs font-medium">Yahoo Finance</span>
              <span className="w-1 h-1 bg-slate-700 rounded-full" />
              <span className="text-xs font-medium">FMP</span>
            </div>
          </motion.div>
        </motion.div>
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <Suspense
        fallback={
          <div className="min-h-screen flex items-center justify-center">
            <motion.div
              className="text-center"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
            >
              <div className="relative inline-block mb-6">
                <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-arena-card to-arena-surface border border-white/10 flex items-center justify-center shadow-glow-cyan">
                  <span className="text-4xl animate-pulse">⚔️</span>
                </div>
                <div className="absolute -inset-4 border border-cyan/20 rounded-3xl animate-ping opacity-30" />
              </div>
              <p className="text-slate-400 font-medium">
                Preparing the arena...
              </p>
            </motion.div>
          </div>
        }
      >
        <AnimatePresence mode="wait">
          <motion.div
            key="arena"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
          >
            <StockArena
              apiKey={apiKey}
              onShowSettings={() => setShowSettings(true)}
            />
          </motion.div>
        </AnimatePresence>
      </Suspense>

      {/* API Key Settings Modal */}
      <ApiKeySettings
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        onKeysCleared={handleKeysCleared}
      />
    </ErrorBoundary>
  );
};

export default App;
