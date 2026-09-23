/**
 * 比分条叠加层（输出画面 / PROGRAM 监看共用）
 */
function ScoreboardOverlay({ config, className = '' }) {
  if (!config?.enabled) return null;

  const {
    homeName = '主队',
    awayName = '客队',
    homeScore = 0,
    awayScore = 0,
    period = '',
    clock = '',
    showClock = false,
    position = 'top',
    homeColor = '#2563eb',
    awayColor = '#dc2626',
  } = config;

  return (
    <div
      className={`scoreboard-overlay scoreboard-${position} ${className}`}
      aria-label="比分条"
    >
      <div className="scoreboard-bar">
        <span className="scoreboard-team home" style={{ '--team-color': homeColor }}>
          <span className="scoreboard-team-name">{homeName}</span>
          <span className="scoreboard-score">{homeScore}</span>
        </span>
        <span className="scoreboard-mid">
          {period && <span className="scoreboard-period">{period}</span>}
          {showClock && clock && <span className="scoreboard-clock">{clock}</span>}
        </span>
        <span className="scoreboard-team away" style={{ '--team-color': awayColor }}>
          <span className="scoreboard-score">{awayScore}</span>
          <span className="scoreboard-team-name">{awayName}</span>
        </span>
      </div>
    </div>
  );
}

export default ScoreboardOverlay;
