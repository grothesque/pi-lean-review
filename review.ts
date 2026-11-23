/** Local code review on an independent conversation branch. */
import {
	BorderedLoader,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { promises as fs } from "node:fs";
import path from "node:path";

const REVIEW_STATE_TYPE = "review-session";
const REVIEW_ANCHOR_TYPE = "review-anchor";

const UNCOMMITTED_PROMPT =
	"Review the current code changes (staged, unstaged, and untracked files) and provide prioritized findings.";

const REVIEW_RUBRIC = `# Review Guidelines

You are acting as a code reviewer for a proposed code change made by another engineer.

Below are default guidelines for determining what to flag. These are not the final word — if you encounter more specific guidelines elsewhere (in a developer message, user message, file, or project review guidelines appended below), those override these general instructions.

## Determining what to flag

Flag issues that:
1. Meaningfully impact the accuracy, performance, security, or maintainability of the code.
2. Are discrete and actionable (not general issues or multiple combined issues).
3. Don't demand rigor inconsistent with the rest of the codebase.
4. Were introduced in the changes being reviewed (not pre-existing bugs).
5. The author would likely fix if aware of them.
6. Don't rely on unstated assumptions about the codebase or author's intent.
7. Have provable impact on other parts of the code — it is not enough to speculate that a change may disrupt another part, you must identify the parts that are provably affected.
8. Are clearly not intentional changes by the author.
9. Be particularly careful with untrusted user input and follow the specific guidelines to review.
10. Treat silent local error recovery (especially parsing/IO/network fallbacks) as high-signal review candidates unless there is explicit boundary-level justification.
11. Violate the clean-code guidelines below.
12. Introduce error handling that conflicts with the fail-fast guidelines below.

## Clean-code guidelines

1. Check whether each newly added function duplicates existing functionality elsewhere in the codebase. Flag actual duplication and identify the existing implementation.
2. Flag one-off helper functions that add indirection without improving clarity or reuse (for example, \`isRecord\` or \`asString\`).
3. Flag abstractions introduced without a concrete need in the reviewed change, including wrappers created only for hypothetical future use.
4. Flag defensive checks or fallback behavior that mask programming errors, especially when callers already guarantee the relevant invariants.

## Untrusted User Input

1. Be careful with open redirects, they must always be checked to only go to trusted domains (?next_page=...)
2. Always flag SQL that is not parametrized
3. In systems with user supplied URL input, http fetches always need to be protected against access to local resources (intercept DNS resolver!)
4. Escape, don't sanitize if you have the option (eg: HTML escaping)

## Comment guidelines

1. Be clear about why the issue is a problem.
2. Communicate severity appropriately - don't exaggerate.
3. Be brief - at most 1 paragraph.
4. Keep code snippets under 3 lines, wrapped in inline code or code blocks.
5. Use \`\`\`suggestion blocks ONLY for concrete replacement code (minimal lines; no commentary inside the block). Preserve the exact leading whitespace of the replaced lines.
6. Explicitly state scenarios/environments where the issue arises.
7. Use a matter-of-fact tone - helpful AI assistant, not accusatory.
8. Write for quick comprehension without close reading.
9. Avoid excessive flattery or unhelpful phrases like "Great job...".

## Review priorities

1. Prefer simple, direct solutions over wrappers or abstractions without clear value.
2. Treat back pressure handling as critical to system stability.
3. Apply system-level thinking; flag changes that increase operational risk or on-call wakeups.
4. Ensure that errors are always checked against codes or stable identifiers, never error messages.

## Fail-fast error handling (strict)

When reviewing added or modified error handling, default to fail-fast behavior.

1. Evaluate every new or changed \`try/catch\`: identify what can fail and why local handling is correct at that exact layer.
2. Prefer propagation over local recovery. If the current scope cannot fully recover while preserving correctness, rethrow (optionally with context) instead of returning fallbacks.
3. Flag catch blocks that hide failure signals (e.g. returning \`null\`/\`[]\`/\`false\`, swallowing JSON parse failures, logging-and-continue, or “best effort” silent recovery).
4. JSON parsing/decoding should fail loudly by default. Quiet fallback parsing is only acceptable with an explicit compatibility requirement and clear tested behavior.
5. Boundary handlers (HTTP routes, CLI entrypoints, supervisors) may translate errors, but must not pretend success or silently degrade.
6. If a catch exists only to satisfy lint/style without real handling, treat it as a bug.
7. When uncertain, prefer crashing fast over silent degradation.

## Priority levels

Tag each finding with a priority level in the title:
- [P0] - Drop everything to fix. Blocking release/operations. Only for universal issues that do not depend on assumptions about inputs.
- [P1] - Urgent. Should be addressed in the next cycle.
- [P2] - Normal. To be fixed eventually.
- [P3] - Low. Nice to have.

## Output format

Provide your findings in a clear, structured format:
1. List each finding with its priority tag, file location, and explanation.
2. Findings must reference locations that overlap with the actual diff — don't flag pre-existing code.
3. Keep line references as short as possible (avoid ranges over 5-10 lines; pick the most suitable subrange).
4. Provide an overall verdict: "correct" (no blocking issues) or "needs attention" (has blocking issues).
5. Ignore trivial style issues unless they obscure meaning or violate documented standards.
6. Do not generate a full PR fix — only flag issues and optionally provide short suggestion blocks.

Output all findings the author would fix if they knew about them. If there are no qualifying findings, explicitly state the code looks good. Don't stop at the first finding - list every qualifying issue.`;

const REVIEW_SUMMARY_PROMPT = `We are leaving a code-review branch and returning to the main coding branch.
Create a structured handoff that can be used immediately to implement fixes.

You MUST summarize the review that happened in this branch so findings can be acted on.
Do not omit findings: include every actionable issue that was identified.

Required sections (in order):

## Review Scope
- What was reviewed (files/paths, changes, and scope)

## Verdict
- "correct" or "needs attention"

## Findings
For EACH finding, include:
- Priority tag ([P0]..[P3]) and short title
- File location (\`path/to/file.ext:line\`)
- Why it matters (brief)
- What should change (brief, actionable)

## Fix Queue
1. Ordered implementation checklist (highest priority first)

## Constraints & Preferences
- Any constraints or preferences mentioned during review
- Or "(none)"

Preserve exact file paths, function names, and error messages where available.`;

const REVIEW_FIX_FINDINGS_PROMPT = `Use the latest review summary in this session and implement the review findings now.

Instructions:
1. Treat the summary's Findings/Fix Queue as a checklist.
2. Fix in priority order: P0, P1, then P2 (include P3 if quick and safe).
3. If a finding is invalid/already fixed/not possible right now, briefly explain why and continue.
4. Follow fail-fast error handling: do not add local catch/fallback recovery unless this scope is an explicit boundary that can safely translate the failure.
5. If you add or keep a \`try/catch\`, explain the expected failure mode and either rethrow with context or return a boundary-safe error response.
6. JSON parsing/decoding should fail loudly by default; avoid silent fallback parsing.
7. Run relevant tests/checks for touched code where practical.
8. End with: fixed items, deferred/skipped items (with reasons), and verification results.`;

type ReviewState = { active: boolean; originId?: string };

function getReviewState(ctx: ExtensionContext): ReviewState | undefined {
	let state: ReviewState | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === REVIEW_STATE_TYPE) {
			state = entry.data as ReviewState;
		}
	}
	return state;
}

