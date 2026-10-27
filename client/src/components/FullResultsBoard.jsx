import { eventDisplayName } from '../utils/eventName';

/**
 * 全屏成绩公示板
 *
 * 每个项目结束（按「下一项 / 上一项」）后自动盖满 PROGRAM / HDMI / 录像画面，
 * 让刚结束项目的名次和成绩完整停留几秒；时间到由服务端统一下屏。
 */
function FullResultsBoard({ config, className = '' }) {
  const snapshot = config?.fullResultsSnapshot || {};
  const athletes = Array.isArray(snapshot.athletes) ? snapshot.athletes : [];
  const eventName = snapshot.eventName || config?.eventName || '项目成绩';
  const category = snapshot.category || config?.category || '';
  const title = eventDisplayName(eventName, category);
  const meta = [category, snapshot.round, snapshot.heat, snapshot.sessionLabel].filter(Boolean);
  // 人多就分栏，按「列优先」排：左列 1~N 名，右列接着往下排，跟纸质成绩单一致
  const cols = athletes.length > 16 ? 3 : athletes.length > 8 ? 2 : 1;
  const rows = Math.max(1, Math.ceil(athletes.length / cols));
  const density = rows <= 5 ? 'is-few' : rows > 8 ? 'is-many' : '';
  const grid = cols > 1
    ? {
      gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
      gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
      gridAutoFlow: 'column',
    }
    : undefined;

  return (
    <div className={`full-results ${density} ${className}`} aria-label={`${title} 成绩公示`}>
      <div className="full-results-glow" aria-hidden="true" />
      <div className="full-results-watermark" aria-hidden="true">RESULTS</div>
      <div className="full-results-inner">
        <header className="full-results-head">
          <div className="full-results-kicker">
            <span className="full-results-dot" />
            项目成绩 · RESULTS
          </div>
          <h1>{title}</h1>
          {meta.length > 0 && (
            <div className="full-results-meta">
              {meta.map((v, i) => (
                <span key={`${v}-${i}`}>{v}</span>
              ))}
            </div>
          )}
        </header>

        <div className="full-results-list" style={grid}>
          {athletes.map((a, i) => {
            const rank = String(a.place || '').match(/\d+/)?.[0] || '';
            const medal = rank === '1' ? 'gold' : rank === '2' ? 'silver' : rank === '3' ? 'bronze' : '';
            const name = String(a.name || '').trim() || String(a.unit || '').trim() || '—';
            const unit = String(a.name || '').trim() ? String(a.unit || '').trim() : '';
            return (
              <div className={`full-results-row ${medal ? `medal-${medal}` : ''}`} key={`${a.lane}-${i}`}>
                <span className="full-results-rank">{rank || '—'}</span>
                <span className="full-results-lane">{a.lane || '—'}</span>
                <span className="full-results-who">
                  <b>{name}</b>
                  {unit && <small>{unit}</small>}
                </span>
                {a.bib && <span className="full-results-bib">No.{a.bib}</span>}
                <span className="full-results-time">{a.result || '—'}</span>
              </div>
            );
          })}
        </div>

        <footer className="full-results-foot">
          <span>{snapshot.resultCount || athletes.length} 人已出成绩</span>
          {snapshot.time && <span>{snapshot.time}</span>}
          <span className="full-results-note">最终成绩以裁判长公布为准</span>
        </footer>
      </div>
    </div>
  );
}

export default FullResultsBoard;
