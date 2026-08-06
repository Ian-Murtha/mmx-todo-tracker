import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/mmx-todo-tracker/',
  plugins: [react()],
})
