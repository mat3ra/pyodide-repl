import ThemeProvider from "@mat3ra/cove/dist/theme/provider/ThemeProvider";
import React from "react";
import ReactDOM from "react-dom";

import MaterialsReplApp from "../app/MaterialsReplApp";

ReactDOM.render(
    <ThemeProvider>
        <MaterialsReplApp />
    </ThemeProvider>,
    document.getElementById("root"),
);
