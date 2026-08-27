/**
 * The Python that {@link PyodideSession} defines inside the interpreter. Kept as plain string
 * constants — cove has no Python toolchain and no codegen step, and adding one for two static
 * snippets would be build infrastructure this package otherwise doesn't need.
 *
 * The explanatory comments live inside the Python itself, so they travel with the code.
 */

/** Defines `_repl_execute`, used by {@link PyodideSession.execute}. */
export const PY_DEFINE_RUNNER = `
# Runs user code in the REPL's persistent globals (not a fresh namespace), so variables and imports
# from earlier runs are still visible — that's the whole point of a REPL versus a one-shot script.
# eval_code_async is Pyodide's own top-level-await-capable exec, which is why 'await' works directly
# in REPL code without the user wrapping it in an async function themselves.
#
# On failure, records a Jupyter/nbformat-shaped error (ename/evalue/traceback) in _repl_last_error
# instead of letting the exception propagate — PyodideSession.execute() reads this afterwards.
# The traceback is built from '_repl_traceback_frame.tb_next', deliberately skipping this function's
# own stack frame, so what the user sees starts at their code, not at "_repl_execute" internals.
from pyodide.code import eval_code_async as _repl_eval_code_async
import traceback as _repl_traceback
_repl_last_error = None
async def _repl_execute(_repl_source):
    global _repl_last_error
    _repl_last_error = None
    try:
        await _repl_eval_code_async(_repl_source, globals=globals())
    except Exception as _repl_exception:
        _repl_traceback_frame = _repl_exception.__traceback__
        _repl_last_error = {
            "ename": type(_repl_exception).__name__,
            "evalue": str(_repl_exception),
            "traceback": "".join(
                _repl_traceback.format_exception(
                    type(_repl_exception),
                    _repl_exception,
                    _repl_traceback_frame.tb_next if _repl_traceback_frame else None,
                )
            ),
        }
`;

export const MAX_COMPLETIONS_PER_REQUEST = 60;

/** Defines `_repl_complete` / `_repl_describe`, used by complete()/describe(). Requires Jedi. */
export const PY_DEFINE_COMPLETER = `
# Jedi-backed completion for the editor. jedi.Interpreter completes against the LIVE REPL globals (not
# just static analysis of the typed text), so it knows the user's actual variables, their attributes,
# imported modules and keywords — not only anything pre-imported. Called on every keystroke from the
# JS side (PyodideSession.complete/describe), so this stays cheap: signature and docstring lookup is a
# separate, on-demand call (describe), not done for every candidate up front.
import jedi as _repl_jedi
import json as _repl_cjson

def _repl_complete(_repl_source, _repl_line, _repl_column):
    try:
        _repl_completions = _repl_jedi.Interpreter(_repl_source, [globals()]).complete(_repl_line, _repl_column)
    except Exception:
        return "[]"
    # Surface the current call's keyword-argument (param) completions first — inside a call Jedi
    # otherwise returns them alphabetically, buried under builtins. Mirrors how IDEs rank params.
    _repl_params = [_completion for _completion in _repl_completions if _completion.type == "param"]
    _repl_others = [_completion for _completion in _repl_completions if _completion.type != "param"]
    _repl_ordered = (_repl_params + _repl_others)[:${MAX_COMPLETIONS_PER_REQUEST}]
    return _repl_cjson.dumps(
        [{"name": _completion.name, "type": _completion.type} for _completion in _repl_ordered]
    )

def _repl_describe(_repl_source, _repl_line, _repl_column, _repl_target_name):
    try:
        for _completion in _repl_jedi.Interpreter(_repl_source, [globals()]).complete(_repl_line, _repl_column):
            if _completion.name == _repl_target_name:
                try:
                    _repl_signatures = _completion.get_signatures()
                    _repl_signature = _repl_signatures[0].to_string() if _repl_signatures else ""
                except Exception:
                    _repl_signature = ""
                try:
                    _repl_docstring = _completion.docstring(raw=True)
                except Exception:
                    _repl_docstring = ""
                return _repl_cjson.dumps({"signature": _repl_signature, "docstring": _repl_docstring})
    except Exception:
        pass
    return _repl_cjson.dumps({"signature": "", "docstring": ""})
`;
