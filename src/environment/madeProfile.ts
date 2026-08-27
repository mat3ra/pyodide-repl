import type { PyodideEnvironmentSpec } from "../session/PyodideSession";

/**
 * The `made` environment: everything that lets `mat3ra.made.tools` import inside Pyodide, mirroring
 * the environment the production JupyterLite kernel builds from AX's `config.yml` (`made` profile).
 *
 * TODO(repl→AX): read that manifest at build time instead of hardcoding the lists, so this
 * environment and JupyterLite's cannot drift.
 */

/** Pinned rather than floating: an interpreter upgrade can break the prebuilt wheels below. */
export const PYODIDE_VERSION = "0.24.1";

export const PYODIDE_INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

/**
 * Prebuilt pure-python wheels for packages whose PyPI releases do not build under Pyodide. Served
 * from this app's own origin (`public/packages`, provisioned by `scripts/provision-wheels.mjs`) —
 * same-origin to the REPL page itself, so no embedding host ever has to host wheels.
 */
export const MADE_WHEEL_FILENAMES = [
    "pydantic_core-2.18.2-py3-none-any.whl",
    "pydantic-2.7.1-py3-none-any.whl",
    "spglib-2.0.2-py3-none-any.whl",
    "ruamel.yaml-0.17.32-py3-none-any.whl",
    "pymatgen-2024.4.13-py3-none-any.whl",
];

/**
 * The namespace users see, ran once after the environment is built.
 *
 * TODO(repl→AX): both snippets below move to `mat3ra-notebooks-utils` (`preamble.material`,
 * `get_materials` / `sync_materials`) once a released wheel carries the host bridge
 * (api-examples #355); this file then keeps only package lists.
 */
export const MATERIALS_PREAMBLE = `
from mat3ra.made.material import Material
from mat3ra.made.tools.helpers import *

def __md_scan_materials():
    """Serialize every public Material binding for the host.

    Lists, tuples and dictionary values are inspected one level deep. The host-provided inputs
    (materials_in, material) are excluded so merely running a cell does not echo them back.
    """
    import json
    reserved = {"materials_in", "material"}
    entities = []
    for name, value in list(globals().items()):
        if name.startswith("_") or name in reserved:
            continue
        if isinstance(value, Material):
            found = [value]
        elif isinstance(value, (list, tuple)):
            found = [item for item in value if isinstance(item, Material)]
        elif isinstance(value, dict):
            found = [item for item in value.values() if isinstance(item, Material)]
        else:
            continue
        entities.extend(
            {"type": "material", "name": name, "config": json.loads(m.to_json())} for m in found
        )
    return json.dumps(entities)
`;

/** Rebinds `materials_in` / `material` from the host's current list; ran before every run. */
export const BIND_MATERIALS_SNIPPET = `
import json as _md_json
materials_in = [Material.create(config) for config in _md_json.loads(_md_materials_json)]
material = materials_in[_md_selected_index] if 0 <= _md_selected_index < len(materials_in) else None
`;

/**
 * The session spec for the made environment. `setupNamespace`/`beforeRun`/`afterRun` are the
 * caller's to add — see MaterialsReplApp for the bridge-connected wiring.
 */
export const MADE_ENVIRONMENT_SPEC: PyodideEnvironmentSpec = {
    indexUrl: PYODIDE_INDEX_URL,
    loadPackages: ["numpy", "scipy", "typing-extensions", "lzma", "sqlite3", "ssl"],
    pypiPinnedPackages: [
        "annotated_types>=0.6.0",
        "networkx==3.2.1",
        "monty==2023.11.3",
        "tabulate==0.9.0",
        "sympy==1.12",
        "uncertainties==3.1.6",
        "ase==3.25.0",
    ],
    wheelFilenames: MADE_WHEEL_FILENAMES,
    // deps=True installs AFTER the wheels above so their pinned dependencies are already satisfied.
    postWheelPackages: [
        "pymatgen-analysis-defects<=2024.4.23",
        "mat3ra-periodic-table",
        "mat3ra-made",
        "jedi==0.19.2",
    ],
    // Relative to the REPL page's own origin — works on the deploy, a PR preview, and `npm run dev`.
    wheelBaseUrl: "./packages",
};
