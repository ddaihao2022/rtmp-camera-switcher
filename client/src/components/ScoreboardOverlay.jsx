/**
 * 赛事信息叠加层 — 田径优先（径赛道次 / 田赛尝试 / 成绩榜）
 * 输出画面与 PROGRAM 监看共用
 */
import { useEffect, useMemo, useState } from 'react';

function formatMs(ms) {
  const total = Math.max(0, Math.floor(ms));
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const cs = Math.floor((total % 1000) / 10);
  if (m > 0) {
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  }
  return `${s}.${String(cs).padStart(2, '0')}`;
}

function useLiveClock(config) {
  const running = !!config?.clockRunning;
  const startAt = Number(config?.clockStartAt) || 0;
  const offset = Number(config?.clockOffsetMs) || 0;
  const fallback = config?.clock || '0.00';
  const [tick, setTick] = useState(() =>
    running && startAt ? offset + (Date.now() - startAt) : offset
  );

  useEffect(() => {
    if (!running || !startAt) {
      setTick(offset);
      return undefined;
    }
    setTick(offset + (Date.now() - startAt));
    const id = setInterval(() => {
      setTick(offset + (Date.now() - startAt));
    }, 50);
    return () => clearInterval(id);
  }, [running, startAt, offset]);

  if (running) return formatMs(tick);
  return fallback || formatMs(tick);
}

function WindTag({ wind }) {
  if (!wind) return null;
  const w = String(wind).trim();
  const numeric = Number(String(w).replace('m/s', '').trim());
  const cls = Number.isFinite(numeric) ? (numeric >= 0 ? 'pos' : 'neg') : '';
  return <span className={`track-wind ${cls}`}>风速 {w}</span>;
}

function TrackOverlay({ config }) {
  const clock = useLiveClock(config);
  const {
    eventName = '',
    category = '',
    round = '',
    heat = '',
    wind = '',
    mr = '',
    sb = '',
    eventKind = 'sprint',
    athletes = [],
    showPlaces = true,
    showResults = true,
    showClock = true,
    showPodium = false,
    attempt = 1,
    attemptsTotal = 6,
    bestMark = '',
    laps = [],
  } = config;

  const list = (athletes || []).filter(a => a?.name || a?.place || a?.result);
  const isField = eventKind === 'field';

  const podium = useMemo(() => {
    if (!showPodium) return [];
    return (athletes || [])
      .filter(a => a.place && a.name)
      .sort((a, b) => (Number(a.place) || 99) - (Number(b.place) || 99))
      .slice(0, 3);
  }, [showPodium, athletes]);

  const title = category && eventName && !eventName.startsWith(category)
    ? `${category} ${eventName}`
    : eventName;

  return (
    <div className="track-bug" aria-label="田径信息条">
      <div className="track-bug-head">
        <span className="track-event">{title}</span>
        {round && <span className="track-round">{round}</span>}
        {heat && !isField && <span className="track-heat">{heat}</span>}
        <WindTag wind={wind} />
        {mr && <span className="track-record" title="赛会纪录">MR {mr}</span>}
        {sb && <span className="track-record sb" title="赛季最佳">SB {sb}</span>}
        {isField && (
          <span className="track-attempt">
            第 {attempt}/{attemptsTotal} 试
            {bestMark && <em> 最佳 {bestMark}</em>}
          </span>
        )}
        {showClock && clock && (
          <span className={`track-clock ${config.clockRunning ? 'running' : ''}`}>{clock}</span>
        )}
      </div>

      {showPodium && podium.length > 0 ? (
        <div className="track-podium">
          {podium.map((a, i) => (
            <div key={a.lane} className={`track-podium-row place-${i + 1}`}>
              <span className="track-podium-rank">{a.place || i + 1}</span>
              <span className="track-podium-name">{a.name}</span>
              {a.unit && <span className="track-podium-unit">{a.unit}</span>}
              {a.result && <span className="track-result">{a.result}</span>}
            </div>
          ))}
        </div>
      ) : list.length > 0 ? (
        <div className="track-lanes">
          {list.map((a) => (
            <div
              key={a.lane}
              className={`track-lane-chip ${a.place === '1' ? 'gold' : a.place === '2' ? 'silver' : a.place === '3' ? 'bronze' : ''}`}
            >
              <span className="track-lane-no">{a.lane}</span>
              <span className="track-lane-name">
                {a.name || '—'}
                {a.unit && <em className="track-unit">{a.unit}</em>}
              </span>
              {showPlaces && a.place && <span className="track-place">{a.place}</span>}
              {showResults && a.result && <span className="track-result">{a.result}</span>}
            </div>
          ))}
        </div>
      ) : null}

      {(laps?.length > 0) && (
        <div className="track-laps">
          <span className="track-laps-label">分圈</span>
          {laps.map((L, i) => (
            <span key={i} className="track-lap-chip">{L}</span>
          ))}
        </div>
      )}
    </div>
  );
}

function TeamBar({ config }) {
  const {
    homeName = '主队',
    awayName = '客队',
    homeScore = 0,
    awayScore = 0,
    period = '',
    showClock = false,
    homeColor = '#2563eb',
    awayColor = '#dc2626',
  } = config;

  return (
    <div className="scoreboard-bar">
      <span className="scoreboard-team home" style={{ '--team-color': homeColor }}>
        <span className="scoreboard-team-name">{homeName}</span>
        <span className="scoreboard-score">{homeScore}</span>
      </span>
      <span className="scoreboard-mid">
        {period && <span className="scoreboard-period">{period}</span>}
        {showClock && config.clock && <span className="scoreboard-clock">{config.clock}</span>}
      </span>
      <span className="scoreboard-team away" style={{ '--team-color': awayColor }}>
        <span className="scoreboard-score">{awayScore}</span>
        <span className="scoreboard-team-name">{awayName}</span>
      </span>
    </div>
  );
}

function ScoreboardOverlay({ config, className = '' }) {
  if (!config?.enabled) return null;
  const isTrack = (config.mode || 'track') === 'track';

  return (
    <div
      className={`scoreboard-overlay scoreboard-${config.position || 'bottom'} ${className}`}
      aria-label={isTrack ? '田径信息条' : '比分条'}
    >
      {isTrack ? <TrackOverlay config={config} /> : <TeamBar config={config} />}
    </div>
  );
}

export default ScoreboardOverlay;
