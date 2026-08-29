import { PY_DEFINE_RUNNER } from "./pythonSnippets";

// Pyodide has no published types; use `any` until they are available upstream (see PyodideLoader).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Pyodide = any;

/** Jupyter/nbformat error shape, so a UI can render `ename: evalue` + traceback distinctly. */
export interface PythonError {
    ename: string;
    evalue: string;
    traceback: string;
}

export interface PythonExecutionResult {
    ok: boolean;
    output: string;
    error: PythonError | null;
}

export interface PyodideEnvironmentSpec {
    /**
     * Pyodide CDN base, passed to `loadPyodide` as `indexURL` EXPLICITLY. Always pass this rather than
     * relying on Pyodide's own `calculateIndexURL()`: a bundler that defines `__dirname` (e.g. Vite
     * with `define: { __dirname }`) makes that resolve to an absolute filesystem path, and Pyodide
     * then fetches `pyodide.asm.js` from a URL that does not exist.
     */
    indexUrl: string;
    loadPackages?: string[];
    pypiPinnedPackages?: string[];
    /** Prebuilt wheels, resolved against {@link wheelBaseUrl} and installed `deps=False`. */
    wheelFilenames?: string[];
    /** Installed AFTER the wheels — order matters. */
    postWheelPackages?: string[];
    wheelBaseUrl?: string;
    wheelFsDir?: string;

    /**
     * Domain setup, run once after the environment is built and before the session reports itself
     * initialized. This is where a caller imports its own preamble or installs extra packages.
     */
    setupNamespace?: (pyodide: Pyodide, log: (message: string) => void) => Promise<void> | void;
    /** Runs before each {@link PyodideSession.execute}, e.g. to push host data into the namespace. */
    beforeRun?: (pyodide: Pyodide) => Promise<void> | void;
    /**
     * Runs after user code, successful or not, while the persistent namespace is still current —
     * e.g. to read results back out. Deliberately also runs for a failed run: code that raised
     * halfway may still have produced results worth syncing.
     */
    afterRun?: (pyodide: Pyodide) => Promise<void> | void;
}

export interface PythonSessionInterface {
    isInitialized: boolean;
    isRunning: boolean;
    load(onProgress?: (message: string) => void): Promise<void>;
    execute(code: string): Promise<PythonExecutionResult>;
}

let scriptLoadPromise: Promise<void> | null = null;

