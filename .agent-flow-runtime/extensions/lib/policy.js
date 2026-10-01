/**
 * Change-size and content rules that live in the manifest, so "this repo never adds `console.log`" or "source changes
 * come with a test" is enforced by the checkout the change is judged in, not left to a reviewer's attention.
 *
 * `evaluatePolicy` is pure. The caller supplies per-file diff stats and a way to read a file's added lines, so the same
 * rules run on a branch diff (classify) and on the staged index (check-staged).
 */
import { matchAny } from "./manifest.js";
import { validateDenyCommands } from "./denycmd.js";
const MAX_LINE = 4000;
const MAX_FILES_SHOWN = 8;
export function policyOf(man) {
    const p = man?.policy;
    return p && typeof p === "object" && !Array.isArray(p) ? p : null;
}
/** Problems with a `policy` value, worded for `agent-flow doctor`. Shared with manifest validation. */
export function validatePolicy(p) {
    const problems = [];
    if (p === undefined)
        return problems;
    if (!p || typeof p !== "object" || Array.isArray(p))
        return ["policy must be an object"];
    const s = p;
    for (const k of ["max_changed_files", "max_diff_lines"]) {
        if (s[k] !== undefined && (!Number.isInteger(s[k]) || s[k] < 1))
            problems.push(`policy.${k} must be a positive integer`);
    }
    const strs = (v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x !== "");
    if (s.forbid_patterns !== undefined) {
        if (!Array.isArray(s.forbid_patterns))
            problems.push("policy.forbid_patterns must be an array");
        else
            s.forbid_patterns.forEach((f, i) => {
                const w = `policy.forbid_patterns[${i}]`;
                if (!f || typeof f.pattern !== "string" || !f.pattern)
                    return void problems.push(`${w}.pattern must be a non-empty regular expression string`);
                try {
                    new RegExp(f.pattern);
                }
                catch (e) {
                    problems.push(`${w}.pattern is not a valid regular expression: ${e.message}`);
                }
                if (f.paths !== undefined && !strs(f.paths))
                    problems.push(`${w}.paths must be a non-empty array of path patterns`);
                if (f.message !== undefined && typeof f.message !== "string")
                    problems.push(`${w}.message must be a string`);
            });
    }
    if (s.require_tests !== undefined) {
        if (!Array.isArray(s.require_tests))
            problems.push("policy.require_tests must be an array");
        else
            s.require_tests.forEach((r, i) => {
                const w = `policy.require_tests[${i}]`;
                if (!r || !strs(r.paths))
                    problems.push(`${w}.paths must be a non-empty array of path patterns`);
                if (!r || !strs(r.tests))
                    problems.push(`${w}.tests must be a non-empty array of path patterns`);
                if (r && r.message !== undefined && typeof r.message !== "string")
                    problems.push(`${w}.message must be a string`);
            });
    }
    problems.push(...validateDenyCommands(s.deny_commands));
    return problems;
}
const shown = (fs) => (fs.length > MAX_FILES_SHOWN ? `${fs.slice(0, MAX_FILES_SHOWN).join(", ")} … +${fs.length - MAX_FILES_SHOWN} more` : fs.join(", "));
export function evaluatePolicy(policy, files, stats, addedLines) {
    if (!policy)
        return [];
    const out = [];
    if (Number.isInteger(policy.max_changed_files) && files.length > policy.max_changed_files) {
        out.push({ rule: "max_changed_files", message: `${files.length} files changed; the limit is ${policy.max_changed_files}. Split the change.`, files: [] });
    }
    if (Number.isInteger(policy.max_diff_lines) && stats) {
        let total = 0;
        for (const s of stats.values())
            if (s)
                total += s.added + s.removed;
        if (total > policy.max_diff_lines)
            out.push({ rule: "max_diff_lines", message: `${total} lines changed; the limit is ${policy.max_diff_lines}. Split the change.`, files: [] });
    }
    for (const rule of Array.isArray(policy.forbid_patterns) ? policy.forbid_patterns : []) {
        let re;
        try {
            re = new RegExp(rule.pattern);
        }
        catch {
            continue; // reported by validatePolicy
        }
        const hits = [];
        for (const f of files) {
            if (rule.paths && !matchAny(rule.paths, f))
                continue;
            if (addedLines(f).some((l) => re.test(l.length > MAX_LINE ? l.slice(0, MAX_LINE) : l)))
                hits.push(f);
        }
        if (hits.length)
            out.push({ rule: "forbid_patterns", message: `${rule.message ?? `added lines match /${rule.pattern}/`} (${shown(hits)})`, files: hits });
    }
    for (const rule of Array.isArray(policy.require_tests) ? policy.require_tests : []) {
        if (!Array.isArray(rule.paths) || !Array.isArray(rule.tests))
            continue;
        const changed = files.filter((f) => matchAny(rule.paths, f) && !matchAny(rule.tests, f));
        if (changed.length && !files.some((f) => matchAny(rule.tests, f))) {
            out.push({ rule: "require_tests", message: `${rule.message ?? `changes under ${rule.paths.join(", ")} need a change under ${rule.tests.join(", ")}`} (${shown(changed)})`, files: changed });
        }
    }
    return out;
}
