import React from "react";
import ReactDOM from "react-dom/client";
import { SettingsApp } from "./App";
import "./settings.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
	<React.StrictMode>
		<SettingsApp />
	</React.StrictMode>,
);
