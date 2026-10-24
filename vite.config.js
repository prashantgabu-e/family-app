import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react()],
    // Default matches this repository's GitHub Pages project URL; override for a rename or custom domain.
    base: env.VITE_BASE_PATH || '/family-app/',
    build: { outDir: 'docs', emptyOutDir: true },
  }
})
