// Pages.jsx — one component per top-level page
const { useState } = React;

// ============ LIBRARY ============
const SAMPLE_TRACKS = [
  { title: "Strings Of Life (Juan Atkins Remix)", artist: "Derrick May", format: "AIFF", bpm: 126, keyy: "8A", state: "ok", artBg: "linear-gradient(135deg,#2a1f4a,#4a2f6a)" },
  { title: "The Bells", artist: "Jeff Mills", format: "AIFF", bpm: 140, keyy: "9A", state: "ok", artBg: "linear-gradient(135deg,#0f3a4a,#1a5a6a)" },
  { title: "Rej (Âme Radio Edit)", artist: "Âme", format: "AIFF", bpm: 122, keyy: "6A", state: "ok", artBg: "linear-gradient(135deg,#4a2f1f,#6a4a2f)" },
  { title: "Untitled Track 04.mp3", artist: "", format: "MP3 · 320", state: "warn" },
  { title: "Energy Flash", artist: "Joey Beltram", format: "FLAC", bpm: 135, state: "err" },
  { title: "Spastik", artist: "Plastikman", format: "AIFF", bpm: 136, keyy: "7A", state: "ok", artBg: "linear-gradient(135deg,#1a3a1a,#2f6a2f)" },
];

const LibraryPage = () => (
  <div className="content-wide">
    <div className="page-header">
      <div>
        <h1 className="page-title">Library</h1>
        <p className="page-desc">1,284 tracks · last scan 4 minutes ago</p>
      </div>
      <div className="flex">
        <Btn variant="ghost" size="sm" icon="search">Search</Btn>
        <Btn variant="secondary" size="sm" icon="upload">Scan library</Btn>
      </div>
    </div>

    <div className="kpi-grid">
      <Kpi num="1,284" label="TRACKS"/>
      <Kpi num="1,241" label="HEALTHY" tone="ok"/>
      <Kpi num="31" label="WARNINGS" tone="warn"/>
      <Kpi num="12" label="ERRORS" tone="err"/>
    </div>

    <Banner tone="warn" icon="alert">31 tracks are missing artist tags. Edit them or ignore to proceed.</Banner>

    <Card>
      <div className="flex-between" style={{marginBottom: 12}}>
        <h3 style={{margin:0}}>Recent tracks</h3>
        <span className="muted" style={{fontSize:'.8rem'}}>6 of 1,284</span>
      </div>
      <div className="track-list">
        {SAMPLE_TRACKS.map((t, i) => <TrackRow key={i} {...t}/>)}
      </div>
    </Card>
  </div>
);

