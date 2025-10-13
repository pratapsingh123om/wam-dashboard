# write-wam-files.ps1
# Run this from the project root to overwrite frontend files for the WAM UI.
# Usage: powershell -ExecutionPolicy Bypass -File .\write-wam-files.ps1

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

# ensure directories
New-Item -ItemType Directory -Force -Path .\src\components | Out-Null

# src/main.jsx
Set-Content -Path .\src\main.jsx -Encoding UTF8 -Value @'
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
