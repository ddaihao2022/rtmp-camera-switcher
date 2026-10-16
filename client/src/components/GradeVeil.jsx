/**
 * 调色叠加层：色温 / 色调（soft-light 罩层）+ 暗角
 * 放在任意 position:relative 的媒体容器内即可（.video-wrapper / .media-layer / .output-monitor-body）
 */
import { buildOverlays, overlayStyle } from '../utils/color';
import './ColorPanel.css';

export default function GradeVeil({ grade }) {
  const layers = buildOverlays(grade);
  if (!layers.length) return null;
  return (
    <>
      {layers.map((layer, i) => (
        <div
          key={`${layer.kind}-${i}`}
          className={`cg-veil cg-veil--${layer.kind}`}
          style={overlayStyle(layer)}
          aria-hidden="true"
        />
      ))}
    </>
  );
}
