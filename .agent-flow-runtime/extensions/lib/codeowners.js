/**
 * The guard stops an agent editing protected paths on the machine it runs on. A pull request can still change
 * them; only the host can refuse that (CODEOWNERS plus "require review from Code Owners"). This checks that the
 * repo has a CODEOWNERS entry over each protected path, and (when a logged-in `gh` can say so) whether GitHub enforces it.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const FILES = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];
const norm = (p) => p.replace(/\\/g, "/").replace(/^\.?\//, "").replace(/^\*\*\//, "");
/** Literal directory part of a glob: `docs/**` → `docs`, `.github/workflows/*.yml` → `.github/workflows`, `a/b.txt` → `a/b.txt`. */
const literalDir = (g) => {
    const n = norm(g);
    const i = n.search(/[*?[]/);
    if (i < 0)
        return n.replace(/\/$/, "");
    return n.slice(0, i).replace(/[^/]*$/, "").replace(/\/$/, "");
};
/** The repo-relative CODEOWNERS file GitHub would read, or null. */
export function codeownersFile(root) {
    return FILES.find((f) => existsSync(join(root, f))) ?? null;
}
/** Non-comment CODEOWNERS lines as [pattern, ownerCount]. An owner-less line un-owns the path on GitHub. */
export function codeownersRules(root) {
    for (const f of FILES) {
        const p = join(root, f);
        if (!existsSync(p))
            continue;
        return readFileSync(p, "utf-8")
            .split(/\r?\n/)
            .map((l) => l.replace(/#.*$/, "").trim().split(/\s+/))
            .filter((w) => w[0])
            .map((w) => [w[0], w.length - 1]);
    }
    return null;
}
/** Does CODEOWNERS pattern `raw` own everything under the protected glob `g`? Segment-wise, never by string prefix. */
function covers(raw, g) {
    const p = norm(raw);
    if (p === "*" || p === "**" || p === "**/*" || p === "")
        return true;
    const gd = literalDir(g);
    const wide = /(\*\*|\/)$/.test(raw) || /^[^*?[]*$/.test(p) && !p.includes("."); // `dir/`, `dir/**`, or a bare directory name
    const pd = literalDir(p);
    if (p === norm(g))
        return true;
    // A directory rule owns every descendant; a single-star rule (`docs/*`) owns direct children only.
    if (/\/\*$/.test(p) && !/\*\*/.test(p))
        return gd === pd && /\*\*/.test(g) === false;
    if (!wide && !/\*\*/.test(p))
        return false;
    return pd === "" ? false : gd === pd || gd.startsWith(`${pd}/`);
}
/** Protected globs that no CODEOWNERS entry covers. `null` when there is no CODEOWNERS file at all. */
export function uncoveredProtected(root, protectedPaths) {
    const rules = codeownersRules(root);
    if (rules === null)
        return null;
    // Last matching rule wins on GitHub: an owner-less match un-owns.
    return protectedPaths.filter((g) => {
        let owned = false;
        for (const [raw, owners] of rules)
            if (covers(raw, g))
                owned = owners > 0;
        return !owned;
    });
}
// A CODEOWNERS pattern for a protected glob: `kernel/exec/**` → `/kernel/exec/`, `STAGE` → `/STAGE`, `**/*.pem` → `*.pem`.
export function codeownersPattern(g) {
    const p = g.replace(/\\/g, "/").replace(/^\.?\//, "");
    if (p.startsWith("**/"))
        return p.slice(3);
    // No slash and a wildcard (`*.pem`): CODEOWNERS, like gitignore, then matches at any depth, as matchesPattern does here.
    if (!p.includes("/") && /[*?[]/.test(p))
        return p;
    return `/${p.replace(/\/\*\*$/, "/")}`;
}
/**
 * Whether a GitHub login is a person or an organization. CODEOWNERS takes users and `@org/team` but not a bare `@org`,
 * so for an organization the tool has to ask which team. Null when a logged-in `gh` can't say.
 */
export function ownerKind(login, opts = {}) {
    try {
        const r = spawnSync(opts.gh ?? process.env.AGENT_FLOW_GH ?? "gh", ["api", `users/${login}`, "--jq", ".type"], { encoding: "utf-8", timeout: opts.timeoutMs ?? 4000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GH_PROMPT_DISABLED: "1" } });
        const t = r.status === 0 ? r.stdout.trim() : "";
        return t === "User" || t === "Organization" ? t : null;
    }
    catch {
        return null;
    }
}
/** The repo's GitHub owner from `origin` (`https://github.com/acme/x.git`, `git@github.com:acme/x`), or null. */
export function githubOwner(remoteUrl) {
    const m = remoteUrl.trim().match(/github\.com[:/]([^/\s]+)\//);
    return m ? `@${m[1]}` : null;
}
/** `owner/repo` from a GitHub remote URL, or null for any other host. */
export function githubSlug(remoteUrl) {
    const m = remoteUrl.trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(\.git)?\/?$/);
    return m ? `${m[1]}/${m[2]}` : null;
}
export function hostCodeOwnerReview(slug, branch, opts = {}) {
    const gh = opts.gh ?? process.env.AGENT_FLOW_GH ?? "gh";
    const timeout = opts.timeoutMs ?? 4000;
    const api = opts.api ?? ((path) => {
        try {
            const r = spawnSync(gh, ["api", path], { encoding: "utf-8", timeout, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GH_PROMPT_DISABLED: "1" } });
            if (r.error || r.status !== 0) {
                const http = /HTTP (\d{3})/.exec(r.stderr ?? "");
                return { ok: false, status: http ? Number(http[1]) : null };
            }
            return { ok: true, json: JSON.parse(r.stdout) };
        }
        catch {
            return { ok: false, status: null };
        }
    });
    const enc = encodeURIComponent(branch);
    // Rulesets are readable with plain read access; a pull_request rule may require Code Owner review.
    const rules = api(`repos/${slug}/rules/branches/${enc}`);
    if (!rules.ok)
        return null;
    if (Array.isArray(rules.json) && rules.json.some((r) => r?.type === "pull_request" && r?.parameters?.require_code_owner_review === true)) {
        return { state: "enforced", via: "ruleset" };
    }
    const br = api(`repos/${slug}/branches/${enc}`);
    if (!br.ok)
        return null;
    const isProtected = br.json?.protected === true;
    if (!isProtected)
        return { state: "not_enforced", protected: false };
    // Classic protection details need admin rights; without them the answer is "protected, review setting unseen".
    const prot = api(`repos/${slug}/branches/${enc}/protection`);
    if (!prot.ok)
        return { state: "unknown", protected: true };
    const req = prot.json?.required_pull_request_reviews;
    return req?.require_code_owner_reviews === true ? { state: "enforced", via: "branch protection" } : { state: "not_enforced", protected: true };
}
