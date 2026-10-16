/**
 * 选手介绍叠加层 — 三种样式：
 *   card   单人卡（居中大卡，适合赛前逐一介绍）
 *   lower  底部字幕条（不挡画面，适合入场 / 检录时滚动介绍）
 *   roster 名册（每屏 N 位，适合整组介绍）
 *
 * 数据与「田径信息条」共用同一份名册（config.athletes）：
 *   name 姓名 / unit 单位班级 / bib 号码 / lane 道次 / pb 最好成绩 / note 亮点 / photo 照片
 * 服务端统一推进轮播与自动隐藏，HDMI、PROGRAM 监看、录像完全同帧。
 */
import { useState } from 'react';
import './AthleteIntro.css';
import { DEFAULT_ATHLETE_PHOTO } from '../utils/athleteDefault';

function shortName(name) {
  const n = String(name || '').trim();
  if (!n) return '待录入';
  return n.length <= 2 ? n : n.slice(0, 2);
}

function eventLine(cfg) {
  const name = String(cfg.eventName || '').trim();
  const cat = String(cfg.category || '').trim();
  const title = cat && name && !name.startsWith(cat) ? `${cat} ${name}` : name;
  return [title, cfg.round, cfg.heat].filter(Boolean).join(' · ');
}

function AthletePhoto({ athlete, className = '' }) {
  const personal = String(athlete?.photo || '').trim();
  // 记录「加载失败的那个地址」，而不是布尔量：换人/换照片时状态自然复位
  const [failedSrc, setFailedSrc] = useState('');
  const usePersonal = personal && failedSrc !== personal;
  const src = usePersonal ? personal : DEFAULT_ATHLETE_PHOTO;
  // 个人照片挂了退到队徽；队徽也挂了才回到姓名缩写占位块
  if (!usePersonal && failedSrc === DEFAULT_ATHLETE_PHOTO) {
    return (
      <span className={`intro-photo intro-photo--blank ${className}`} aria-hidden="true">
        {shortName(athlete?.name)}
      </span>
    );
  }
  return (
    <img
      className={`intro-photo ${usePersonal ? '' : 'intro-photo--default'} ${className}`}
      src={src}
      alt={athlete?.name || '选手'}
      onError={() => setFailedSrc(prev => (prev === src ? prev : src))}
    />
  );
}

function StatChips({ athlete, cfg }) {
  return (
    <div className="intro-stats">
      {athlete.bib && <span className="intro-chip bib">No.{athlete.bib}</span>}
      {athlete.lane != null && athlete.lane !== '' && (
        <span className="intro-chip lane">{athlete.lane} 道</span>
      )}
      {cfg.introShowPb !== false && athlete.pb && (
        <span className="intro-chip pb">PB {athlete.pb}</span>
      )}
    </div>
  );
}

function IntroHeader({ cfg, index, total }) {
  const line = eventLine(cfg);
  return (
    <div className="intro-head">
      <span className="intro-head-tag">{cfg.introTitle || '选手介绍'}</span>
      {line && <span className="intro-head-event">{line}</span>}
      {total > 1 && (
        <span className="intro-head-count">
          {index + 1} <em>/</em> {total}
        </span>
      )}
    </div>
  );
}

/** 自动轮播 / 自动隐藏进度条 */
function IntroProgress({ cfg }) {
  const auto = cfg.introAuto && Number(cfg.introAutoMs) > 0;
  const hold = Number(cfg.introHold) > 0;
  if (!auto && !hold) return null;
  const ms = auto ? Math.max(2000, Number(cfg.introAutoMs)) : Number(cfg.introHold) * 1000;
  return (
    <div className="intro-progress" aria-hidden="true">
      <span
        key={`${cfg.introIndex}-${ms}`}
        className="intro-progress-fill"
        style={{ '--intro-hold': `${ms}ms` }}
      />
    </div>
  );
}

function CardIntro({ cfg, athlete, index, total }) {
  return (
    <div className="intro-card" key={`card-${index}`}>
      <div className="intro-card-photo">
        <AthletePhoto athlete={athlete} />
      </div>
      <div className="intro-card-body">
        <div className="intro-name-row">
          {athlete.lane != null && athlete.lane !== '' && (
            <span className="intro-lane-badge">{athlete.lane}</span>
          )}
          <h2 className="intro-name">{athlete.name || '待录入姓名'}</h2>
        </div>
        {athlete.unit && <div className="intro-unit">{athlete.unit}</div>}
        <StatChips athlete={athlete} cfg={cfg} />
        {cfg.introShowNote !== false && athlete.note && (
          <p className="intro-note">{athlete.note}</p>
        )}
        <IntroHeader cfg={cfg} index={index} total={total} />
      </div>
      <IntroProgress cfg={cfg} />
    </div>
  );
}

