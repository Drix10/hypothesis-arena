/**
 * Context Filtering Utilities
 * 
 * Smart context management to separate trading vs management prompts.
 * Reduces token usage by only including relevant sections based on action type.
 */

// Section headers for prompt filtering
const MANAGEMENT_SECTION = '## POSITION MANAGEMENT (when action="MANAGE")';

/**
 * Extract a specific section from a prompt by header
 * @param prompt - Full prompt text
 * @param sectionHeader - Header to find (e.g., "## POSITION MANAGEMENT")
 * @returns Extracted section or empty string if not found
 */
function extractSection(prompt: string, sectionHeader: string): string {
    if (!prompt || !sectionHeader) return '';

    const lines = prompt.split('\n');
    const startIndex = lines.findIndex(line => line.trim() === sectionHeader);

    if (startIndex === -1) return '';

    // Find the next section header (starts with ##) or end of prompt
    let endIndex = lines.length;
    for (let i = startIndex + 1; i < lines.length; i++) {
        if (lines[i].trim().startsWith('## ') && lines[i].trim() !== sectionHeader) {
            endIndex = i;
            break;
        }
    }

    return lines.slice(startIndex, endIndex).join('\n');
}

/**
 * Remove a specific section from a prompt
 * @param prompt - Full prompt text
 * @param sectionHeader - Header to remove (e.g., "## POSITION MANAGEMENT")
 * @returns Prompt without the specified section
 */
function removeSection(prompt: string, sectionHeader: string): string {
    if (!prompt || !sectionHeader) return prompt;

    const lines = prompt.split('\n');
    const startIndex = lines.findIndex(line => line.trim() === sectionHeader);

    if (startIndex === -1) return prompt;

    // Find the next section header (starts with ##) or end of prompt
    let endIndex = lines.length;
    for (let i = startIndex + 1; i < lines.length; i++) {
        if (lines[i].trim().startsWith('## ') && lines[i].trim() !== sectionHeader) {
            endIndex = i;
            break;
        }
    }

    // Remove the section and any trailing blank lines
    const before = lines.slice(0, startIndex);
    const after = lines.slice(endIndex);

    // Trim trailing blank lines from before section
    while (before.length > 0 && before[before.length - 1].trim() === '') {
        before.pop();
    }

    return [...before, ...after].join('\n');
}

/**
 * Filter analyst prompt based on action type
 * 
 * For MANAGE actions: Only include POSITION MANAGEMENT section
 * For LONG/SHORT actions: Exclude POSITION MANAGEMENT section
 * 
 * @param action - Action type (LONG, SHORT, or MANAGE)
 * @param fullPrompt - Complete analyst system prompt
 * @returns Filtered prompt with only relevant sections
 */
export function filterPromptByAction(
    action: 'LONG' | 'SHORT' | 'MANAGE',
    fullPrompt: string
): string {
    if (!fullPrompt || typeof fullPrompt !== 'string') {
        return fullPrompt || '';
    }

    if (action === 'MANAGE') {
        // For MANAGE: Extract only the position management section
        const managementSection = extractSection(fullPrompt, MANAGEMENT_SECTION);

        if (!managementSection) {
            // If no management section found, return full prompt (backward compatibility)
            return fullPrompt;
        }

        // Include core identity and the management section
        // Extract everything up to the first ## section after identity
        const lines = fullPrompt.split('\n');
        let coreEndIndex = 0;

        // Find where the main methodology sections start (after identity/philosophy)
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            // Look for framework/methodology sections (usually start with ##)
            if (line.startsWith('## ') &&
                !line.includes('IDENTITY') &&
                !line.includes('PHILOSOPHY') &&
                !line.includes('PRIORITY DIRECTIVE') &&
                !line.includes('COLLABORATIVE ROLE') &&
                !line.includes('TRADING CONTEXT')) {
                coreEndIndex = i;
                break;
            }
        }

        // If no methodology sections found, include entire prompt up to management section
        // This handles edge case where prompt has no standard methodology sections
        if (coreEndIndex === 0) {
            // Find the management section start
            // FIXED: Handle edge case where management section is at prompt start (index 0)
            const managementStartIndex = lines.findIndex(line =>
                line.trim() === MANAGEMENT_SECTION
            );
            if (managementStartIndex > 0) {
                coreEndIndex = managementStartIndex;
            } else if (managementStartIndex === 0) {
                // Management section at start - include just the first section
                coreEndIndex = Math.min(10, lines.length); // Include first 10 lines as fallback
            } else {
                // If management section not found either, use entire prompt
                coreEndIndex = lines.length;
            }
        }

        const coreIdentity = lines.slice(0, coreEndIndex).join('\n');

        return `${coreIdentity}\n\n${managementSection}`;
    } else {
        // For LONG/SHORT: Remove position management section to save tokens
        return removeSection(fullPrompt, MANAGEMENT_SECTION);
    }
}

/**
 * Get token savings estimate from context filtering
 * @param action - Action type
 * @param fullPrompt - Complete prompt
 * @returns Estimated tokens saved (rough approximation: 1 token ≈ 4 characters)
 */
export function estimateTokenSavings(
    action: 'LONG' | 'SHORT' | 'MANAGE',
    fullPrompt: string
): number {
    if (!fullPrompt) return 0;

    const filtered = filterPromptByAction(action, fullPrompt);
    const charsSaved = fullPrompt.length - filtered.length;

    // Rough estimate: 1 token ≈ 4 characters
    return Math.floor(charsSaved / 4);
}

/**
 * Batch filter multiple analyst prompts
 * @param action - Action type
 * @param promptsMap - Map of methodology to full prompts
 * @returns Map of methodology to filtered prompts
 */
export function filterAllPrompts(
    action: 'LONG' | 'SHORT' | 'MANAGE',
    promptsMap: Record<string, string>
): Record<string, string> {
    const filtered: Record<string, string> = {};

    for (const [methodology, prompt] of Object.entries(promptsMap)) {
        filtered[methodology] = filterPromptByAction(action, prompt);
    }

    return filtered;
}
