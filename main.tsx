import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installStoragePolyfill } from "./storage";

installStoragePolyfill();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>