function LowerIntro({ cfg, athlete, index, total }) {
  return (
    <div className="intro-lower" key={`lower-${index}`}>
      <div className="intro-lower-accent" />
      <AthletePhoto athlete={athlete} className="intro-lower-photo" />
      <div className="intro-lower-body">
        <div className="intro-lower-name">{athlete.name || '待录入姓名'}</div>
        <div className="intro-lower-sub">
          {athlete.unit && <span className="intro-lower-unit">{athlete.unit}</span>}
          <StatChips athlete={athlete} cfg={cfg} />
        </div>
      </div>
      {cfg.introShowNote !== false && athlete.note && (
        <div className="intro-lower-note">{athlete.note}</div>
      )}
      <div className="intro-lower-tail">
        <span className="intro-lower-title">{cfg.introTitle || '选手介绍'}</span>
        {total > 1 && (
          <span className="intro-lower-count">{index + 1}/{total}</span>
        )}
      </div>
      <IntroProgress cfg={cfg} />
    </div>
  );
}

function RosterIntro({ cfg, list, index }) {
  const perScreen = Math.max(1, Math.min(8, Number(cfg.introPerScreen) || 3));
  const pages = Math.max(1, Math.ceil(list.length / perScreen));
  const page = Math.min(pages - 1, Math.floor(index / perScreen));
  const slice = list.slice(page * perScreen, page * perScreen + perScreen);

  return (
    <div className="intro-roster">
      <IntroHeader cfg={cfg} index={index} total={list.length} />
      <div className="intro-roster-grid" style={{ '--intro-per-screen': perScreen }}>
        {slice.map((a, i) => {
          const abs = page * perScreen + i;
          const on = abs === index;
          return (
            <div className={`intro-roster-card ${on ? 'on' : ''}`} key={`${a.lane}-${abs}`}>
              <AthletePhoto athlete={a} className="intro-roster-photo" />
              <span className="intro-roster-lane">{a.lane}</span>
              <div className="intro-roster-body">
                <div className="intro-roster-name">{a.name || '待录入'}</div>
                {a.unit && <div className="intro-roster-unit">{a.unit}</div>}
                <div className="intro-roster-meta">
                  {a.bib && <span>No.{a.bib}</span>}
                  {cfg.introShowPb !== false && a.pb && <span>PB {a.pb}</span>}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="intro-dots">
        {Array.from({ length: pages }, (_, p) => (
          <span key={p} className={`intro-dot ${p === page ? 'on' : ''}`} />
        ))}
      </div>
      <IntroProgress cfg={cfg} />
    </div>
  );
}

function AthleteIntro({ config }) {
  const cfg = config || {};
  const list = (cfg.athletes || []).filter(a => String(a?.name || '').trim() || a?.photo);
  const index = Math.max(0, Math.min(Math.max(list.length - 1, 0), Math.floor(Number(cfg.introIndex) || 0)));
  const style = cfg.introStyle || 'card';

  if (!list.length) {
    return (
      <div className="intro-root">
        <div className={`intro-frame intro-frame--${style}`}>
          <div className="intro-empty">
            <span className="intro-empty-tag">{cfg.introTitle || '选手介绍'}</span>
            <span className="intro-empty-text">选手介绍已上屏 · 请在设置或侧栏录入选手</span>
          </div>
        </div>
      </div>
    );
  }

  if (style === 'roster') {
    return (
      <div className="intro-root">
        <div className="intro-frame intro-frame--roster">
          <RosterIntro cfg={cfg} list={list} index={index} />
        </div>
      </div>
    );
  }

  const athlete = list[index];

  if (style === 'lower') {
    return (
      <div className="intro-root">
        <div className="intro-frame intro-frame--lower">
          <LowerIntro cfg={cfg} athlete={athlete} index={index} total={list.length} />
        </div>
      </div>
    );
  }

  return (
    <div className="intro-root">
      <div className="intro-frame intro-frame--card">
        <CardIntro cfg={cfg} athlete={athlete} index={index} total={list.length} />
      </div>
    </div>
  );
}

export default AthleteIntro;
