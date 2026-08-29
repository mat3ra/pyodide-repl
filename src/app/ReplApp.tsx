import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import React, { useEffect, useMemo, useState } from "react";

import HostConnection from "../bridge/HostConnection";
import { type ReplHostConfig, createSessionFromConfig } from "../config/hostConfig";
import type { PyodideSession } from "../session/PyodideSession";
import PythonRepl from "../ui/PythonRepl";

const STANDALONE_DEFAULT_CODE = `# A Python REPL in the browser. Shift+Enter to run.
import sys
print(sys.version)`;

/**
 * The embeddable page. It asks its host for configuration first — which packages to install and
 * which Python to run around each run — and builds the session from the answer, so one deployed
 * page serves any host. Opened directly, the request times out and it runs as a bare Python REPL.
 */
function ReplApp() {
    const hostConnection = useMemo(() => new HostConnection(), []);
    const [session, setSession] = useState<PyodideSession | null>(null);
    const [config, setConfig] = useState<ReplHostConfig>({});

    useEffect(() => {
        let cancelled = false;
        hostConnection.requestFromHost().then((reply) => {
            if (cancelled) return;
            const hostConfig = reply.config ?? {};
            setConfig(hostConfig);
            setSession(createSessionFromConfig(hostConfig, hostConnection));
        });
        return () => {
            cancelled = true;
        };
    }, [hostConnection]);

    if (!session) {
        return (
            <Stack
                direction="row"
                alignItems="center"
                justifyContent="center"
                spacing={1}
                sx={{ height: "100%" }}>
                <CircularProgress size={18} />
                <Typography color="text.secondary">Connecting to the host…</Typography>
            </Stack>
        );
    }

    return (
        <Box sx={{ height: "100%" }}>
            <PythonRepl
                session={session}
                show
                defaultCode={config.defaultCode ?? STANDALONE_DEFAULT_CODE}
            />
        </Box>
    );
}

export default ReplApp;
