/**
 * Taking out what `install` wrote, and nothing else.
 *
 * The hook files an install merges into (.claude/settings.json, .codex/hooks.json, .gemini/settings.json,
 * .cursor/hooks.json) belong to the user: their other hooks and settings must come through untouched. This strips only
 * the entries that run agent-flow's own hooks, drops what that leaves empty, and says whether anything of the user's
 * remains (a file with nothing left is deleted rather than left as an empty husk).
 */
/** A command that runs agent-flow's own binary: the project's copy or the vendored runtime. A name that merely contains `agent-flow` (a user's `agent-flow-guard.sh`) is not. */
const OUR_BIN = /agent-flow(?:-runtime)?[\\/]bin[\\/]agent-flow\.js/;
/** A hook command that runs one of agent-flow's own hooks (the guard, the stop gate, the session brief). */
export function isOurHook(command) {
    return typeof command === "string" && OUR_BIN.test(command) && /\s(guard|gates stop|brief)\b/.test(command);
}
/**
 * `flat` is Cursor's shape (`hooks.<event> = [{ command }]`); the others wrap commands in a group
 * (`hooks.<event> = [{ matcher?, hooks: [{ command }] }]`). The input is not modified.
 */
export function stripOurHooks(input, flat) {
    const config = JSON.parse(JSON.stringify(input));
    let removed = 0;
    const hooks = config.hooks;
    if (hooks && typeof hooks === "object" && !Array.isArray(hooks)) {
        for (const event of Object.keys(hooks)) {
            const list = hooks[event];
            if (!Array.isArray(list))
                continue;
            const kept = [];
            for (const entry of list) {
                if (flat) {
                    if (isOurHook(entry?.command))
                        removed++;
                    else
                        kept.push(entry);
                    continue;
                }
                const inner = entry?.hooks;
                if (!Array.isArray(inner)) {
                    kept.push(entry);
                    continue;
                }
                const left = inner.filter((h) => !isOurHook(h?.command));
                removed += inner.length - left.length;
                // A group that held only ours goes; one that held someone else's keeps its matcher and their hooks.
                if (left.length === inner.length)
                    kept.push(entry);
                else if (left.length)
                    kept.push({ ...entry, hooks: left });
            }
            if (kept.length)
                hooks[event] = kept;
            else
                delete hooks[event];
        }
        if (!Object.keys(hooks).length)
            delete config.hooks;
    }
    // The status badge install can add (`statusLine`): ours only when its command runs agent-flow's `statusline`.
    const line = config.statusLine;
    if (line && typeof line === "object" && typeof line.command === "string" && OUR_BIN.test(line.command) && /\sstatusline\b/.test(line.command)) {
        delete config.statusLine;
        removed++;
    }
    const others = Object.keys(config).filter((k) => k !== "version" || !flat);
    return { config, removed, empty: others.length === 0 };
}
