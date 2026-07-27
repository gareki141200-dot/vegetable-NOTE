import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // GitHub Pagesのサブフォルダ名に合わせる
  base: "/vegetable-NOTE/",
  plugins: [react()],
});
