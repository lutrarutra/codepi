import React from "react";
import ReactDOM from "react-dom/client";
import { ExtensionsApp } from "./App";
import "./extensions.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
	<React.StrictMode>
		<ExtensionsApp />
	</React.StrictMode>,
);
