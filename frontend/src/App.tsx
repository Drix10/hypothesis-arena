/**
 * Hypothesis Arena - AI-Powered Crypto Trading Platform
 *
 * All data comes from backend WEEX integration.
 */

import React, { Suspense } from "react";
import { motion } from "framer-motion";
import ErrorBoundary from "./components/common/ErrorBoundary";
import { LiveArena } from "./components/layout/LiveArena";

const LoadingScreen: React.FC = () => (
  <div className="min-h-screen flex items-center justify-center bg-arena-deep">
    <motion.div
      className="text-center"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
    >
      <div className="relative inline-block mb-6">
        <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-arena-card to-arena-surface border border-white/10 flex items-center justify-center">
          <span className="text-4xl animate-pulse">⚔️</span>
        </div>
      </div>
      <p className="text-slate-400 font-medium">Loading Hypothesis Arena...</p>
    </motion.div>
  </div>
);

const App: React.FC = () => {
  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingScreen />}>
        <LiveArena />
      </Suspense>
    </ErrorBoundary>
  );
};

export default App;
