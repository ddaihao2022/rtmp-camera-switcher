import { useState, useEffect } from 'react';

/**
 * 侧栏折叠分区
 * @param {string} id 稳定 id（localStorage 记忆展开状态）
 * @param {boolean} defaultOpen
 * @param {boolean} keepMounted 折叠时只隐藏不卸载（用于录制面板这类不能被打断的分区）
 */
export default function SidebarSection({
  id,
  title,
  icon,
  badge,
  actions,
  defaultOpen = true,
  collapsible = true,
  keepMounted = false,
  children,
}) {
  const key = `sidebar-sec-${id}`;
  const [open, setOpen] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw != null) return raw === '1';
    } catch {}
    return defaultOpen;
  });

  useEffect(() => {
    try { localStorage.setItem(key, open ? '1' : '0'); } catch {}
  }, [key, open]);

  return (
    <section className={`sidebar-sec ${open ? 'open' : 'closed'}`}>
      <button
        type="button"
        className="sidebar-sec-head"
        onClick={() => collapsible && setOpen(o => !o)}
        aria-expanded={open}
        title={collapsible ? (open ? '点击折叠' : '点击展开') : undefined}
      >
        <span className="sidebar-sec-chevron" aria-hidden="true">
          {collapsible ? (open ? '▾' : '▸') : ''}
        </span>
        {icon && <span className="sidebar-sec-icon">{icon}</span>}
        <span className="sidebar-sec-title">{title}</span>
        {badge != null && badge !== '' && (
          <span className="sidebar-sec-badge">{badge}</span>
        )}
        {actions && (
          <span className="sidebar-sec-actions" onClick={e => e.stopPropagation()}>
            {actions}
          </span>
        )}
      </button>
      {open ? (
        <div className="sidebar-sec-body">{children}</div>
      ) : keepMounted ? (
        <div className="sidebar-sec-body" style={{ display: 'none' }}>{children}</div>
      ) : null}
    </section>
  );
}
