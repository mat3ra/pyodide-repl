import { PYODIDE_INDEX_URL } from "../environment/pyodideCdn";
import type { Pyodide, PyodideEnvironmentSpec } from "../session/PyodideSession";
import { PyodideSession } from "../session/PyodideSession";

/**
 * The global the host's `beforeRunCode` reads: a JSON string of whatever the host returned as
 * `data` from its last `get-data` reply. A string rather than a live object on purpose — it crosses
 * the JS/Python boundary as plain text, so no proxy semantics leak into the host's Python.
 */
export const DATA_FROM_HOST_GLOBAL = "data_from_host_json";

/** Which packages to install, and from where. Data only — no code, no domain knowledge. */
export interface ReplEnvironmentConfig {
    /** Defaults to this package's pinned Pyodide CDN build. */
    indexUrl?: string;
    /** Pyodide's own builds, loaded first (e.g. `numpy`, `scipy`). */
    loadPackages?: string[];
    /** PyPI requirements installed with their dependencies. */
    pypiPinnedPackages?: string[];
    /** Prebuilt wheels resolved against {@link wheelBaseUrl} and installed WITHOUT dependencies. */
    wheelFilenames?: string[];
    /** Any origin that serves the wheels with CORS headers. */
    wheelBaseUrl?: string;
    /** Installed after the wheels, when their pinned dependencies are already satisfied. */
    postWheelPackages?: string[];
}

/**
 * Everything a host tells this REPL about its domain. The page has no domain knowledge of its own:
 * the host supplies the packages to install and the Python that binds its data in and reads results
 * back out, so the same deployed page serves any host.
 */
export interface ReplHostConfig {
    environment?: ReplEnvironmentConfig;
    /** Python run once after the environment is built: imports, helper definitions. */
    setupCode?: string;
    /**
     * Python run before every user run, with {@link DATA_FROM_HOST_GLOBAL} in scope. This is where
     * a host turns its data into the variables its users expect.
     */
    beforeRunCode?: string;
    /**
     * Python run after every user run — including a failed one, since code that raised halfway may
     * still have produced results. Whatever it evaluates to is sent to the host as `set-data`; a
     * JSON string is parsed first, so the host receives the object its Python built.
     */
    afterRunCode?: string;
    /** Starting editor content. */
    defaultCode?: string;
}

/** How the page reaches its host. Implemented by HostConnection; an interface so this is testable. */
export interface ReplHostChannel {
    requestFromHost(): Promise<{ config?: ReplHostConfig; data?: unknown }>;
    sendToHost(payload: object): void;
}

/**
 * Turn a host's config into a session. The three Python snippets become the session's lifecycle
 * callbacks — which is the whole of the page's domain awareness: it runs the host's code, it does
 * not contain any.
 */
export function createSessionFromConfig(
    config: ReplHostConfig,
    host: ReplHostChannel,
): PyodideSession {
    const { setupCode, beforeRunCode, afterRunCode } = config;

    const spec: PyodideEnvironmentSpec = {
        ...config.environment,
        indexUrl: config.environment?.indexUrl || PYODIDE_INDEX_URL,

        setupNamespace: setupCode
            ? async (pyodide: Pyodide, log: (message: string) => void) => {
                  log("Preparing the host's namespace…");
                  await pyodide.runPythonAsync(setupCode);
              }
            : undefined,

        beforeRun: async (pyodide: Pyodide) => {
            // Asked every run, not cached: the host's data changes while the page stays open.
            const { data } = await host.requestFromHost();
            pyodide.globals.set(DATA_FROM_HOST_GLOBAL, JSON.stringify(data ?? null));
            if (beforeRunCode) await pyodide.runPythonAsync(beforeRunCode);
        },

        afterRun: afterRunCode
            ? async (pyodide: Pyodide) => {
                  const result = await pyodide.runPythonAsync(afterRunCode);
                  if (result === undefined || result === null) return;
                  const payload = typeof result === "string" ? JSON.parse(result) : result;
                  if (payload && typeof payload === "object") host.sendToHost(payload as object);
              }
            : undefined,
    };

    return new PyodideSession(spec);
}
