/**
 * Engine Status Banner - Shows autonomous engine status
 *
 * Features:
 * - Animated pulse when running
 * - Countdown timer
 * - Cycle progress
 * - Quick stats
 */

import React from "react";
import { motion } from "framer-motion";
import { PulseIndicator } from "../ui/PulseIndicator";
import { AnimatedNumber } from "../ui/AnimatedNumber";

interface EngineStatusBannerProps {
  isRunning: boolean;
  currentCycle: number;
  nextCycleIn: number; // milliseconds
  totalTrades: number;
  avgCycleTime?: number;
  isLoading?: boolean;
  onStart: () => void;
  onStop: () => void;
}

export const EngineStatusBanner: React.FC<EngineStatusBannerProps> = ({
  isRunning,
  currentCycle,
  nextCycleIn,
  totalTrades,
  avgCycleTime = 300000, // 5 min default
  isLoading = false,
  onStart,
  onStop,
}) => {
  // Safe progress calculation - guard against division by zero and clamp between 0-100
  const safeNextCycleIn = Math.max(0, nextCycleIn);
  const safeAvgCycleTime = avgCycleTime > 0 ? avgCycleTime : 300000; // Default 5 min if invalid
  const minutes = Math.floor(safeNextCycleIn / 60000);
  const seconds = Math.floor((safeNextCycleIn % 60000) / 1000);
  const progress = Math.min(
    100,
    Math.max(0, ((safeAvgCycleTime - safeNextCycleIn) / safeAvgCycleTime) * 100)
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: -20 }}
      animate={{ opacity: 1, y: 0 }}
      className="px-6 py-4 border-b border-white/[0.06] glass-card rounded-none relative overflow-hidden"
    >
      {/* Animated background gradient */}
      {isRunning && (
        <motion.div
          className="absolute inset-0 bg-gradient-to-r from-cyan-500/5 via-transparent to-cyan-500/5"
          animate={{
            x: ["-100%", "100%"],
          }}
          transition={{
            duration: 3,
            repeat: Infinity,
            ease: "linear",
          }}
        />
      )}

      <div className="relative z-10 flex items-center justify-between flex-wrap gap-4">
        {/* Status Section */}
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-3">
            <PulseIndicator
              active={isRunning}
              color={isRunning ? "green" : "red"}
              size="md"
            />
            <div>
              <div className="text-lg font-bold flex items-center gap-2">
                {isRunning ? (
                  <>
                    <span
                      className="text-green-400"
                      role="img"
                      aria-label="Robot"
                    >
                      🤖
                    </span>
                    <span className="text-green-400">ENGINE RUNNING</span>
                    <motion.span
                      animate={{ scale: [1, 1.2, 1] }}
                      transition={{ duration: 2, repeat: Infinity }}
                      className="text-xs text-green-400/60"
                      aria-hidden="true"
                    >
                      ●
                    </motion.span>
                  </>
                ) : (
                  <>
                    <span role="img" aria-label="Paused">
                      ⏸️
                    </span>
                    <span className="text-red-400">ENGINE STOPPED</span>
                  </>
                )}
              </div>
              {isRunning && (
                <div className="text-xs text-slate-500 mt-1">
                  Autonomous trading active
                </div>
              )}
            </div>
          </div>

          {/* Stats */}
          {isRunning && (
            <>
              <div className="h-8 w-px bg-white/10" />

              <div className="text-sm">
                <div className="text-slate-500 text-xs">Cycle</div>
                <div className="font-mono font-bold text-cyan-400">
                  #{currentCycle}
                </div>
              </div>

              <div className="text-sm">
                <div className="text-slate-500 text-xs">Next in</div>
                <div className="font-mono font-bold text-yellow-400">
                  {minutes}m {seconds}s
                </div>
              </div>

              <div className="text-sm">
                <div className="text-slate-500 text-xs">Trades Today</div>
                <div className="font-mono font-bold text-white">
                  <AnimatedNumber value={totalTrades} />
                </div>
              </div>

              {/* Progress Bar */}
              <div className="hidden md:block w-32">
                <div className="text-slate-500 text-xs mb-1">Progress</div>
                <div className="h-2 bg-white/10 rounded-full overflow-hidden">
                  <motion.div
                    className="h-full bg-gradient-to-r from-cyan-400 to-blue-500"
                    initial={{ width: 0 }}
                    animate={{ width: `${progress}%` }}
                    transition={{ duration: 0.5 }}
                  />
                </div>
              </div>
            </>
          )}
        </div>

        {/* Control Button */}
        <div>
          {isRunning ? (
            <button
              onClick={onStop}
              disabled={isLoading}
              aria-busy={isLoading}
              className={`px-6 py-2.5 rounded-lg bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30 transition-all font-semibold text-sm flex items-center gap-2 group ${
                isLoading ? "opacity-50 cursor-not-allowed" : ""
              }`}
            >
              {isLoading ? (
                <span
                  className="w-4 h-4 border-2 border-red-400/30 border-t-red-400 rounded-full animate-spin"
                  role="status"
                  aria-label="Stopping engine"
                />
              ) : (
                <span
                  className="group-hover:scale-110 transition-transform"
                  role="img"
                  aria-label="Stop"
                >
                  ⏹️
                </span>
              )}
              {isLoading ? "Stopping..." : "Stop Engine"}
            </button>
          ) : (
            <button
              onClick={onStart}
              disabled={isLoading}
              aria-busy={isLoading}
              className={`px-6 py-2.5 rounded-lg bg-green-500/20 text-green-400 border border-green-500/30 hover:bg-green-500/30 transition-all font-semibold text-sm flex items-center gap-2 group ${
                isLoading ? "opacity-50 cursor-not-allowed" : ""
              }`}
            >
              {isLoading ? (
                <span
                  className="w-4 h-4 border-2 border-green-400/30 border-t-green-400 rounded-full animate-spin"
                  role="status"
                  aria-label="Starting engine"
                />
              ) : (
                <span
                  className="group-hover:scale-110 transition-transform"
                  role="img"
                  aria-label="Play"
                >
                  ▶️
                </span>
              )}
              {isLoading ? "Starting..." : "Start Engine"}
            </button>
          )}
        </div>
      </div>
    </motion.div>
  );
};
