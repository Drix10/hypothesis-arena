/**
 * Hypothesis Arena - Strategic Investment Analysis Platform
 * Premium UI/UX with "Strategic Arena" theme
 */

import React, { useState, useEffect, lazy, Suspense } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { getApiKey, setApiKey } from "./services/apiKeyManager";

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
  const [inputKey, setInputKey] = useState("");
  const [isFocused, setIsFocused] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const savedKey = getApiKey();
    if (savedKey) {
      setApiKeyState(savedKey);
      setIsKeySet(true);
    }
  }, []);

  const handleSetKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (inputKey.trim()) {
      setIsLoading(true);
      // Small delay for visual feedback
      await new Promise((resolve) => setTimeout(resolve, 400));
      setApiKey(inputKey.trim());
      setApiKeyState(inputKey.trim());
      setIsKeySet(true);
      setIsLoading(false);
    }
  };

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
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-2.5 tracking-wider uppercase">
                  Gemini API Key
                </label>
                <div
                  className={`relative rounded-xl transition-all duration-200 ${
                    isFocused ? "ring-2 ring-cyan/40" : ""
                  }`}
                >
                  <input
                    type="password"
                    value={inputKey}
                    onChange={(e) => setInputKey(e.target.value)}
                    onFocus={() => setIsFocused(true)}
                    onBlur={() => setIsFocused(false)}
                    placeholder="Paste your API key here"
                    className="w-full px-4 py-3.5 bg-arena-deep border border-white/[0.08] rounded-xl text-white placeholder-slate-500 focus:outline-none transition-all"
                    autoComplete="off"
                  />
                  <div className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-500">
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

              <motion.button
                type="submit"
                disabled={!inputKey.trim() || isLoading}
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
                    Entering Arena...
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

            <div className="mt-6 pt-5 border-t border-white/[0.06]">
              <p className="text-sm text-slate-500 text-center">
                Get your free key from{" "}
                <a
                  href="https://aistudio.google.com/app/apikey"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-cyan hover:text-cyan-light transition-colors font-medium"
                >
                  Google AI Studio →
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
            <p className="text-slate-400 font-medium">Preparing the arena...</p>
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
          <StockArena apiKey={apiKey} />
        </motion.div>
      </AnimatePresence>
    </Suspense>
  );
};

export default App;
