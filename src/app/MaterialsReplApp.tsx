import React, { useMemo } from "react";

import HostConnection from "../bridge/HostConnection";
import {
    BIND_MATERIALS_SNIPPET,
    MADE_ENVIRONMENT_SPEC,
    MATERIALS_PREAMBLE,
} from "../environment/madeProfile";
import { PyodideSession } from "../session/PyodideSession";
import PythonRepl from "../ui/PythonRepl";

/** The scope tag every REPL-produced material carries; the host's merge rule keys on it. */
export const REPL_SYNC_SCOPE = "python-repl";

const DEFAULT_CODE = `# materials_in = the host's material list, material = the selected one.
# mat3ra.made.tools helpers are pre-imported. Shift+Enter to run.
supercell = create_supercell(materials_in[0], scaling_factor=[2, 2, 1])`;

/**
 * The materials REPL page: a {@link PyodideSession} on the `made` environment, connected to
 * whatever host embeds this page over the JupyterLite-style data bridge.
 *
 * Before every run the host's materials are requested and bound as `materials_in` / `material`;
 * after every run — successful or not, since code that raised halfway may still have produced
 * materials — every public `Material` binding is sent back under {@link REPL_SYNC_SCOPE}.
 * Opened standalone (no embedding host), the request times out and `materials_in` is empty.
 */
function MaterialsReplApp() {
    const session = useMemo(() => {
        const hostConnection = new HostConnection();
        return new PyodideSession({
            ...MADE_ENVIRONMENT_SPEC,
            setupNamespace: async (pyodide, log) => {
                log("Preparing material namespace…");
                await pyodide.runPythonAsync(MATERIALS_PREAMBLE);
                log("Environment ready. Type to autocomplete.");
            },
            beforeRun: async (pyodide) => {
                const { entityConfigs, selectedIndex } = await hostConnection.requestEntities();
                pyodide.globals.set("_md_materials_json", JSON.stringify(entityConfigs));
                pyodide.globals.set("_md_selected_index", selectedIndex);
                await pyodide.runPythonAsync(BIND_MATERIALS_SNIPPET);
            },
            afterRun: async (pyodide) => {
                const entitiesJson = (await pyodide.runPythonAsync(
                    "__md_scan_materials()",
                )) as string;
                hostConnection.sendScopedSync({
                    syncScope: REPL_SYNC_SCOPE,
                    entities: JSON.parse(entitiesJson),
                });
            },
        });
    }, []);

    return <PythonRepl session={session} show defaultCode={DEFAULT_CODE} />;
}

export default MaterialsReplApp;
