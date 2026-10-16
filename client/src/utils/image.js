/**
 * 图片工具：把用户选的文件压成适合叠加层的小尺寸 data URL
 * 选手照片会随配置一起存进 data/scoreboard.json，
 * 所以先在浏览器里缩到 maxSide 以内再上传，避免 JSON 无限膨胀。
 */
export function fileToDownscaledDataUrl(file, { maxSide = 640, quality = 0.82 } = {}) {
  return new Promise((resolve, reject) => {
    if (!file) {
      reject(new Error('no file'));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.onload = () => {
      const raw = String(reader.result || '');
      // GIF / SVG 之类直接原样用（canvas 会丢掉动画或矢量特性）
      if (!/^data:image\/(png|jpe?g|webp|bmp)/i.test(raw)) {
        resolve(raw);
        return;
      }
      const img = new Image();
      img.onerror = () => reject(new Error('decode failed'));
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        try {
          resolve(canvas.toDataURL('image/jpeg', quality));
        } catch (e) {
          resolve(raw);
        }
      };
      img.src = raw;
    };
    reader.readAsDataURL(file);
  });
}

export default fileToDownscaledDataUrl;
