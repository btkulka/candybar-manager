// Chrome.jsx — Topbar + ServicePill + Nav
const PAGES = [
  { id: 'library', label: 'Library', icon: 'library' },
  { id: 'organize', label: 'Organize', icon: 'organize' },
  { id: 'check', label: 'Check', icon: 'check' },
  { id: 'source', label: 'Sources', icon: 'source' },
  { id: 'usb', label: 'USB', icon: 'usb' },
  { id: 'restore', label: 'Restore', icon: 'restore' },
];

const ServicePill = ({ brand, connected = true }) => (
  <span className={`service-pill ${brand} ${connected ? 'connected' : 'disconnected'}`}>
    <BrandGlyph brand={brand} />
    <span className="dot" />
    <span>{ { spotify: 'Spotify', soundcloud: 'SoundCloud', qobuz: 'Qobuz', beatport: 'Beatport' }[brand] }</span>
  </span>
);

const Topbar = ({ active, onNavigate, onSettings, services }) => (
  <div className="topbar">
    <div className="brand"><Logo size={22}/><span>Track Lab</span></div>
    <div className="nav">
      {PAGES.map(p => (
        <button
          key={p.id}
          className={`nav-link ${active === p.id ? 'active' : ''}`}
          onClick={() => onNavigate(p.id)}
        >
          <Icon name={p.icon} size={14} />
          <span>{p.label}</span>
        </button>
      ))}
    </div>
    <div className="spacer" />
    <div className="pills">
      {Object.entries(services).map(([k, v]) => <ServicePill key={k} brand={k} connected={v} />)}
    </div>
    <button className="settings-btn" onClick={onSettings} title="Settings"><Icon name="settings" size={16}/></button>
  </div>
);

Object.assign(window, { Topbar, ServicePill, PAGES });
