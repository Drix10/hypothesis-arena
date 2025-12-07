import { GoogleGenAI } from "@google/genai";
import { VEO_MODEL, MAX_VEO_POLL_ATTEMPTS, VEO_POLL_INTERVAL_MS } from "../constants";
import { logger } from "./utils/logger";

/**
 * Generates 8-second cinematic visualization using Google Veo 3.1.
 * Enhances user prompt with professional cinematography direction.
 * 
 * @param veoPrompt - Base visual concept from winning brief (should follow 8-agent framework)
 * @param onProgress - Optional callback for progress updates (attempt, max, percentage)
 * @returns Direct URI to generated video (temporary, valid 24-48 hours)
 * 
 * @throws {Error} If video generation fails, times out, or returns no URI
 * 
 * @example
 * ```typescript
 * const videoUrl = await generateWinningVideo(
 *   winningBrief.veoVideoPrompt,
 *   (attempt, max, percentage) => console.log(`${percentage}% complete`)
 * );
 * console.log("Video ready:", videoUrl);
 * ```
 */
export const generateWinningVideo = async (
  veoPrompt: string,
  onProgress?: (attempt: number, max: number, percentage: number) => void
): Promise<string> => {

  // Input validation
  if (!veoPrompt || typeof veoPrompt !== "string" || veoPrompt.trim().length === 0) {
    throw new Error("generateWinningVideo: veoPrompt must be a non-empty string");
  }

  // Strict API Key check for Veo
  if (!process.env.API_KEY || process.env.API_KEY.length === 0) {
    throw new Error(
      "Veo generation requires a valid API_KEY. Please ensure you have selected a key using the 'Select API Key' button."
    );
  }

  // Initialize SDK
  // Note: Creates a new instance to ensure any recently selected API key is used
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

  // Enhance prompt with additional technical direction
  // This consistency layer ensures the model output aligns with production standards
  const enhancedPrompt = `
${veoPrompt}

[TECHNICAL CONSISTENCY LAYER]
Ensure consistent quality throughout: maintain focus throughout sequence, smooth motion without jarring cuts, 
coherent lighting that follows physical laws, temporally stable rendering (no flickering or morphing artifacts), 
audio-visual sync if sound generation enabled, color consistency frame-to-frame.

[RENDERING PRIORITIES]
Prioritize: photorealistic physics over stylized effects, subtle details over bombastic visuals, 
scientific accuracy in representations where applicable, emotional resonance through composition and color.
  `.trim();

  // Initiate video generation with comprehensive error handling
  let operation: any;
  try {
    operation = await ai.models.generateVideos({
      model: VEO_MODEL,
      prompt: enhancedPrompt,
      config: {
        numberOfVideos: 1,
        resolution: '1080p', // High def for cinematic quality
        aspectRatio: '16:9'
      }
    });
  } catch (error: any) {
    // Check for "Requested entity was not found" which implies API key issues for Veo
    // This allows the UI to trigger the openSelectKey flow
    if (error.message?.includes("Requested entity was not found") || JSON.stringify(error).includes("Requested entity was not found")) {
      throw new Error("API_KEY_INVALID");
    }

    if (error.message?.includes("quota") || error.message?.includes("429")) {
      throw new Error(
        "Veo API quota exceeded. Video generation requires higher quota. Check console.cloud.google.com"
      );
    }
    throw new Error(
      `Veo video generation failed to start: ${error.message || "Unknown error"}. ` +
      "This may be a temporary API issue—please retry."
    );
  }

  // Poll for completion with exponential backoff / standard interval
  let pollAttempts = 0;
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 5;
  const POLL_TIMEOUT_MS = 30000; // 30 second timeout per poll request

  while (!operation.done && pollAttempts < MAX_VEO_POLL_ATTEMPTS) {
    // Wait before next poll
    await new Promise((resolve) => setTimeout(resolve, VEO_POLL_INTERVAL_MS));

    try {
      // Add timeout to individual poll requests to prevent hanging
      const pollPromise = ai.operations.getVideosOperation({ operation: operation });
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Poll request timeout')), POLL_TIMEOUT_MS)
      );

      operation = await Promise.race([pollPromise, timeoutPromise]);
      consecutiveErrors = 0; // Reset on success

      // Report progress to callback
      if (onProgress) {
        const percentage = Math.round((pollAttempts / MAX_VEO_POLL_ATTEMPTS) * 100);
        onProgress(pollAttempts, MAX_VEO_POLL_ATTEMPTS, percentage);
      }
    } catch (e: any) {
      consecutiveErrors++;
      // Log polling errors but continue (transient network issues)
      logger.warn(
        `[generateWinningVideo] Polling attempt ${pollAttempts + 1}/${MAX_VEO_POLL_ATTEMPTS} failed:`,
        e.message
      );

      // Circuit breaker: if too many consecutive errors, abort
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        throw new Error(
          `Video generation polling failed after ${MAX_CONSECUTIVE_ERRORS} consecutive errors. ` +
          "The operation may be stuck or the API is unavailable."
        );
      }
    }
    pollAttempts++;
  }

  // Check if operation completed successfully
  if (!operation.done) {
    const timeoutSeconds = Math.floor((MAX_VEO_POLL_ATTEMPTS * VEO_POLL_INTERVAL_MS) / 1000);
    throw new Error(
      `Video generation timed out after ${timeoutSeconds} seconds (${pollAttempts} polling attempts). ` +
      "The operation may still complete in the background."
    );
  }

  // Extract video URI
  const videoUri = operation.response?.generatedVideos?.[0]?.video?.uri;

  if (!videoUri || typeof videoUri !== "string") {
    throw new Error(
      "Video generation completed but no URI was returned. This may indicate:\n" +
      "• Content policy violation (check prompt for restricted content)\n" +
      "• Internal Veo processing error\n" +
      "• Malformed API response"
    );
  }

  logger.info(`Video generated successfully. URI: ${videoUri.substring(0, 50)}...`);

  // The Veo API returns a URI that should be directly accessible
  // If the video doesn't load in the browser, it may be due to:
  // 1. CORS restrictions
  // 2. Authentication requirements
  // 3. The video still being processed
  //
  // The URI is typically a Google Cloud Storage URL that should work directly
  // in video elements without additional authentication
  return videoUri;
};
