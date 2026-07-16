import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

// Builds the entire app into ONE self-contained index.html (all JS + CSS
// inlined). Output goes to dist-single/. Handy for opening the app by
// double-clicking a single file, or hosting it as a static page.
//   npm run build:single
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: 'dist-single',
    assetsInlineLimit: 100000000,
    cssCodeSplit: false,
  },
})
