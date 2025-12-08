import React from "react";
import Icon from "./Icon";
import { TournamentData } from "../types";
import { logger } from "../services/utils/logger";

interface Props {
  data: TournamentData;
  onBack: () => void;
}

const WinningBriefView: React.FC<Props> = ({ data, onBack }) => {
  const { winningBrief } = data;

  return (
    <div className="min-h-screen bg-void text-slate-200 font-sans">
      {/* Sticky Nav */}
      <nav className="border-b border-white/5 sticky top-0 bg-void/90 backdrop-blur-md z-50">
        <div className="max-w-5xl mx-auto px-6 h-16 flex items-center justify-between">
          <button
            onClick={onBack}
            className="flex items-center gap-2 text-xs font-mono uppercase tracking-widest text-slate-500 hover:text-white transition-colors"
          >
            <Icon icon="solar:arrow-left-broken"></Icon> Return to Bracket
          </button>
          <div className="flex gap-4">
            <button
              onClick={() => {
                // Share functionality
                const shareData = {
                  title: winningBrief?.title || "Research Brief",
                  text:
                    winningBrief?.oneSentenceTweet ||
                    "Check out this research brief from Hypothesis Arena",
                  url: window.location.href,
                };

                if (navigator.share) {
                  navigator.share(shareData).catch((err) => {
                    if (err.name !== "AbortError") {
                      logger.error("Share failed:", err);
                    }
                  });
                } else {
                  // Fallback: copy to clipboard
                  navigator.clipboard
                    .writeText(window.location.href)
                    .then(() => {
                      alert("Link copied to clipboard!");
                    })
                    .catch((err) => {
                      logger.error("Copy failed:", err);
                    });
                }
              }}
              className="p-2 hover:bg-white/5 rounded-full text-slate-400 hover:text-white transition-colors"
              title="Share"
            >
              <Icon icon="solar:share-bold-duotone" width="20"></Icon>
            </button>
            <button
              onClick={() => {
                // Download as JSON
                const exportData = {
                  tournament: data,
                  exportDate: new Date().toISOString(),
                  version: "1.0",
                };

                const blob = new Blob([JSON.stringify(exportData, null, 2)], {
                  type: "application/json",
                });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `hypothesis-arena-${
                  data.tournamentId
                }-${Date.now()}.json`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);

                logger.info("Tournament data downloaded");
              }}
              className="p-2 hover:bg-white/5 rounded-full text-slate-400 hover:text-white transition-colors"
              title="Download Tournament Data"
            >
              <Icon
                icon="solar:download-minimalistic-bold-duotone"
                width="20"
              ></Icon>
            </button>
          </div>
        </div>
      </nav>

      <main className="max-w-5xl mx-auto px-6 py-16 space-y-16">
        {/* Header Block */}
        <header className="space-y-8 text-center md:text-left">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/5 border border-white/10 text-emerald-400 text-[10px] font-mono uppercase tracking-widest">
            <Icon icon="solar:verified-check-bold"></Icon> Peer Reviewed
          </div>
          <h1 className="text-4xl md:text-6xl font-serif font-medium text-white leading-[1.1]">
            {winningBrief?.title || "Research Brief"}
          </h1>
          <div className="bg-surface border border-white/5 rounded-xl p-6 md:p-8 relative overflow-hidden">
            <div className="absolute top-0 left-0 w-1 h-full bg-electric-cyan"></div>
            <p className="text-xl md:text-2xl text-slate-300 font-serif italic">
              "{winningBrief?.oneSentenceTweet || "Hypothesis Synthesis"}"
            </p>
          </div>
        </header>

        {/* Content Grid */}
        <div className="grid lg:grid-cols-3 gap-12">
          {/* Main Column */}
          <div className="lg:col-span-2 space-y-12">
            <section>
              <h2 className="text-2xl font-serif text-white mb-6">Abstract</h2>
              <div className="prose prose-invert prose-lg max-w-none font-sans font-light text-slate-300 leading-relaxed">
                {winningBrief?.abstract?.split("\n").map((paragraph, i) => (
                  <p key={i} className="mb-4">
                    {paragraph}
                  </p>
                ))}
              </div>
            </section>

            <section>
              <h2 className="text-2xl font-serif text-white mb-6">
                Predicted Impact
              </h2>
              <div className="p-6 bg-surface/50 border border-white/5 rounded-2xl">
                <div className="prose prose-invert prose-sm font-sans text-slate-300">
                  {winningBrief?.predictedImpact
                    ?.split("\n")
                    .map((paragraph, i) => (
                      <p key={i} className="mb-2">
                        {paragraph}
                      </p>
                    ))}
                </div>
              </div>
            </section>
          </div>

          {/* Sidebar */}
          <div className="space-y-8">
            <div className="sticky top-24">
              <div className="p-6 bg-surface border border-white/5 rounded-2xl space-y-6">
                <h3 className="text-xs font-mono uppercase tracking-widest text-slate-500">
                  Execution Plan
                </h3>
                <div className="space-y-4">
                  <div className="flex gap-4">
                    <div className="flex flex-col items-center">
                      <div className="w-2 h-2 rounded-full bg-electric-cyan"></div>
                      <div className="w-px h-full bg-white/10 my-1"></div>
                    </div>
                    <div>
                      <h4 className="text-sm font-bold text-white">
                        Timeline & Cost
                      </h4>
                      <div className="text-xs text-slate-400 mt-1">
                        {winningBrief?.costAndTimeline
                          ?.split("\n")
                          .map((line, i) => (
                            <p key={i} className="mb-1">
                              {line}
                            </p>
                          ))}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="pt-6 border-t border-white/5">
                  <button
                    onClick={() => {
                      // Export as PDF using browser print
                      window.print();
                    }}
                    className="w-full py-3 bg-white text-black font-bold text-sm rounded-lg hover:bg-slate-200 transition-colors flex items-center justify-center gap-2"
                  >
                    <Icon icon="solar:file-download-bold"></Icon> Export PDF
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};

export default WinningBriefView;