function updateWidget(ctx: ExtensionContext) {
	const active = getReviewState(ctx)?.active;
	ctx.ui.setWidget("review", active ? ["Review active — return with /end-review"] : undefined);
}

async function loadProjectReviewGuidelines(cwd: string): Promise<string | undefined> {
	let dir = path.resolve(cwd);
	while (true) {
		try {
			if ((await fs.stat(path.join(dir, ".pi"))).isDirectory()) break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
	try {
		return (await fs.readFile(path.join(dir, "REVIEW_GUIDELINES.md"), "utf8")).trim() || undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return undefined;
	}
}

export default function reviewExtension(pi: ExtensionAPI) {
	let navigating = false;
	const restore = (_event: unknown, ctx: ExtensionContext) => updateWidget(ctx);
	pi.on("session_start", restore);
	pi.on("session_tree", restore);

	pi.registerCommand("review", {
		description: "Review uncommitted changes",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/review requires interactive mode", "error");
				return;
			}
			if (navigating || !ctx.isIdle()) {
				ctx.ui.notify("Wait for the current operation to finish", "warning");
				return;
			}
			if (getReviewState(ctx)?.active) {
				ctx.ui.notify("Already in a review. Use /end-review first.", "warning");
				return;
			}
			navigating = true;
			const editorText = ctx.ui.getEditorText();
			try {
				if (args.trim().toLowerCase() !== "uncommitted") {
					ctx.ui.notify("Use /review uncommitted", "info");
					return;
				}
				const { code } = await pi.exec("git", ["rev-parse", "--git-dir"]);
				if (code !== 0) throw new Error("Not a git repository");
				const guidelines = await loadProjectReviewGuidelines(ctx.cwd);
				const firstUser = ctx.sessionManager.getBranch().find(
					(entry) => entry.type === "message" && entry.message.role === "user",
				);
				let useFreshSession = !ctx.sessionManager.getBranch().some((entry) => entry.type === "message");
				if (!useFreshSession) {
					const choice = await ctx.ui.select("Start review in:", ["Empty branch", "Current session"]);
					if (choice === undefined) return;
					useFreshSession = choice === "Empty branch";
				}
				if (useFreshSession) {
					// Anchor the exact return position, even at a user/custom message.
					pi.appendEntry(REVIEW_ANCHOR_TYPE, {});
					const originId = ctx.sessionManager.getLeafId()!;
					if (firstUser) {
						const result = await ctx.navigateTree(firstUser.id, { summarize: false });
						if (result.cancelled) {
							ctx.ui.setEditorText(editorText);
							return;
						}
					}
					pi.appendEntry(REVIEW_STATE_TYPE, { active: true, originId });
					updateWidget(ctx);
					ctx.ui.setEditorText("");
				}
				let prompt = `${REVIEW_RUBRIC}\n\n---\n\nPlease perform a code review with the following focus:\n\n${UNCOMMITTED_PROMPT}`;
				if (guidelines) prompt += `\n\nThis project has additional instructions for code reviews:\n\n${guidelines}`;
				pi.sendUserMessage(prompt);
			} catch (error) {
				ctx.ui.setEditorText(editorText);
				ctx.ui.notify(`Could not start review: ${error instanceof Error ? error.message : String(error)}`, "error");
			} finally {
				navigating = false;
			}
		},
	});

	pi.registerCommand("end-review", {
		description: "Return to the original conversation, optionally summarizing or fixing findings",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/end-review requires interactive mode", "error");
				return;
			}
			if (navigating || !ctx.isIdle()) {
				ctx.ui.notify("Wait for the current operation to finish", "warning");
				return;
			}
			const state = getReviewState(ctx);
			if (!state?.active || !state.originId) {
				ctx.ui.notify("Not in a review branch", "info");
				return;
			}
			navigating = true;
			try {
				const action = await ctx.ui.select("Finish review:", ["Return only", "Return and summarize", "Return and fix findings"]);
				if (!action) return;
				const originId = state.originId;
				const result = action === "Return only"
					? await ctx.navigateTree(originId, { summarize: false })
					: await ctx.ui.custom<Awaited<ReturnType<typeof ctx.navigateTree>> | { error: unknown }>((tui, theme, _keys, done) => {
						const loader = new BorderedLoader(tui, theme, "Returning and summarizing review...", { cancellable: false });
						// Keep the UI open until navigation finishes, including on failure.
						ctx.navigateTree(originId, {
							summarize: true, customInstructions: REVIEW_SUMMARY_PROMPT, replaceInstructions: true,
						}).then(done, (error: unknown) => done({ error }));
						return loader;
					});
				if ("error" in result) throw result.error;
				if (result.cancelled) return;
				pi.appendEntry(REVIEW_STATE_TYPE, { active: false });
				updateWidget(ctx);
				if (action === "Return and fix findings") pi.sendUserMessage(REVIEW_FIX_FINDINGS_PROMPT, { deliverAs: "followUp" });
				ctx.ui.notify("Review complete — returned to original conversation", "info");
			} catch (error) {
				ctx.ui.notify(`Could not end review: ${error instanceof Error ? error.message : String(error)}`, "error");
			} finally {
				navigating = false;
			}
		},
	});
}
