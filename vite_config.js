import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // GitHub Pagesは https://<user>.github.io/vegetable-NOTE/ のようにサブフォルダで公開されるため、
  // ここを "/" のままにすると、ビルド後のJS/CSSが見つからず白い画面になる。
  base: "/vegetable-NOTE/",
  plugins: [react()],
});