// ============ ORGANIZE ============
const OrganizePage = () => {
  const [running, setRunning] = useState(false);
  const [current, setCurrent] = useState(421);

  React.useEffect(() => {
    if (!running) return;
    const iv = setInterval(() => setCurrent(c => Math.min(1284, c + 23)), 120);
    return () => clearInterval(iv);
  }, [running]);

  return (
    <div className="content-column">
      <div className="page-header">
        <div>
          <h1 className="page-title">Organize by artist</h1>
          <p className="page-desc">Moves tracks from a source bin into artist folders based on metadata.</p>
        </div>
      </div>

      <Card>
        <h3>Source</h3>
        <div className="field" style={{marginBottom: 12}}>
          <label>Source bin</label>
          <div className="flex">
            <input className="input" defaultValue="/Users/you/Music/Inbox"/>
            <Btn variant="secondary" size="sm">Browse</Btn>
          </div>
        </div>
        <div className="field">
          <label>Library root</label>
          <div className="flex">
            <input className="input" defaultValue="/Users/you/Music/Track Lab"/>
            <Btn variant="secondary" size="sm">Browse</Btn>
          </div>
        </div>
      </Card>

      <Card>
        <div className="flex-between" style={{marginBottom: 12}}>
          <h3 style={{margin:0}}>{running ? 'Organizing' : 'Ready to organize'}</h3>
          {!running
            ? <Btn variant="primary" size="sm" onClick={() => setRunning(true)}>Start</Btn>
            : <Btn variant="ghost" size="sm" onClick={() => setRunning(false)}>Abort</Btn>}
        </div>
        {running && (
          <div style={{display:'flex',flexDirection:'column',gap:10}}>
            <ProgressBar label="Moving tracks" current={current} total={1284}/>
            <div style={{display:'flex',gap:16,fontSize:'.75rem'}}>
              <span className="mono"><span style={{color:'#2ecc71'}}>● </span>{current - 23} moved</span>
              <span className="mono"><span style={{color:'#f1c40f'}}>● </span>18 conflicts</span>
              <span className="mono"><span style={{color:'#e74c3c'}}>● </span>5 errors</span>
            </div>
            <div className="mono muted" style={{fontSize:'.75rem',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>→ /Derrick May/Strings Of Life.aiff</div>
          </div>
        )}
        {!running && (
          <div className="muted" style={{fontSize:'.85rem'}}>1,284 tracks detected in source bin · 18 will create new artist folders</div>
        )}
      </Card>
    </div>
  );
};

// ============ CHECK (Missing Track Check) ============
const CheckPage = () => {
  const [step, setStep] = useState(0);
  return (
    <div className="content-column">
      <div className="page-header">
        <div>
          <h1 className="page-title">Missing track check</h1>
          <p className="page-desc">Check a playlist or CSV against your library. Exports M3U8 or Rekordbox XML.</p>
        </div>
      </div>

      {step === 0 && (
        <div className="grid-2">
          <Card onClick={() => setStep(1)} style={{cursor:'pointer'}}>
            <h3>From Spotify playlist</h3>
            <p className="muted" style={{fontSize:'.85rem',margin:'0 0 12px'}}>Paste a playlist URL. We'll read the tracks.</p>
            <input className="input" placeholder="https://open.spotify.com/playlist/…"/>
          </Card>
          <Card onClick={() => setStep(1)} style={{cursor:'pointer'}}>
            <h3>From CSV</h3>
            <p className="muted" style={{fontSize:'.85rem',margin:'0 0 12px'}}>Drop a CSV with title / artist columns.</p>
            <div className="dropzone" style={{padding:24}}>
              <Icon name="upload" size={22}/>
              <span style={{fontSize:'.85rem'}}>Drop CSV or click to browse</span>
            </div>
          </Card>
        </div>
      )}

      {step === 1 && (
        <React.Fragment>
          <div className="kpi-grid">
            <Kpi num="87" label="CHECKED"/>
            <Kpi num="64" label="FOUND" tone="ok"/>
            <Kpi num="11" label="UNCERTAIN" tone="warn"/>
            <Kpi num="12" label="MISSING" tone="err"/>
          </div>
          <Card>
            <div className="flex-between" style={{marginBottom:12}}>
              <div className="flex" style={{gap:4}}>
                <Btn size="sm" variant="secondary">All</Btn>
                <Btn size="sm" variant="ghost">Found</Btn>
                <Btn size="sm" variant="ghost">Uncertain</Btn>
                <Btn size="sm" variant="ghost">Missing</Btn>
              </div>
              <div className="flex">
                <Btn size="sm" variant="ghost">Export M3U8</Btn>
                <Btn size="sm" variant="secondary">Export Rekordbox XML</Btn>
              </div>
            </div>
            <table className="data-table">
              <thead><tr><th>Title</th><th>Artist</th><th>Status</th><th>Match</th></tr></thead>
              <tbody>
                <tr><td>Strings Of Life</td><td>Derrick May</td><td style={{color:'#1db954'}}>Found</td><td className="mono muted">0.98</td></tr>
                <tr><td>The Bells</td><td>Jeff Mills</td><td style={{color:'#1db954'}}>Found</td><td className="mono muted">0.96</td></tr>
                <tr><td>Rej</td><td>Âme</td><td style={{color:'#f1c40f'}}>Uncertain</td><td className="mono muted">0.72</td></tr>
                <tr><td>Energy Flash</td><td>Joey Beltram</td><td style={{color:'#e74c3c'}}>Missing</td><td className="mono muted">—</td></tr>
                <tr><td>Spastik</td><td>Plastikman</td><td style={{color:'#1db954'}}>Found</td><td className="mono muted">0.99</td></tr>
              </tbody>
            </table>
          </Card>
          <div className="flex-between">
            <Btn variant="ghost" onClick={() => setStep(0)}>← Change source</Btn>
            <Btn variant="primary" icon="cart">Send 12 missing to Sources</Btn>
          </div>
        </React.Fragment>
      )}
    </div>
  );
};

Object.assign(window, { LibraryPage, OrganizePage, CheckPage });