function injectScriptOnce(src: string): Promise<void> {
    if (scriptLoadPromise) return scriptLoadPromise;
    scriptLoadPromise = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = src;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Failed to load script ${src}`));
        document.body.appendChild(script);
    });
    return scriptLoadPromise;
}

let sessionOwningTheInterpreter: PyodideSession | null = null;

/**
 * Claim the page's interpreter for `session`, or throw if someone else already holds it. Module-level
 * rather than methods, because the state being guarded belongs to the module (there is one per page),
 * not to any single instance.
 */
function claimInterpreter(session: PyodideSession): void {
    if (sessionOwningTheInterpreter && sessionOwningTheInterpreter !== session) {
        throw new Error(
            "PyodideSession: an interpreter is already owned by another session. " +
                "There is one Pyodide per page and its packages/globals are shared — " +
                "use a single session instance instead of constructing a second one.",
        );
    }
    sessionOwningTheInterpreter = session;
}

function releaseInterpreter(session: PyodideSession): void {
    if (sessionOwningTheInterpreter === session) sessionOwningTheInterpreter = null;
}

/**
 * Runs code in a PERSISTENT namespace, so it behaves like a REPL rather than a series of one-shot
 * scripts. Domain setup is passed in as {@link PyodideEnvironmentSpec.setupNamespace} /
 * `beforeRun` / `afterRun` rather than subclassed, so a caller's wiring reads in one place and this
 * class keeps no protected surface for another package to depend on. A completion backend can be
 * layered on by an environment that installs one (see the completions PR in this chain).
 *
 * Browser-side there can be only one live instance — see {@link sessionOwningTheInterpreter}.
 */
export class PyodideSession implements PythonSessionInterface {
    private pyodide: Pyodide = null;

    private initialized = false;

    private running = false;

    private outputBuffer = "";

    private spec: PyodideEnvironmentSpec;

    constructor(spec: PyodideEnvironmentSpec) {
        this.spec = { wheelFsDir: "/tmp/pyodide_wheels", ...spec };
    }

    get isInitialized(): boolean {
        return this.initialized;
    }

    get isRunning(): boolean {
        return this.running;
    }

    /** Point wheel fetches at a host app's own server. Must precede {@link load}. */
    setWheelBaseUrl(wheelBaseUrl: string): void {
        if (this.initialized) {
            throw new Error("PyodideSession: wheel base URL cannot change after initialization.");
        }
        this.spec.wheelBaseUrl = wheelBaseUrl.replace(/\/$/, "");
    }

    /**
     * Set the prebuilt wheels to install. Separate from the constructor because a caller often only
     * learns the filenames after fetching its own manifest. Must precede {@link load}.
     */
    setWheelFilenames(wheelFilenames: string[]): void {
        if (this.initialized) {
            throw new Error("PyodideSession: wheel filenames cannot change after initialization.");
        }
        this.spec.wheelFilenames = wheelFilenames;
    }

    /** Idempotent; reuses a cached `window.pyodide`. Browser-only (touches window/document). */
    async load(onProgress?: (message: string) => void): Promise<void> {
        if (this.initialized) return;
        onProgress?.("Loading Pyodide runtime from CDN…");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const globalWindow = window as any;
        if (!globalWindow.pyodide) {
            if (typeof globalWindow.loadPyodide !== "function") {
                await injectScriptOnce(`${this.spec.indexUrl}pyodide.js`);
            }
            globalWindow.pyodide = await globalWindow.loadPyodide({
                indexURL: this.spec.indexUrl,
            });
        }
        await this.initialize(globalWindow.pyodide, onProgress);
    }

    /** Takes an already-loaded Pyodide so a Node test can inject one. Idempotent. */
    async initialize(pyodide: Pyodide, onProgress?: (message: string) => void): Promise<void> {
        if (this.initialized) return;
        claimInterpreter(this);
        this.pyodide = pyodide;
        const log = (message: string) => onProgress?.(message);

        // stdout/stderr -> buffer, per https://pyodide.org/en/stable/usage/streams.html
        const appendOutput = (text: string) => {
            this.outputBuffer += `${text}\n`;
        };
        pyodide.setStdout({ batched: appendOutput });
        pyodide.setStderr({ batched: appendOutput });

        const { loadPackages = [], pypiPinnedPackages = [], postWheelPackages = [] } = this.spec;

        log("Loading base packages…");
        await pyodide.loadPackage(["micropip", ...loadPackages]);
        const micropip = pyodide.pyimport("micropip");

        // Sequential: order matters. Logging before each install is what makes the wait legible.
        const installInOrder = (specs: string[], deps: boolean, label: string): Promise<void> =>
            specs.reduce((previous, spec, index) => {
                const name = spec.split("/").pop() || spec;
                return previous.then(() => {
                    log(`${label} (${index + 1}/${specs.length}): ${name}`);
                    return micropip.install.callKwargs(spec, { deps });
                });
            }, Promise.resolve());

        await installInOrder(pypiPinnedPackages, true, "Installing dependency");
        await this.installWheels(micropip, log);
        await installInOrder(postWheelPackages, true, "Installing package");

        pyodide.runPython(PY_DEFINE_RUNNER);
        await this.spec.setupNamespace?.(this.pyodide, log);
        this.initialized = true;
    }

    /**
     * Fetch each wheel ourselves and install it from Pyodide's virtual FS via `emfs:` — NOT by handing
     * micropip the HTTP URL directly. A static file server serves these with an ETag; on a repeat page
     * load the browser sends a conditional request and gets a 304 with an EMPTY body, which micropip
     * then tries to unzip -> `BadZipFile: File is not a zip file`. Fetching ourselves lets the
     * browser resolve a cached response to a complete body before we write it to the virtual FS.
     * Wheel filenames contain versions, so keeping them in the browser cache is safe and makes
     * repeat environment loads substantially cheaper.
     */
    private async fetchWheel(filename: string): Promise<string> {
        const { wheelBaseUrl, wheelFsDir } = this.spec;
        if (!wheelBaseUrl) {
            throw new Error("PyodideSession: wheel filenames given without a wheelBaseUrl.");
        }
        this.pyodide.FS.mkdirTree(wheelFsDir);
        const response = await fetch(`${wheelBaseUrl}/${filename}`, { cache: "force-cache" });
        if (!response.ok) {
            throw new Error(`Failed to fetch wheel ${filename}: HTTP ${response.status}`);
        }
        const fsPath = `${wheelFsDir}/${filename}`;
        this.pyodide.FS.writeFile(fsPath, new Uint8Array(await response.arrayBuffer()));
        return fsPath;
    }

    /** Make wheels available to a caller's own installer without installing them here. */
    async stageWheels(
        wheelFilenames: string[],
        log: (message: string) => void = () => undefined,
    ): Promise<void> {
        await Promise.all(
            wheelFilenames.map(async (filename, index) => {
                log(`Staging wheel (${index + 1}/${wheelFilenames.length}): ${filename}`);
                await this.fetchWheel(filename);
            }),
        );
    }

    private async installWheels(micropip: Pyodide, log: (message: string) => void): Promise<void> {
        const { wheelFilenames = [], wheelBaseUrl } = this.spec;
        if (!wheelFilenames.length) return;
        if (!wheelBaseUrl) {
            throw new Error("PyodideSession: wheelFilenames given without a wheelBaseUrl.");
        }
        await wheelFilenames.reduce(
            (previous, filename, index) =>
                previous.then(async () => {
                    log(`Installing wheel (${index + 1}/${wheelFilenames.length}): ${filename}`);
                    const fsPath = await this.fetchWheel(filename);
                    // deps=False is essential: these wheels exist precisely because their transitive
                    // deps either don't build under Pyodide or conflict with the pinned set.
                    await micropip.install.callKwargs(`emfs:${fsPath}`, { deps: false });
                }),
            Promise.resolve(),
        );
    }

    /**
     * The traceback comes back separately rather than in stdout, so a UI can render it distinctly.
     * Rejects overlapping runs.
     */
    async execute(code: string): Promise<PythonExecutionResult> {
        this.assertReady();
        if (this.running) throw new Error("A Python execution is already in flight.");
        this.running = true;
        this.outputBuffer = "";
        try {
            await this.spec.beforeRun?.(this.pyodide);
            this.pyodide.globals.set("_repl_src", code);
            // The runner catches user errors internally, so this only rejects on infra failures.
            await this.pyodide.runPythonAsync("await _repl_execute(_repl_src)");
            await this.spec.afterRun?.(this.pyodide);
            return { ok: !this.lastError, output: this.outputBuffer, error: this.lastError };
        } finally {
            this.running = false;
        }
    }

    private get lastError(): PythonError | null {
        const raw = this.pyodide.globals.get("_repl_last_error");
        if (!raw) return null;
        const error = (
            raw.toJs ? raw.toJs({ dict_converter: Object.fromEntries }) : raw
        ) as PythonError;
        if (raw.destroy) raw.destroy();
        return error;
    }

    /**
     * Releases the interpreter claim so another session can be built. Pyodide cannot be unloaded, so
     * this resets our bookkeeping, not the runtime.
     */
    dispose(): void {
        releaseInterpreter(this);
        this.pyodide = null;
        this.initialized = false;
    }

    private assertReady(): void {
        if (!this.initialized) throw new Error("PyodideSession is not initialized.");
    }
}

export default PyodideSession;
