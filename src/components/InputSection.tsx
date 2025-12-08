import React, { useState, useEffect, useRef } from "react";
import Icon from "./Icon";
import { logger } from "../services/utils/logger";
import { hasApiKey } from "../services/apiKeyManager";
import ApiKeyInput from "./ApiKeyInput";
import "../types";

interface Props {
  onSubmit: (text: string, file?: { mimeType: string; data: string }) => void;
  isLoading: boolean;
  loadingStatus?: string; // New prop for detailed status
}

// Removed heavy canvas animations for better performance

// ═════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═════════════════════════════════════════════════════════════════════════════

const InputSection: React.FC<Props> = ({
  onSubmit,
  isLoading,
  loadingStatus = "",
}) => {
  const [input, setInput] = useState("");
  const [file, setFile] = useState<
    { mimeType: string; data: string } | undefined
  >();
  const [fileName, setFileName] = useState<string>("");
  // Initialize with actual state to avoid FOUC
  const [apiKeySet, setApiKeySet] = useState(() => hasApiKey());
  const [isHovered, setIsHovered] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [showTooltip, setShowTooltip] = useState(false);

  // Track ALL FileReaders to abort on unmount or new file selection
  // Using Set to handle rapid file changes where multiple readers might exist
  const readersRef = useRef<Set<FileReader>>(new Set());

  // Cleanup ALL FileReaders on unmount
  useEffect(() => {
    return () => {
      readersRef.current.forEach((reader) => {
        try {
          reader.abort();
        } catch (e) {
          // Reader might already be done, ignore error
        }
      });
      readersRef.current.clear();
    };
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    setValidationError(null);

    // Abort ALL previous FileReaders if still running
    readersRef.current.forEach((reader) => {
      try {
        reader.abort();
      } catch (e) {
        // Reader might already be done, ignore error
      }
    });
    readersRef.current.clear();

    if (selectedFile) {
      // Valid Types: Images, PDFs, Text
      const isValidType =
        selectedFile.type.startsWith("image/") ||
        selectedFile.type === "application/pdf" ||
        selectedFile.type === "text/plain";

      if (!isValidType) {
        setValidationError("Unsupported file. Upload Image, PDF, or Text.");
        e.target.value = "";
        return;
      }

      // Max Size: 20MB (Gemini API limit)
      const MAX_SIZE = 20 * 1024 * 1024;
      if (selectedFile.size > MAX_SIZE) {
        setValidationError("File exceeds 20MB limit.");
        e.target.value = "";
        return;
      }

      // File content validation (magic number check for security)
      // This prevents malicious files disguised with wrong MIME types
      const validateFileContent = async (file: File): Promise<boolean> => {
        return new Promise((resolve) => {
          const headerReader = new FileReader();
          const blob = file.slice(0, 4); // Read first 4 bytes

          // Track this reader for cleanup
          readersRef.current.add(headerReader);

          headerReader.onloadend = () => {
            // Remove from tracking after completion
            readersRef.current.delete(headerReader);

            const arr = new Uint8Array(headerReader.result as ArrayBuffer);
            let header = "";
            for (let i = 0; i < arr.length; i++) {
              header += arr[i].toString(16).padStart(2, "0");
            }

            // Check magic numbers for common file types
            const validHeaders = [
              "25504446", // PDF (%PDF)
              "89504e47", // PNG
              "ffd8ffe0", // JPEG
              "ffd8ffe1", // JPEG
              "ffd8ffe2", // JPEG
              "47494638", // GIF
            ];

            // Text files don't have magic numbers, allow if MIME is text/plain
            if (file.type === "text/plain") {
              resolve(true);
              return;
            }

            resolve(validHeaders.some((h) => header.startsWith(h)));
          };

          headerReader.onerror = () => {
            // Remove from tracking on error
            readersRef.current.delete(headerReader);
            resolve(false);
          };

          headerReader.readAsArrayBuffer(blob);
        });
      };

      // Validate file content before processing
      validateFileContent(selectedFile).then((isValid) => {
        if (!isValid) {
          setValidationError(
            "File content doesn't match type. Possible corrupted or malicious file."
          );
          e.target.value = "";
          return;
        }

        const reader = new FileReader();
        readersRef.current.add(reader);

        reader.onloadend = () => {
          // Only process if this reader is still in our set (not aborted)
          if (!readersRef.current.has(reader)) return;

          // Remove from set after processing
          readersRef.current.delete(reader);

          const base64String = reader.result as string;
          if (typeof base64String === "string" && base64String.includes(",")) {
            const base64Data = base64String.split(",")[1];

            // Validate base64 format (basic check)
            const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
            if (!base64Regex.test(base64Data)) {
              setValidationError(
                "File encoding failed. Please try a different file."
              );
              return;
            }

            // Additional length check (base64 should be roughly 4/3 of original size)
            const expectedLength = Math.ceil((selectedFile.size * 4) / 3);
            if (
              Math.abs(base64Data.length - expectedLength) >
              expectedLength * 0.1
            ) {
              logger.warn(
                `Base64 length mismatch: expected ~${expectedLength}, got ${base64Data.length}`
              );
            }

            setFile({
              mimeType: selectedFile.type,
              data: base64Data,
            });
            setFileName(selectedFile.name);
            setValidationError(null);
          } else {
            setValidationError("File encoding failed. Invalid format.");
          }
        };

        reader.onerror = () => {
          readersRef.current.delete(reader);
          setValidationError("Failed to read file. Please try again.");
          e.target.value = "";
        };

        reader.readAsDataURL(selectedFile);
      });
    }
  };

  const handleRemoveFile = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();

    // Abort ALL ongoing FileReader operations
    readersRef.current.forEach((reader) => {
      try {
        reader.abort();
      } catch (e) {
        // Reader might already be done, ignore error
      }
    });
    readersRef.current.clear();

    setFile(undefined);
    setFileName("");
    setValidationError(null);
    setShowTooltip(false);
  };

  const getFileIcon = () => {
    if (!file) return "solar:paperclip-linear";
    if (file.mimeType.includes("pdf")) return "solar:file-text-bold-duotone";
    if (file.mimeType.includes("image")) return "solar:gallery-bold-duotone";
    return "solar:document-bold-duotone";
  };

  // Check if API key is set on mount
  useEffect(() => {
    setApiKeySet(hasApiKey());
  }, []);

  const handleApiKeySet = () => {
    setApiKeySet(true);
  };

  const handleApiKeyCleared = () => {
    setApiKeySet(false);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedInput = input.trim();

    // Validate input
    if (!trimmedInput) {
      setValidationError("Please enter a research topic");
      return;
    }

    // Max length validation (Gemini API context limit consideration)
    const MAX_INPUT_LENGTH = 10000;
    if (trimmedInput.length > MAX_INPUT_LENGTH) {
      setValidationError(
        `Input too long. Maximum ${MAX_INPUT_LENGTH} characters.`
      );
      return;
    }

    onSubmit(trimmedInput, file);
  };

  return (
    <div className="w-full min-h-screen relative flex flex-col items-center justify-center overflow-hidden bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950">
      {/* Simple static gradient background - no animations */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_rgba(59,130,246,0.1),transparent_50%),radial-gradient(ellipse_at_bottom,_rgba(139,92,246,0.1),transparent_50%)] pointer-events-none"></div>

      {/* Subtle vignette */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_0%,_#020617_100%)] pointer-events-none"></div>

      {/* 4. Content */}
      <div className="relative z-10 w-full max-w-5xl mx-auto px-6 pt-10 pb-20 flex flex-col items-center">
        {/* Badge */}
        <div className="mb-10 animate-in fade-in slide-in-from-top-4 duration-700">
          <div className="flex items-center gap-3 px-5 py-2 rounded-full border border-white/10 bg-black/50 backdrop-blur-md shadow-2xl">
            <div className="relative flex h-2 w-2">
              <span
                className={`relative inline-flex rounded-full h-2 w-2 ${
                  isLoading ? "bg-acid-purple animate-pulse" : "bg-emerald-500"
                }`}
              ></span>
            </div>
            <span className="text-[10px] font-mono tracking-[0.25em] text-slate-400 uppercase">
              Neural Engine Online
            </span>
          </div>
        </div>

        {/* Hero Text */}
        <div className="text-center mb-16 space-y-6 max-w-4xl relative">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[140%] h-[140%] bg-black/60 blur-[80px] -z-10 rounded-full"></div>

          <h1 className="text-5xl md:text-7xl lg:text-8xl font-serif font-medium text-white tracking-tight leading-[1.05] animate-in fade-in zoom-in-95 duration-1000 delay-100 drop-shadow-2xl">
            From{" "}
            <span className="italic text-transparent bg-clip-text bg-gradient-to-br from-slate-100 to-slate-400">
              Spark
            </span>{" "}
            to <br />
            <span className="italic text-transparent bg-clip-text bg-gradient-to-br from-electric-cyan via-cyan-200 to-blue-500 filter drop-shadow-[0_0_15px_rgba(0,240,255,0.15)]">
              Supernova.
            </span>
          </h1>
          <p className="max-w-xl mx-auto text-lg text-slate-300 font-sans font-light leading-relaxed animate-in fade-in slide-in-from-bottom-4 duration-1000 delay-200 drop-shadow-lg">
            Eight world-class AI researcher archetypes. One adversarial arena.{" "}
            <br className="hidden md:block" />
            Evolve your raw idea into a publication-ready breakthrough.
          </p>
        </div>

        {/* API Key Input or Tournament Input */}
        {!apiKeySet ? (
          <ApiKeyInput
            onKeySet={handleApiKeySet}
            onKeyCleared={handleApiKeyCleared}
          />
        ) : (
          <div className="relative w-full max-w-2xl transition-all duration-700 ease-out">
            {validationError && (
              <div className="absolute -top-14 left-0 right-0 z-30 flex justify-center animate-in slide-in-from-bottom-2 fade-in duration-300">
                <div
                  id="input-error"
                  role="alert"
                  aria-live="polite"
                  className="bg-red-950/90 backdrop-blur-md text-red-200 px-4 py-2 rounded-full text-xs font-mono border border-red-500/50 shadow-lg flex items-center gap-2"
                >
                  <Icon
                    icon="solar:danger-triangle-bold"
                    width="14"
                    aria-hidden="true"
                  ></Icon>
                  {validationError}
                </div>
              </div>
            )}

            <div className="group relative">
              {/* Hover Glow */}
              <div
                className={`absolute -inset-[1px] rounded-2xl bg-gradient-to-r from-transparent via-electric-cyan/60 to-transparent transition-opacity duration-700 ${
                  isHovered ? "opacity-100" : "opacity-0"
                }`}
              ></div>

              {/* Main Wrapper */}
              <div className="relative bg-black/90 backdrop-blur-xl rounded-2xl border border-white/10 shadow-2xl ring-1 ring-white/5 transition-all duration-300">
                <form onSubmit={handleSubmit} className="relative">
                  <textarea
                    value={input}
                    onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                      setInput(e.target.value)
                    }
                    placeholder="State your hypothesis..."
                    className="w-full bg-transparent text-xl md:text-2xl text-slate-100 placeholder-slate-600 p-8 pb-24 min-h-[240px] resize-none focus:outline-none font-serif italic z-10 relative selection:bg-electric-cyan/30 rounded-2xl"
                    disabled={isLoading}
                    onFocus={() => setIsHovered(true)}
                    onBlur={() => setIsHovered(false)}
                    aria-label="Research hypothesis input"
                    aria-describedby={
                      validationError ? "input-error" : undefined
                    }
                    aria-invalid={!!validationError}
                  />

                  <div className="absolute bottom-4 left-4 right-4 flex justify-between items-center z-20">
                    <div className="flex items-center gap-3">
                      {/* API Key Indicator */}
                      <ApiKeyInput
                        onKeySet={handleApiKeySet}
                        onKeyCleared={handleApiKeyCleared}
                      />

                      {/* Upload with Tooltip */}
                      <div className="relative group/tooltip">
                        <div
                          className={`flex items-center rounded-lg border transition-all duration-300 ${
                            file
                              ? "bg-emerald-950/40 border-emerald-500/40"
                              : "border-transparent hover:bg-white/5 hover:border-white/10"
                          }`}
                        >
                          <label
                            className={`cursor-pointer flex items-center gap-2 px-3 py-2 ${
                              file
                                ? "text-emerald-400"
                                : "text-slate-500 hover:text-white"
                            }`}
                            onMouseEnter={() => setShowTooltip(true)}
                            onMouseLeave={() => setShowTooltip(false)}
                          >
                            <input
                              type="file"
                              className="hidden"
                              accept=".pdf,image/*,.txt"
                              onChange={handleFileChange}
                            />
                            <Icon icon={getFileIcon()} width="18"></Icon>
                            <span className="text-[10px] font-mono tracking-widest uppercase truncate max-w-[150px]">
                              {fileName || "Context Data"}
                            </span>
                          </label>

                          {file && (
                            <button
                              onClick={handleRemoveFile}
                              className="pr-2 pl-1 text-emerald-500/50 hover:text-red-400 transition-colors"
                              type="button"
                              aria-label="Remove file"
                            >
                              <Icon
                                icon="solar:close-circle-bold"
                                width="16"
                              ></Icon>
                            </button>
                          )}
                        </div>

                        {/* Tooltip Content */}
                        <div
                          className={`absolute bottom-full left-0 mb-3 w-64 p-3 bg-slate-900/95 backdrop-blur border border-slate-700 rounded-xl text-xs text-slate-300 shadow-xl pointer-events-none transition-all duration-300 z-50 ${
                            showTooltip
                              ? "opacity-100 translate-y-0"
                              : "opacity-0 translate-y-2"
                          }`}
                        >
                          <p className="font-semibold text-white mb-1">
                            Context Data
                          </p>
                          <p>
                            Upload a PDF, Image, or Text file to provide
                            additional context for the hypothesis.
                          </p>
                          <div className="absolute -bottom-1.5 left-4 w-3 h-3 bg-slate-900/95 border-b border-r border-slate-700 rotate-45"></div>
                        </div>
                      </div>
                    </div>

                    {/* Submit with Enhanced Loading */}
                    <button
                      type="submit"
                      disabled={!input.trim() || isLoading}
                      className={`relative overflow-hidden bg-slate-100 text-black px-8 py-3 rounded-xl font-bold text-xs uppercase tracking-widest transition-all shadow-[0_0_20px_rgba(255,255,255,0.1)] hover:shadow-[0_0_30px_rgba(255,255,255,0.3)] min-w-[140px] ${
                        isLoading
                          ? "cursor-wait"
                          : "hover:scale-[1.02] active:scale-[0.98]"
                      }`}
                    >
                      {isLoading && (
                        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-electric-cyan/20 to-transparent animate-beam"></div>
                      )}

                      {/* Removed pulsing overlay - beam animation is sufficient */}

                      <span className="relative z-10 flex items-center justify-center gap-2">
                        {isLoading ? (
                          <div className="flex items-center gap-2">
                            <Icon
                              icon="solar:refresh-circle-broken"
                              class="animate-spin text-lg text-slate-700"
                            ></Icon>
                            <span className="text-slate-800 font-bold">
                              {loadingStatus || "Processing"}
                            </span>
                          </div>
                        ) : (
                          <>
                            <span>Ignite</span>
                            <Icon
                              icon="solar:play-circle-bold-duotone"
                              class="text-lg"
                            ></Icon>
                          </>
                        )}
                      </span>
                    </button>
                  </div>
                </form>
              </div>
            </div>

            <div className="absolute -bottom-24 left-1/2 -translate-x-1/2 w-px h-24 bg-gradient-to-b from-white/10 to-transparent"></div>
          </div>
        )}

        {/* Footer */}
        <div className="mt-40 grid grid-cols-2 md:grid-cols-4 gap-8 border-t border-white/5 pt-10 opacity-60 hover:opacity-100 transition-opacity duration-500">
          {[
            { label: "Engine", value: "Gemini 2.0 Flash" },
            { label: "Agents", value: "8 Expert Minds" },
            { label: "Standard", value: "Nature / Science" },
          ].map((stat, i) => (
            <div
              key={i}
              className="flex flex-col items-center md:items-start space-y-1 group cursor-default"
            >
              <span className="text-[9px] text-slate-500 font-mono uppercase tracking-[0.2em] group-hover:text-electric-cyan transition-colors">
                {stat.label}
              </span>
              <span className="text-slate-300 font-serif italic text-lg">
                {stat.value}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default InputSection;
