/**
 * Independent review on a separate conversation branch
 *
 * Usage in Pi:
 *   /review [request]           choose conversation context and start a review
 *   /review --fresh [request]   review without conversation history
 *   /end-review                 return, optionally summarizing or fixing findings
 *
 * The request defaults to "uncommitted changes".
 * Additional instructions are loaded from REVIEW_GUIDELINES.md if present.
 */

import {
	BorderedLoader,
	copyToClipboard,
	getAgentDir,
	TreeSelectorComponent,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { promises as fs } from "node:fs";
import path from "node:path";

const REVIEW_STATE_TYPE = "review-session";
const REVIEW_ANCHOR_TYPE = "review-anchor";

const REVIEW_INTRO = "Address the above review request. Evaluate correctness, elegance, and consistency: internally, with the surrounding material, and with applicable project guidance.";

const REVIEW_CONTEXT = "Work may have progressed outside this conversation. Use the preceding conversation for requirements and background, not as evidence of the current state of the reviewed material.";

const REVIEW_PROMPT = `Consider accuracy, performance, security, and maintainability where relevant. Assess whether the complexity is appropriate to the task, avoiding both oversimplification and overengineering.

Where applicable, assume relevant checks and tests have already run successfully. Avoid redundant runs, but use targeted experiments when useful. Still inspect whether tests adequately cover changed behavior.

Clarify the review scope when needed. Inspect local files and version control history as needed; ask if the scope is genuinely ambiguous. Do not modify the reviewed files or repository state. You may modify and compile temporary copies or perform other experiments outside the working tree. Review only.

Report concrete defects and worthwhile simplifications, distinguishing correctness issues from design improvements. Explain why each matters, with precise file locations where applicable. Prefer simple, direct solutions. For a change review, focus on issues introduced by those changes.

List findings in order of importance, then give a brief overall assessment. If there are no worthwhile findings, say so. Do not produce a fix or a boilerplate checklist.`;

const SUMMARY_PROMPT = `Summarize the review for the original conversation.
State the reviewed scope and overall assessment. Preserve every actionable finding, including its importance, exact file location where applicable, explanation, and suggested change. Distinguish correctness defects from design improvements. Include any relevant constraints or unresolved questions. Be concise; do not invent findings or turn observations into mandatory fixes.`;

const FIX_PROMPT = `Act on the review findings in the latest review summary. Address correctness issues first, then worthwhile design improvements. If a finding is invalid or requires a decision, explain rather than blindly applying it. Stay within the reviewed scope and project conventions. Run relevant checks after making changes, and summarize changes, deferred findings, and verification.`;

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

function parseArgs(args: string): { scope: string; fresh: boolean } {
	const request = args.trim();
	const first = request.split(/\s/, 1)[0];
	const fresh = first === "--fresh";
	if (!fresh && first.startsWith("--")) throw new Error(`Unknown /review option: ${first}`);
	const scope = fresh ? request.slice(first.length).trim() : request;
	return { scope: scope || "uncommitted changes", fresh };
}

async function loadReviewGuidelines(cwd: string): Promise<string | undefined> {
	const ancestors: string[] = [];
	let dir = path.resolve(cwd);
	while (true) {
		ancestors.unshift(dir);
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	const guidelines: string[] = [];
	for (const directory of new Set([getAgentDir(), ...ancestors])) {
		const file = path.join(directory, "REVIEW_GUIDELINES.md");
		try {
			const content = (await fs.readFile(file, "utf8")).trim();
			if (content) guidelines.push(`Review guidelines from ${file}:\n\n${content}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return guidelines.length ? guidelines.join("\n\n") : undefined;
}

async function selectContext(ctx: ExtensionCommandContext, pi: ExtensionAPI, scope: string): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => {
		const selector = new TreeSelectorComponent(
			ctx.sessionManager.getTree(), ctx.sessionManager.getLeafId(),
			Math.max(8, tui.terminal.rows - 6), done, () => done(undefined),
			(entryId, label) => pi.setLabel(entryId, label), undefined, pi.getSettings().treeFilterMode,
		);
		selector.onCopy = async (text) => {
			if (!text) {
				ctx.ui.notify("Selected entry has no text to copy", "error");
				return;
			}
			try {
				await copyToClipboard(text);
				ctx.ui.notify("Copied to clipboard", "info");
			} catch (error) {
				ctx.ui.notify(`Could not copy: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		};
		const container = new Container();
		container.addChild(new Text(`Review ${theme.bold(scope)}`, 0, 0));
		container.addChild(selector);
		return {
			get focused() { return selector.focused; },
			set focused(value: boolean) { selector.focused = value; },
			get capturesViewportInput() { return selector.capturesViewportInput; },
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => selector.handleInput(data),
		};
	});
}

export default function reviewExtension(pi: ExtensionAPI) {
	let navigating = false;
	const restore = (_event: unknown, ctx: ExtensionContext) => updateWidget(ctx);
	pi.on("session_start", restore);
	pi.on("session_tree", restore);

	pi.registerCommand("review", {
		description: "Review a local scope with selected context; --fresh skips selection",
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
				const { scope, fresh } = parseArgs(args);
				const guidelines = await loadReviewGuidelines(ctx.cwd);
				const firstUser = ctx.sessionManager.getBranch().find(
					(entry) => entry.type === "message" && entry.message.role === "user",
				);
				const target = fresh ? firstUser?.id : firstUser ? await selectContext(ctx, pi, scope) : undefined;
				if (!fresh && firstUser && !target) return;

				// A custom anchor makes the exact return position navigable even if the
				// current leaf is a user/custom message (which Pi navigates *before*).
				pi.appendEntry(REVIEW_ANCHOR_TYPE, {});
				const originId = ctx.sessionManager.getLeafId()!;
				if (target) {
					const result = await ctx.navigateTree(target, { summarize: false });
					if (result.cancelled) {
						ctx.ui.setEditorText(editorText);
						return;
					}
				}
				pi.appendEntry(REVIEW_STATE_TYPE, { active: true, originId });
				updateWidget(ctx);
				ctx.ui.setEditorText("");
				let prompt = `Review: ${scope}\n\n${REVIEW_INTRO}`;
				if (!fresh && target) prompt += `\n\n${REVIEW_CONTEXT}`;
				prompt += `\n\n${REVIEW_PROMPT}`;
				if (guidelines) prompt += `\n\n${guidelines}`;
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
							summarize: true, customInstructions: SUMMARY_PROMPT, replaceInstructions: true,
						}).then(done, (error: unknown) => done({ error }));
						return loader;
					});
				if ("error" in result) throw result.error;
				if (result.cancelled) return;
				pi.appendEntry(REVIEW_STATE_TYPE, { active: false });
				updateWidget(ctx);
				if (action === "Return and fix findings") pi.sendUserMessage(FIX_PROMPT, { deliverAs: "followUp" });
				ctx.ui.notify("Review complete — returned to original conversation", "info");
			} catch (error) {
				ctx.ui.notify(`Could not end review: ${error instanceof Error ? error.message : String(error)}`, "error");
			} finally {
				navigating = false;
			}
		},
	});
}
