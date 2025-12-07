import React, { useState, useEffect, useRef } from "react";
import Icon from "./Icon";
import { TournamentData } from "../types";
import { generateWinningVideo } from "../services/videoService";
import { logger } from "../services/utils/logger";

interface Props {
  data: TournamentData;
  onBack: () => void;
}

const WinningBriefView: React.FC<Props> = ({ data, onBack }) => {
  const { winningBrief } = data;
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [isVideoLoading, setIsVideoLoading] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [videoProgress, setVideoProgress] = useState<number>(0);
  const isMounted = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;

      // Abort any ongoing video generation
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      // Cleanup video URL if it's a blob URL (future-proofing)
      if (videoUrl && videoUrl.startsWith("blob:")) {
        URL.revokeObjectURL(videoUrl);
      }
    };
  }, [videoUrl]);

  const handleGenerateVideo = async () => {
    // Prevent concurrent video generation requests
    if (isVideoLoading) {
      logger.warn("Video generation already in progress");
      return;
    }

    setIsVideoLoading(true);
    setVideoError(null);
    setVideoProgress(0);

    // Create abort controller for this generation
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      if (!winningBrief?.veoVideoPrompt) {
        throw new Error("Missing video prompt in brief data.");
      }
      const url = await generateWinningVideo(
        winningBrief.veoVideoPrompt,
        (_attempt, _max, percentage) => {
          // Only update if not aborted and still mounted
          if (!controller.signal.aborted && isMounted.current) {
            setVideoProgress(percentage);
          }
        }
      );

      if (isMounted.current) {
        // Test if video URL is accessible (with timeout)
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout

          const testResponse = await fetch(url, {
            method: "HEAD",
            signal: controller.signal,
          });
          clearTimeout(timeoutId);

          if (!testResponse.ok) {
            logger.warn(
              `Video URL returned ${testResponse.status}, may need authentication`
            );
          }
        } catch (fetchError: any) {
          if (fetchError.name === "AbortError") {
            logger.warn("Video URL test timed out after 5s");
          } else {
            logger.warn(
              "Video URL test failed, but setting anyway:",
              fetchError
            );
          }
        }

        setVideoUrl(url);
        logger.info("Video URL set:", url);
      }
    } catch (e: any) {
      // Don't show error if operation was aborted
      if (
        e.name === "AbortError" ||
        abortControllerRef.current?.signal.aborted
      ) {
        logger.info("Video generation cancelled");
        return;
      }

      if (isMounted.current) {
        logger.error("Video Generation Error:", e);
        if (e.message === "API_KEY_INVALID") {
          setVideoError(
            "API Key session expired or invalid. Please re-select your key."
          );
        } else if (e.message?.includes("quota")) {
          setVideoError(
            "Usage quota exceeded. Please use a project with billing enabled or check quotas."
          );
        } else {
          setVideoError(
            e.message || "Failed to generate video. Please try again."
          );
        }
      }
    } finally {
      if (isMounted.current) {
        setIsVideoLoading(false);
      }
      abortControllerRef.current = null;
    }
  };

  const handleSelectKey = async () => {
    if ((window as any).aistudio) {
      try {
        await (window as any).aistudio.openSelectKey();
        // Reset error state to allow user to try again immediately after selection
        setVideoError(null);
      } catch (err) {
        logger.error("Failed to trigger key selection:", err);
      }
    }
  };

  // Check for API key related errors (case insensitive to catch "API_KEY" and "API Key")
  const isApiKeyError = videoError && /api[-_ ]?key/i.test(videoError);

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
            <button className="p-2 hover:bg-white/5 rounded-full text-slate-400 hover:text-white transition-colors">
              <Icon icon="solar:share-bold-duotone" width="20"></Icon>
            </button>
            <button className="p-2 hover:bg-white/5 rounded-full text-slate-400 hover:text-white transition-colors">
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

        {/* Video Cinema Block */}
        <section className="space-y-6">
          <div className="flex items-center justify-between border-b border-white/5 pb-4">
            <h2 className="text-sm font-mono uppercase tracking-widest flex items-center gap-2 text-slate-400">
              <Icon
                icon="solar:videocamera-record-bold-duotone"
                class="text-acid-purple"
              ></Icon>{" "}
              Cinematic Abstract
            </h2>
            {!videoUrl && !isVideoLoading && !videoError && (
              <button
                onClick={handleGenerateVideo}
                className="text-xs bg-white text-black px-4 py-2 rounded-full font-bold hover:bg-slate-200 transition-colors"
              >
                Generate Render
              </button>
            )}
          </div>

          <div className="aspect-[2.39/1] w-full bg-black rounded-2xl border border-white/10 overflow-hidden relative shadow-2xl">
            {videoUrl ? (
              <video
                src={videoUrl}
                controls
                autoPlay
                loop
                playsInline
                crossOrigin="anonymous"
                className="w-full h-full object-cover"
                onError={(e) => {
                  // Get more detailed error information
                  const videoElement = e.currentTarget as HTMLVideoElement;
                  const error = videoElement.error;

                  let errorMessage = "Video failed to load. ";

                  if (error) {
                    switch (error.code) {
                      case error.MEDIA_ERR_ABORTED:
                        errorMessage += "Playback was aborted.";
                        break;
                      case error.MEDIA_ERR_NETWORK:
                        errorMessage +=
                          "Network error occurred while loading the video.";
                        break;
                      case error.MEDIA_ERR_DECODE:
                        errorMessage +=
                          "Video decoding failed. The file may be corrupted.";
                        break;
                      case error.MEDIA_ERR_SRC_NOT_SUPPORTED:
                        errorMessage +=
                          "Video format not supported or URL requires authentication.";
                        break;
                      default:
                        errorMessage += "Unknown error occurred.";
                    }

                    if (error.message) {
                      errorMessage += ` (${error.message})`;
                    }
                  } else {
                    errorMessage +=
                      "The URL may require authentication or the video may not be ready yet.";
                  }

                  logger.error("Video playback error:", {
                    code: error?.code,
                    message: error?.message,
                    url: videoUrl?.substring(0, 100),
                  });

                  setVideoError(errorMessage);
                  setVideoUrl(null);
                }}
                onLoadStart={() => logger.info("Video loading started")}
                onCanPlay={() => logger.info("Video can play")}
                onLoadedMetadata={() => logger.info("Video metadata loaded")}
              />
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center p-8 text-center bg-grid">
                {isVideoLoading ? (
                  <div className="space-y-4 max-w-md mx-auto">
                    <Icon
                      icon="solar:atom-bold-duotone"
                      class="text-acid-purple text-5xl animate-spin-slow"
                    ></Icon>
                    <p className="text-white font-mono text-xs animate-pulse">
                      Rendering 8K Visualization...
                    </p>
                    {/* Progress Bar */}
                    <div className="w-full bg-slate-800 rounded-full h-2 overflow-hidden">
                      <div
                        className="bg-electric-cyan h-2 rounded-full transition-all duration-500 ease-out"
                        style={{ width: `${videoProgress}%` }}
                      />
                    </div>
                    <p className="text-slate-400 font-mono text-xs">
                      {videoProgress}% complete
                    </p>
                  </div>
                ) : videoError ? (
                  <div className="space-y-4 animate-in fade-in zoom-in flex flex-col items-center max-w-lg mx-auto p-6 rounded-xl bg-red-950/20 border border-red-900/50">
                    <Icon
                      icon="solar:shield-warning-bold"
                      class="text-red-500 text-4xl"
                    ></Icon>
                    <p className="text-red-200 text-sm leading-relaxed">
                      {videoError}
                    </p>

                    {isApiKeyError ? (
                      <button
                        onClick={handleSelectKey}
                        className="mt-2 px-6 py-3 bg-yellow-500/20 hover:bg-yellow-500/30 border border-yellow-500/50 rounded-full text-xs font-bold uppercase tracking-widest transition-colors text-yellow-200 flex items-center gap-2 shadow-lg hover:shadow-yellow-500/10 cursor-pointer"
                      >
                        <Icon icon="solar:key-minimalistic-square-3-bold-duotone"></Icon>
                        Select API Key
                      </button>
                    ) : (
                      <button
                        onClick={handleGenerateVideo}
                        className="mt-2 px-6 py-3 bg-white/10 hover:bg-white/20 border border-white/10 rounded-full text-xs font-bold uppercase tracking-widest transition-colors flex items-center gap-2 cursor-pointer"
                      >
                        <Icon icon="solar:restart-bold"></Icon>
                        Retry Generation
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="max-w-xl space-y-4">
                    <p className="font-serif italic text-slate-500 text-lg">
                      "Visualize the unseen."
                    </p>
                    <p className="text-xs font-mono text-slate-600 border border-white/5 p-4 rounded bg-black/50 backdrop-blur">
                      PROMPT PREVIEW:{" "}
                      {winningBrief?.veoVideoPrompt?.slice(0, 150) ||
                        "No prompt available"}
                      ...
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        </section>

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
                  <button className="w-full py-3 bg-white text-black font-bold text-sm rounded-lg hover:bg-slate-200 transition-colors flex items-center justify-center gap-2">
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
