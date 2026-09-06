import React, { useMemo } from "react";

import { PYODIDE_INDEX_URL } from "../environment/pyodideCdn";
import { PyodideSession } from "../session/PyodideSession";
import PythonRepl from "../ui/PythonRepl";

const DEFAULT_CODE = `# A Python REPL in the browser. Shift+Enter to run.
import sys
print(sys.version)`;

/**
 * The bare REPL page: the interpreter with the standard library and a persistent namespace.
 * Domain environments (packages, host data binding) plug in through the session's spec callbacks —
 * the materials environment arrives in the next PR of this chain.
 */
function ReplApp() {
    const session = useMemo(() => new PyodideSession({ indexUrl: PYODIDE_INDEX_URL }), []);
    return <PythonRepl session={session} show defaultCode={DEFAULT_CODE} />;
}

export default ReplApp;
