import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    // 运动员默认队徽（client/src/assets/athlete-default.png）必须内联成 data URL：
    // 打包后页面走 file://，若产物引用的是独立 png 文件，画进 canvas 会污染画布，
    // 录像管线会因此放弃「带成绩条录制」。抬高阈值即可内联，产物里不再有该文件。
    assetsInlineLimit: 64 * 1024,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      }
    }
  }
});
