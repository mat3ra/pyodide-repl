import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";

/** Same stack cove's theme uses; its `commonSettings` is not exported from the published build. */
const MONOSPACE_FONT_FAMILY = 'Menlo, Monaco, Consolas, "Courier New", monospace';

/**
 * Bounds for the signature/docstring popup. A docstring can run to hundreds of lines, so the node has
 * to be capped and scrollable or it covers the whole editor.
 */
const INFO_POPUP_MAX_WIDTH = "460px";

const INFO_POPUP_MAX_HEIGHT = "320px";

/** Divider between signature and docstring. Grey-on-alpha so it reads on either theme — see buildInfoNode. */
const INFO_POPUP_DIVIDER_COLOR = "rgba(128, 128, 128, 0.3)";

/**
 * CodeMirror ranks by `boost` (-99..99) before its own fuzzy score. Keyword arguments for the call the
 * cursor sits inside are the single most likely thing the user wants, so they take the top of the range
 * and everything else stays at the neutral default.
 */
const KEYWORD_ARGUMENT_BOOST = 99;

const DEFAULT_BOOST = 0;

/** Map Jedi's completion kind to a CodeMirror completion type (drives the popup icon). */
const JEDI_TYPE_TO_CODEMIRROR_TYPE = {
    module: "namespace",
    class: "class",
    instance: "variable",
    function: "function",
    method: "method",
    property: "property",
    param: "property",
    path: "text",
    keyword: "keyword",
    statement: "variable",
} as const;

export type JediCompletionType = keyof typeof JEDI_TYPE_TO_CODEMIRROR_TYPE;

export type CodeMirrorCompletionType =
    (typeof JEDI_TYPE_TO_CODEMIRROR_TYPE)[keyof typeof JEDI_TYPE_TO_CODEMIRROR_TYPE];

export interface PythonCompletion {
    name: string;
    /** Whatever kind the Python side reported — hence the fallback in jediTypeToCodeMirrorType. */
    type: string;
}

/** On-demand signature + docstring for a highlighted completion. */
export interface PythonSignatureInfo {
    signature: string;
    docstring: string;
}

/** An interface so the source is testable with a fake, and any Python runtime can back it. */
export interface PythonCompletionBackend {
    isInitialized: boolean;
    complete(source: string, line: number, column: number): PythonCompletion[];
    describe(
        source: string,
        line: number,
        column: number,
        name: string,
    ): PythonSignatureInfo | null;
}

export function jediTypeToCodeMirrorType(type: string): CodeMirrorCompletionType {
    return JEDI_TYPE_TO_CODEMIRROR_TYPE[type as JediCompletionType] ?? "variable";
}

/**
 * `mat3ra.made.material.Material` → `Material`, so long typed signatures stay readable. Only
 * identifier runs collapse, so `10.0` and `Tuple[int, int, int]` are untouched. Exported for tests.
 */
export function shortenQualifiedNames(text: string): string {
    return text.replace(/(?:[A-Za-z_]\w*\.)+([A-Za-z_]\w*)/g, "$1");
}

/**
 * Hand-rolled DOM, not a React component, because CodeMirror's `info` contract wants a detached node
 * it mounts itself — there is no React tree here, and the node lives outside our ThemeProvider, so
 * inline styles are the only ones that apply.
 */
export function buildInfoNode(info: PythonSignatureInfo | null): HTMLElement | null {
    if (!info || (!info.signature && !info.docstring)) return null;
    const root = document.createElement("div");
    root.style.maxWidth = INFO_POPUP_MAX_WIDTH;
    root.style.maxHeight = INFO_POPUP_MAX_HEIGHT;
    root.style.overflow = "auto";

    if (info.signature) {
        const signatureNode = document.createElement("div");
        signatureNode.textContent = shortenQualifiedNames(info.signature);
        signatureNode.style.fontFamily = MONOSPACE_FONT_FAMILY;
        signatureNode.style.fontSize = "0.85em";
        signatureNode.style.whiteSpace = "pre-wrap";
        signatureNode.style.wordBreak = "break-word";
        if (info.docstring) {
            signatureNode.style.marginBottom = "6px";
            signatureNode.style.paddingBottom = "6px";
            signatureNode.style.borderBottom = `1px solid ${INFO_POPUP_DIVIDER_COLOR}`;
        }
        root.appendChild(signatureNode);
    }
    if (info.docstring) {
        const docstringNode = document.createElement("div");
        docstringNode.textContent = info.docstring;
        docstringNode.style.whiteSpace = "pre-wrap";
        root.appendChild(docstringNode);
    }
    return root;
}

/**
 * Completes at the cursor against the LIVE namespace, so the user's own variables show up too.
 * Signature/docstring are deferred to the `info` callback to keep typing responsive.
 */
export function makePythonCompletionSource(backend: PythonCompletionBackend) {
    return (context: CompletionContext): CompletionResult | null => {
        if (!backend.isInitialized) return null;

        const fragment = context.matchBefore(/\w*/);
        if (!fragment) return null;
        // Suppress the popup on an empty prefix unless the char before is `.` (attribute access) or
        // the user explicitly asked (Ctrl+Space).
        const previousCharacter =
            fragment.from > 0
                ? context.state.doc.sliceString(fragment.from - 1, fragment.from)
                : "";
        if (fragment.from === fragment.to && previousCharacter !== "." && !context.explicit)
            return null;

        const source = context.state.doc.toString();
        const lineInfo = context.state.doc.lineAt(context.pos);
        const line = lineInfo.number; // Jedi lines are 1-based
        const column = context.pos - lineInfo.from; // columns 0-based

        let completions: PythonCompletion[];
        try {
            completions = backend.complete(source, line, column);
        } catch {
            return null;
        }
        if (!completions.length) return null;

        const options: Completion[] = completions.map((completion) => {
            const isKeywordArgument = completion.type === "param";
            return {
                label: completion.name,
                type: jediTypeToCodeMirrorType(completion.type),
                detail: completion.type,
                // Rank the current call's keyword args above everything else, and complete them as
                // `name=` so the user lands ready to type the value (IDE-style).
                boost: isKeywordArgument ? KEYWORD_ARGUMENT_BOOST : DEFAULT_BOOST,
                apply: isKeywordArgument ? `${completion.name}=` : undefined,
                info: () => buildInfoNode(backend.describe(source, line, column, completion.name)),
            };
        });
        return { from: fragment.from, options, validFor: /^\w*$/ };
    };
}
