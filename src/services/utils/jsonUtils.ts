// JSON size warning threshold for error messages
const JSON_SIZE_WARNING_THRESHOLD = 500;

/**
 * Comprehensive JSON cleaner handling all Gemini edge cases.
 * Removes markdown, comments, trailing commas, and invisible characters.
 * 
 * @param text - Raw string output from the model
 * @returns Cleaned JSON string ready for parsing
 */
export const extractCleanJson = (text: string): string => {
  if (!text || typeof text !== "string") {
    throw new Error("extractCleanJson: input must be non-empty string");
  }

  // Guard against extremely large inputs that could cause performance issues
  const MAX_INPUT_SIZE = 1_000_000; // 1MB
  if (text.length > MAX_INPUT_SIZE) {
    throw new Error(`extractCleanJson: input too large (${text.length} chars, max ${MAX_INPUT_SIZE})`);
  }

  let cleaned = text.trim();

  // 1. Attempt to isolate JSON block if model included conversational text
  // Handles both objects {...} and arrays [...]
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  const firstBracket = cleaned.indexOf('[');
  const lastBracket = cleaned.lastIndexOf(']');

  // Determine if we have an object or array at root
  const isObject = firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket);
  const isArray = firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace);

  if (isObject && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.substring(firstBrace, lastBrace + 1);
  } else if (isArray && lastBracket !== -1 && lastBracket > firstBracket) {
    cleaned = cleaned.substring(firstBracket, lastBracket + 1);
  }

  // 2. Remove markdown code fences (handles multiline)
  cleaned = cleaned.replace(/^```(?:json)?\s*/gm, "");
  cleaned = cleaned.replace(/```\s*$/gm, "");

  // 3. Remove trailing commas (JSON spec violation)
  // Handles cases like `[1, 2,]` or `{"a": 1,}`
  cleaned = cleaned.replace(/,(\s*[}\]])/g, "$1");

  // 4. Remove block comments /* ... */
  cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, "");

  // 5. Remove line comments // ...
  cleaned = cleaned.replace(/\/\/.*/g, "");

  // 6. Remove zero-width and non-breaking spaces
  cleaned = cleaned.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, "");

  // 7. Remove BOM if present
  cleaned = cleaned.replace(/^\uFEFF/, "");

  return cleaned.trim();
};

/**
 * Safe JSON parser with detailed error reporting.
 * Provides context on where the parse failed to aid debugging.
 * 
 * @param jsonString - Cleaned JSON string
 * @param context - Description of what is being parsed (for error messages)
 * @returns Parsed object of type T
 */
export const safeJsonParse = <T = any>(jsonString: string, context: string = "unknown"): T => {
  try {
    return JSON.parse(jsonString) as T;
  } catch (error: any) {
    // Limit preview size to prevent memory issues with huge responses
    const maxPreviewSize = Math.min(JSON_SIZE_WARNING_THRESHOLD, jsonString.length);
    const preview = jsonString.slice(0, maxPreviewSize);
    const errorPosition = error.message.match(/position (\d+)/)?.[1];

    let errorContext = "";
    if (errorPosition) {
      const pos = parseInt(errorPosition, 10);
      const start = Math.max(0, pos - 50);
      const end = Math.min(jsonString.length, pos + 50);
      // Limit error context to prevent huge error messages
      const contextSnippet = jsonString.slice(start, end);
      errorContext = `\nNear position ${pos}: "${contextSnippet.slice(0, 100)}"`;
    }

    throw new Error(
      `JSON parse failed in ${context}. Error: ${error.message}${errorContext}\n` +
      `Preview (first ${maxPreviewSize} chars): ${preview}...`
    );
  }
};