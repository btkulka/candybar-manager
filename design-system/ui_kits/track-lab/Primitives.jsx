// Primitives.jsx — small shared UI atoms
const Card = ({ children, className = '', ...rest }) => (
  <div className={`card ${className}`} {...rest}>{children}</div>
);

const Btn = ({ variant = 'secondary', size, children, icon, ...rest }) => (
  <button className={`btn btn-${variant}${size === 'sm' ? ' btn-sm' : ''}`} {...rest}>
    {icon && <Icon name={icon} size={14} />}
    {children}
  </button>
);

const Kpi = ({ num, label, tone }) => (
  <div className={`kpi ${tone || ''}`}>
    <div className="kpi-num">{num}</div>
    <div className="kpi-label">{label}</div>
  </div>
);

const Banner = ({ tone = 'info', icon = 'info', children }) => (
  <div className={`banner ${tone}`}><Icon name={icon} size={16}/>{children}</div>
);

const HealthIcon = ({ state }) => {
  const map = { ok: 'check_mark', warn: 'alert', err: 'err', unknown: 'info' };
  const color = { ok: '#1db954', warn: '#f1c40f', err: '#e74c3c', unknown: 'var(--text-muted)' }[state];
  return <div className="track-health" style={{ color }}><Icon name={map[state]} size={16}/></div>;
};

const TrackRow = ({ title, artist, format, bpm, keyy, state = 'ok', artBg }) => (
  <div className={`track-item ${state === 'ok' ? '' : state}`}>
    <div className="track-art" style={artBg ? { background: artBg } : undefined}>
      {!artBg && <Icon name="disc" size={24}/>}
    </div>
    <div className="track-info">
      <div className="track-title">{title}</div>
      <div className={`track-artist ${artist ? '' : 'missing'}`}>{artist || 'Missing artist'}</div>
      <div className="track-meta">
        {format && <span className="chip">{format}</span>}
        {bpm && <span className="chip">{bpm} BPM</span>}
        {keyy && <span className="chip">{keyy}</span>}
      </div>
    </div>
    <HealthIcon state={state}/>
    <button className="btn-icon" title="More"><Icon name="more" size={16}/></button>
  </div>
);

const ProgressBar = ({ label, current, total }) => (
  <div className="progress-row">
    <div className="progress-hdr"><span>{label}</span><span className="progress-counts">{current.toLocaleString()} / {total.toLocaleString()}</span></div>
    <div className="progress-outer"><div className="progress-fill" style={{ width: `${Math.min(100, (current / total) * 100)}%` }} /></div>
  </div>
);

Object.assign(window, { Card, Btn, Kpi, Banner, HealthIcon, TrackRow, ProgressBar });
