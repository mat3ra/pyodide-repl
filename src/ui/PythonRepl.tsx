import { showErrorAlert } from "@mat3ra/cove/dist/other/alerts";
import CodeMirror, { type CodeMirrorProps } from "@mat3ra/cove/dist/other/codemirror/CodeMirror";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Stack from "@mui/material/Stack";
import { useTheme } from "@mui/material/styles";
import Typography from "@mui/material/Typography";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { makePythonCompletionSource } from "../completions/pythonCompletions";
import type { PythonError, PythonSessionInterface } from "../session/PyodideSession";
import ReplConsole from "./ReplConsole";

export enum ReplStatus {
    Loading = "loading",
    Ready = "ready",
    Running = "running",
    Error = "error",
}

const STATUS_LABEL: Record<ReplStatus, string> = {
    [ReplStatus.Loading]: "Preparing Python environment…",
    [ReplStatus.Ready]: "Ready",
    [ReplStatus.Running]: "Running…",
    [ReplStatus.Error]: "Error",
};

const EDITOR_MIN_HEIGHT = 80;

export interface PythonReplProps {
    session: PythonSessionInterface;
    /** Bootstraps on first `true` unless {@link preload} starts it earlier. */
    show: boolean;
    /** Prepare in the background before the panel opens. Useful for expensive browser runtimes. */
    preload?: boolean;
    defaultCode?: string;
    onReady?: () => void;
    onBeforeRun?: () => void;
    onRunSuccess?: () => void;
}

/**
 * Knows nothing about what the session's namespace contains — domain wiring goes through the
 * session's own callbacks. Fills whatever height its parent gives it.
 */
function PythonRepl({
    session,
    show,
    preload = false,
    defaultCode = "",
    onReady,
    onBeforeRun,
    onRunSuccess,
}: PythonReplProps) {
    const theme = useTheme();
    const [status, setStatus] = useState<ReplStatus>(ReplStatus.Loading);
    const [code, setCode] = useState<string>(defaultCode);
    const [output, setOutput] = useState<string>("");
    const [error, setError] = useState<PythonError | null>(null);

    const completionSource = useMemo(() => makePythonCompletionSource(session), [session]);

    // A ref, not effect deps: an unmemoized callback would otherwise restart the load and wipe output.
    const callbacksRef = useRef({ onReady, onBeforeRun, onRunSuccess });
    callbacksRef.current = { onReady, onBeforeRun, onRunSuccess };

    useEffect(() => {
        if (!show && !preload) return undefined;
        let cancelled = false;
        (async () => {
            try {
                setOutput("");
                // Stream bootstrap steps so the long first load looks alive.
                await session.load((message) => {
                    if (!cancelled) setOutput((previous) => `${previous}${message}\n`);
                });
                if (cancelled) return;
                callbacksRef.current.onReady?.();
                setStatus(ReplStatus.Ready);
            } catch (loadError) {
                if (cancelled) return;
                setStatus(ReplStatus.Error);
                const message = loadError instanceof Error ? loadError.message : String(loadError);
                // Into the console pane too: the alert is transient and the load failure is the
                // one error a user must be able to read after the fact.
                setOutput((previous) => `${previous}${message}\n`);
                showErrorAlert(message);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [preload, show, session]);

    const runCode = useCallback(async () => {
        if (!session.isInitialized || session.isRunning) return;
        setStatus(ReplStatus.Running);
        setError(null);
        try {
            callbacksRef.current.onBeforeRun?.();
            const { output: runOutput, ok, error: runError } = await session.execute(code);
            if (runOutput) setOutput((previous) => previous + runOutput);
            if (ok) {
                callbacksRef.current.onRunSuccess?.();
                setStatus(ReplStatus.Ready);
            } else {
                setError(runError);
                setStatus(ReplStatus.Error);
            }
        } catch (runFailure) {
            // Infra-level failure (not a user Python error, which the runner captures structurally).
            setStatus(ReplStatus.Error);
            const message = runFailure instanceof Error ? runFailure.message : String(runFailure);
            setOutput((previous) => `${previous}${message}\n`);
            showErrorAlert(message);
        }
    }, [code, session]);

    const isBusy = status === ReplStatus.Loading || status === ReplStatus.Running;

    return (
        <Box
            id="python-repl"
            sx={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}
            // Capture phase so we intercept Shift/Cmd/Ctrl+Enter BEFORE CodeMirror inserts a newline.
            onKeyDownCapture={(event) => {
                if (event.key === "Enter" && (event.shiftKey || event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    event.stopPropagation();
                    runCode();
                }
            }}>
            <Stack
                direction="row"
                alignItems="center"
                spacing={1}
                sx={{ p: 1, borderBottom: `1px solid ${theme.palette.grey[800]}` }}>
                <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
                    Python REPL
                </Typography>
                {status === ReplStatus.Loading && <CircularProgress size={16} />}
                <Chip
                    size="small"
                    variant="outlined"
                    color={status === ReplStatus.Error ? "error" : "default"}
                    label={STATUS_LABEL[status]}
                />
                <Button
                    id="python-repl-run"
                    size="small"
                    variant="contained"
                    color="success"
                    disabled={isBusy}
                    onClick={runCode}
                    title="Run (Shift+Enter)">
                    Run
                </Button>
            </Stack>
            <Box sx={{ flex: "1 1 auto", minHeight: EDITOR_MIN_HEIGHT, overflowY: "auto" }}>
                <CodeMirror
                    content={code}
                    updateContent={setCode}
                    options={{ lineNumbers: true }}
                    theme={theme.palette.mode}
                    language="python"
                    // `completions` is typed non-nullable there, but a CM6 source may return null.
                    completions={completionSource as CodeMirrorProps["completions"]}
                />
            </Box>
            {/* matplotlib target, per https://github.com/pyodide/matplotlib-pyodide */}
            <Box id="pyodide-plot-target-repl" />
            <ReplConsole
                output={output}
                error={error}
                onClear={() => {
                    setOutput("");
                    setError(null);
                }}
            />
        </Box>
    );
}

export default PythonRepl;
