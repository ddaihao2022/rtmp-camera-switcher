/**
 * 运动员默认图片（校徽）
 *
 * 选手没上传个人照片时，叠加层（大屏 / PROGRAM 监看）与录像成片统一用它兜底，
 * 大屏上不再出现「姓名缩写占位块」这种半成品观感。
 *
 * 三个刻意的取舍：
 *   1) 不写进 athlete.photo。服务端按「有姓名 或 有照片」判定该道次是否有人，
 *      写死默认图会让空道次也变成选手；而且名册随配置存进 data/scoreboard.json，
 *      每人一份 base64 会把配置撑爆。这里只是渲染层的回落。
 *   2) 构建时内联成 data URL（见 vite.config.js 的 assetsInlineLimit），而不是
 *      让打包产物去引用一个独立 png 文件。打包后页面走 file://，file:// 的图片
 *      画进 canvas 会污染画布 —— RecordPanel 的录像管线一旦判定画布不干净，
 *      就会整条放弃「带成绩条录制」。data URL 同源不会污染；个人照片、水印图
 *      也都是 data URL，口径一致。
 *   3) 源文件仍是真 PNG（client/src/assets/），方便日后换图；只有打包才内联。
 *
 * 模块加载时顺带把队徽注册给 canvas 渲染器（见下方 setDefaultPhoto），
 * 这样 DOM 与录像两条渲染路径共用同一张图。
 */
import defaultPhoto from '../assets/athlete-default.png';
import { setDefaultPhoto } from './canvasKit.js';

export const DEFAULT_ATHLETE_PHOTO = defaultPhoto;

// 录像成片走 canvasKit 的 drawPhoto，注册后它也能量到同一张队徽
setDefaultPhoto(defaultPhoto);

export default DEFAULT_ATHLETE_PHOTO;
