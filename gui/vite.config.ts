import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// base './' : l'interface est servie derrière un préfixe de proxy variable, résolu
// à l'exécution par la balise <base> injectée par le worker.
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: { '@shared': path.resolve(import.meta.dirname, '../shared') },
  },
})
