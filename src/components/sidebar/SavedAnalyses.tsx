/**
 * Saved Analyses Component - Cinematic Command Center
 * Bold asymmetric design with dramatic lighting effects
 */

import React, { useState, useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  SavedAnalysis,
  getSavedAnalyses,
  deleteSavedAnalysis,
  downloadAnalysisJSON,
} from "../../services/storageService";

interface SavedAnalysesProps {
  onLoadAnalysis: (analysis: SavedAnalysis) => void;
}

export const SavedAnalyses: React.FC<SavedAnalysesProps> = ({
  onLoadAnalysis,
}) => {
  const [analyses, setAnalyses] = useState<SavedAnalysis[]>([]);
  const [isExpanded, setIsExpanded] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    setAnalyses(getSavedAnalyses());
  }, []);

  const handleDeleteClick = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDeleteId(id);
  };
  const handleConfirmDelete = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (deleteSavedAnalysis(id)) setAnalyses(getSavedAnalyses());
    setConfirmDeleteId(null);
  };
  const handleCancelDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDeleteId(null);
  };
  const handleDownload = (analysis: SavedAnalysis, e: React.MouseEvent) => {
    e.stopPropagation();
    downloadAnalysisJSON(analysis);
  };

  const formatDate = (timestamp: number): string =>
    new Date(timestamp).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

  const getRecConfig = (rec: string) => {
    const configs: Record<
      string,
      { bg: string; border: string; color: string }
    > = {
      strong_buy: {
        bg: "rgba(0,255,136,0.12)",
        border: "rgba(0,255,136,0.3)",
        color: "#00ff88",
      },
      buy: {
        bg: "rgba(34,197,94,0.12)",
        border: "rgba(34,197,94,0.3)",
        color: "#22c55e",
      },
      hold: {
        bg: "rgba(255,215,0,0.12)",
        border: "rgba(255,215,0,0.3)",
        color: "#ffd700",
      },
      sell: {
        bg: "rgba(239,68,68,0.12)",
        border: "rgba(239,68,68,0.3)",
        color: "#ef4444",
      },
      strong_sell: {
        bg: "rgba(220,38,38,0.12)",
        border: "rgba(220,38,38,0.3)",
        color: "#dc2626",
      },
    };
    return configs[rec] || configs.hold;
  };

  if (analyses.length === 0) return null;

  return (
    <div
      className="relative overflow-hidden rounded-xl"
      style={{
        background: "linear-gradient(165deg, #0d1117 0%, #080b0f 100%)",
        border: "1px solid rgba(255,255,255,0.06)",
        boxShadow:
          "0 8px 32px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.03)",
      }}
    >
      {/* Diagonal accent */}
      <div
        className="absolute top-0 right-0 w-20 h-20 opacity-20"
        style={{
          background: "linear-gradient(135deg, #00f0ff 0%, transparent 60%)",
          clipPath: "polygon(100% 0, 0 0, 100% 100%)",
        }}
      />
      {/* Scanlines */}
      <div
        className="absolute inset-0 opacity-[0.03] pointer-events-none"
        style={{
          backgroundImage:
            "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,255,255,0.03) 2px, rgba(255,255,255,0.03) 4px)",
        }}
      />

      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-4 py-3.5 flex items-center justify-between transition-colors relative z-10 hover:bg-white/[0.02] active:scale-[0.99]"
        aria-expanded={isExpanded}
      >
        <div className="flex items-center gap-3">
          <div
            className="w-9 h-9 rounded-lg flex items-center justify-center text-lg"
            style={{
              background:
                "linear-gradient(145deg, rgba(0,240,255,0.15) 0%, rgba(0,240,255,0.05) 100%)",
              border: "1px solid rgba(0,240,255,0.3)",
            }}
          >
            💾
          </div>
          <h3
            className="text-sm font-black text-white"
            style={{ fontFamily: "'Space Grotesk', sans-serif" }}
          >
            Saved Analyses
          </h3>
          <span
            className="text-[10px] font-bold px-2 py-0.5 rounded-md"
            style={{
              background: "rgba(0,240,255,0.1)",
              color: "#00f0ff",
              border: "1px solid rgba(0,240,255,0.2)",
            }}
          >
            {analyses.length}
          </span>
        </div>
        <span
          className="text-slate-500 text-xs transition-transform duration-200"
          style={{ transform: isExpanded ? "rotate(180deg)" : "rotate(0deg)" }}
        >
          ▼
        </span>
      </button>

      <AnimatePresence>
        {isExpanded && (
          <motion.div
            className="border-t border-white/[0.06] max-h-72 overflow-y-auto scrollbar-thin relative z-10"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            {analyses.map((analysis) => {
              const recConfig = getRecConfig(
                analysis.recommendation.recommendation
              );
              return (
                <div
                  key={analysis.id}
                  className="px-4 py-3 cursor-pointer relative overflow-hidden group hover:translate-x-1 hover:bg-white/[0.02]"
                  style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}
                  onClick={() => onLoadAnalysis(analysis)}
                >
                  {/* Hover glow */}
                  <div
                    className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity"
                    style={{
                      background:
                        "linear-gradient(90deg, rgba(0,240,255,0.03) 0%, transparent 60%)",
                    }}
                  />

                  <div className="flex items-center justify-between relative z-10">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-white font-bold text-sm">
                          {analysis.ticker}
                        </span>
                        <span
                          className="px-1.5 py-0.5 text-[9px] rounded font-black uppercase tracking-wider"
                          style={{
                            background: recConfig.bg,
                            border: `1px solid ${recConfig.border}`,
                            color: recConfig.color,
                          }}
                        >
                          {analysis.recommendation.recommendation.replaceAll(
                            "_",
                            " "
                          )}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[10px] text-slate-500 truncate max-w-[120px]">
                          {analysis.companyName}
                        </span>
                        <span className="text-[10px] text-slate-600">•</span>
                        <span className="text-[10px] text-slate-600 font-mono">
                          {formatDate(analysis.savedAt)}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 mt-1.5 text-[10px] text-slate-500 font-mono">
                        <span>
                          Price: $
                          {analysis.recommendation.currentPrice.toFixed(2)}
                        </span>
                        <span>
                          Target: $
                          {analysis.recommendation.priceTarget.base.toFixed(2)}
                        </span>
                        <span
                          style={{
                            color:
                              analysis.recommendation.upside >= 0
                                ? "#00ff88"
                                : "#ef4444",
                          }}
                        >
                          {analysis.recommendation.upside >= 0 ? "+" : ""}
                          {analysis.recommendation.upside.toFixed(1)}%
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      {confirmDeleteId === analysis.id ? (
                        <div className="flex items-center gap-1">
                          <span className="text-[10px] text-slate-400 mr-1">
                            Delete?
                          </span>
                          <button
                            onClick={(e) => handleConfirmDelete(analysis.id, e)}
                            className="px-1.5 py-0.5 text-[10px] rounded font-bold active:scale-95"
                            style={{
                              background: "rgba(239,68,68,0.2)",
                              color: "#ef4444",
                              border: "1px solid rgba(239,68,68,0.3)",
                            }}
                          >
                            Yes
                          </button>
                          <button
                            onClick={handleCancelDelete}
                            className="px-1.5 py-0.5 text-[10px] text-slate-400 hover:text-white active:scale-95"
                          >
                            No
                          </button>
                        </div>
                      ) : (
                        <>
                          <button
                            onClick={(e) => handleDownload(analysis, e)}
                            className="p-1.5 text-slate-500 hover:text-cyan transition-colors text-xs active:scale-90"
                          >
                            📥
                          </button>
                          <button
                            onClick={(e) => handleDeleteClick(analysis.id, e)}
                            className="p-1.5 text-slate-500 hover:text-red-400 transition-colors text-xs active:scale-90"
                          >
                            🗑️
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default SavedAnalyses;
