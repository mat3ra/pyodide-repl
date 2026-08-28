import ThemeProvider from "@mat3ra/cove/dist/theme/provider/ThemeProvider";
import React from "react";
import ReactDOM from "react-dom";

import MaterialsReplApp from "../app/MaterialsReplApp";

// No alert/snackbar provider on purpose: cove's AlertProvider pulls in legacy @mui/styles. Infra
// errors are echoed into the REPL's console pane instead (see PythonRepl's catch blocks), which is
// also where a user would look for them.
ReactDOM.render(
    <ThemeProvider>
        <MaterialsReplApp />
    </ThemeProvider>,
    document.getElementById("root"),
);
