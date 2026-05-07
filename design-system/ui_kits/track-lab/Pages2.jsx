// Pages2.jsx — Sources, USB, Restore
const { useState: useState2 } = React;

// ============ SOURCES (purchase flow w/ embedded store panel) ============
const SourcePage = () => {
  const [cartOpen, setCartOpen] = useState2(false);
  return (
    <div className="content-wide">
      <div className="page-header">
        <div>
          <h1 className="page-title">Sources</h1>
          <p className="page-desc">Find lossless purchase sources on Qobuz and Beatport, then add to cart.</p>
        </div>
      </div>

      <div className="kpi-grid">
        <Kpi num="12" label="TO BUY"/>
        <Kpi num="8" label="QOBUZ" tone=""/>
        <Kpi num="3" label="BEATPORT"/>
        <Kpi num="1" label="NOT FOUND" tone="err"/>
      </div>

      <div style={{display:'grid', gridTemplateColumns: cartOpen ? '1fr 1fr' : '1fr', gap: 20, transition: 'grid-template-columns .3s var(--ease-out)'}}>
        <Card>
          <div className="flex-between" style={{marginBottom: 12}}>
            <div className="flex" style={{gap:4}}>
              <Btn size="sm" variant="secondary">All</Btn>
              <Btn size="sm" variant="ghost">Qobuz (8)</Btn>
              <Btn size="sm" variant="ghost">Beatport (3)</Btn>
              <Btn size="sm" variant="ghost">Not found (1)</Btn>
            </div>
            <Btn size="sm" variant="primary" icon="cart" onClick={() => setCartOpen(!cartOpen)}>
              {cartOpen ? 'Close cart' : 'Open cart'}
            </Btn>
          </div>
          <div className="track-list">
            <TrackRow title="Strings Of Life" artist="Derrick May · Qobuz · $2.49" format="FLAC 24/96" state="ok" artBg="linear-gradient(135deg,#2a1f4a,#4a2f6a)"/>
            <TrackRow title="The Bells" artist="Jeff Mills · Beatport · $2.49" format="AIFF" state="ok" artBg="linear-gradient(135deg,#0f3a4a,#1a5a6a)"/>
            <TrackRow title="Rej" artist="Âme · Qobuz · $1.99" format="FLAC 16/44" state="ok" artBg="linear-gradient(135deg,#4a2f1f,#6a4a2f)"/>
            <TrackRow title="Energy Flash" artist="Joey Beltram · not found" state="err"/>
          </div>
        </Card>

        {cartOpen && (
          <div className="store-panel">
            <div className="store-tb">
              <button className="btn-icon"><Icon name="back" size={12}/></button>
              <button className="btn-icon"><Icon name="fwd" size={12}/></button>
              <span className="store-label" style={{color:'#a4ff00'}}>Beatport · Cart</span>
              <div style={{flex:1}}/>
              <button className="btn-icon" onClick={() => setCartOpen(false)}><Icon name="x" size={12}/></button>
            </div>
            <div className="store-view">
              <div className="store-view-content">
                <div className="eyebrow">Your Cart · 3 items</div>
                <div className="row"><span>Strings Of Life — Derrick May</span><span className="mono">$2.49</span></div>
                <div className="row"><span>The Bells — Jeff Mills</span><span className="mono">$2.49</span></div>
                <div className="row"><span>Rej — Âme</span><span className="mono">$1.99</span></div>
                <div className="row" style={{borderTop:'1px solid #1a1a1a',marginTop:6,paddingTop:10,fontWeight:600}}><span>Total</span><span className="mono" style={{color:'#a4ff00'}}>$6.97</span></div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// ============ USB (XDJ-RX3 compatibility) ============
const UsbPage = () => (
  <div className="content-column">
    <div className="page-header">
      <div>
        <h1 className="page-title">USB compatibility</h1>
        <p className="page-desc">Check a USB drive for Pioneer XDJ-RX3 compatibility before a gig.</p>
      </div>
    </div>

    <Card className="elevated">
      <div className="flex" style={{alignItems:'center',gap:14}}>
        <div style={{width:40,height:40,borderRadius:8,background:'var(--bg-surface)',display:'flex',alignItems:'center',justifyContent:'center',color:'var(--accent)'}}>
          <Icon name="drive" size={22}/>
        </div>
        <div style={{flex:1}}>
          <div style={{fontSize:'.95rem',fontWeight:600}}>SANDISK ULTRA · 64GB</div>
          <div className="muted mono" style={{fontSize:'.75rem'}}>/Volumes/SET · FAT32 · 412 tracks scanned</div>
        </div>
        <Btn size="sm" variant="secondary">Refresh</Btn>
      </div>
    </Card>

    <div className="kpi-grid">
      <Kpi num="412" label="TRACKS"/>
      <Kpi num="397" label="HEALTHY" tone="ok"/>
      <Kpi num="9" label="WARNINGS" tone="warn"/>
      <Kpi num="6" label="ERRORS" tone="err"/>
    </div>

    <div className="grid-2">
      <Card>
        <h3>By format</h3>
        <div className="breakdown">
          <div className="breakdown-row"><span className="label">AIFF</span><span className="val">298</span></div>
          <div className="breakdown-row"><span className="label">WAV</span><span className="val">68</span></div>
          <div className="breakdown-row"><span className="label">MP3 320</span><span className="val">40</span></div>
          <div className="breakdown-row"><span className="label" style={{color:'#e74c3c'}}>FLAC · unsupported</span><span className="val" style={{color:'#e74c3c'}}>6</span></div>
        </div>
      </Card>
      <Card>
        <h3>Compatibility</h3>
        <div className="breakdown">
          <div className="breakdown-row"><span className="label">Filesystem</span><span className="val" style={{color:'#1db954'}}>FAT32 ✓</span></div>
          <div className="breakdown-row"><span className="label">Path length</span><span className="val" style={{color:'#1db954'}}>OK</span></div>
          <div className="breakdown-row"><span className="label">Filename chars</span><span className="val" style={{color:'#f1c40f'}}>3 warnings</span></div>
          <div className="breakdown-row"><span className="label">Tag encoding</span><span className="val" style={{color:'#1db954'}}>UTF-8</span></div>
        </div>
      </Card>
    </div>

    <Card>
      <div className="flex-between" style={{marginBottom:12}}>
        <h3 style={{margin:0}}>Issues</h3>
        <Btn size="sm" variant="primary">Fix all auto-fixable</Btn>
      </div>
      <div className="track-list">
        <TrackRow title="Energy Flash.flac" artist="Joey Beltram · format unsupported on XDJ-RX3" format="FLAC" state="err"/>
        <TrackRow title="untitled_track_04.mp3" artist="Missing artist / genre tags" format="MP3" state="warn"/>
      </div>
    </Card>
  </div>
);

// ============ RESTORE (multi-stage wizard) ============
const PHASES = [
  { id: 'xml', label: 'Parse XML' },
  { id: 'library', label: 'Scan library' },
  { id: 'beatport', label: 'Beatport purchases' },
  { id: 'qobuz_fetch', label: 'Qobuz purchases' },
  { id: 'download', label: 'Download' },
  { id: 'xml_rewrite', label: 'Rewrite XML' },
  { id: 'complete', label: 'Done' },
];
const RestorePage = () => {
  const [phaseIdx, setPhaseIdx] = useState2(3);
  return (
    <div className="content-wide">
      <div className="page-header">
        <div>
          <h1 className="page-title">Restore from Rekordbox XML</h1>
          <p className="page-desc">Rebuild a lost library from <span className="mono">export.xml</span>, pulling from Qobuz purchase history, Beatport, and SoundCloud.</p>
        </div>
      </div>

      <div style={{display:'grid',gridTemplateColumns:'220px 1fr',gap:20}}>
        <Card>
          <ol className="wiz-phases">
            {PHASES.map((p, i) => (
              <li key={p.id} className={`wiz-phase ${i < phaseIdx ? 'done' : ''} ${i === phaseIdx ? 'active' : ''}`}
                  onClick={() => setPhaseIdx(i)}>
                <span className="ph-dot"/>
                <span>{p.label}</span>
              </li>
            ))}
          </ol>
        </Card>

        <div style={{display:'flex',flexDirection:'column',gap:16}}>
          <div className="kpi-grid">
            <Kpi num="147" label="RECOVERED" tone="ok"/>
            <Kpi num="32" label="STILL MISSING" tone="warn"/>
            <Kpi num="24/min" label="RATE"/>
            <Kpi num="1:18" label="ETA"/>
          </div>
          <Card>
            <div className="flex-between" style={{marginBottom:10}}>
              <h3 style={{margin:0}}>{PHASES[phaseIdx].label}</h3>
              <span className="muted mono" style={{fontSize:'.75rem'}}>phase {phaseIdx + 1} of {PHASES.length}</span>
            </div>
            <ProgressBar label="Overall" current={147} total={179}/>
            <div className="mono muted" style={{fontSize:'.75rem',marginTop:10}}>→ Fetching Qobuz purchases · page 3 of 7</div>
          </Card>
          <Card>
            <h3>Live log</h3>
            <div className="mono" style={{fontSize:'.75rem',color:'var(--text-secondary)',display:'flex',flexDirection:'column',gap:4,maxHeight:200,overflow:'auto'}}>
              <div><span style={{color:'#2ecc71'}}>[OK]</span> Parsed export.xml · 1,863 entries</div>
              <div><span style={{color:'#2ecc71'}}>[OK]</span> Scanned library · 1,684 present · 179 missing</div>
              <div><span style={{color:'#2ecc71'}}>[OK]</span> Beatport purchases · 63 matched</div>
              <div><span style={{color:'var(--accent)'}}>[··]</span> Qobuz purchases · page 3/7</div>
              <div className="muted">  → Strings Of Life (Rmx) · Derrick May</div>
              <div className="muted">  → Spastik · Plastikman</div>
            </div>
          </Card>
          <div className="flex-between">
            <Btn variant="ghost" onClick={() => setPhaseIdx(Math.max(0, phaseIdx - 1))}>← Back</Btn>
            <div className="flex">
              <Btn variant="ghost">Abort</Btn>
              <Btn variant="primary" onClick={() => setPhaseIdx(Math.min(PHASES.length - 1, phaseIdx + 1))}>Next phase →</Btn>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

Object.assign(window, { SourcePage, UsbPage, RestorePage });
