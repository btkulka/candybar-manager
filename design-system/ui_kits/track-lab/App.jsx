// App.jsx — assembles Topbar + active page + toast
const { useState: useStateApp } = React;

const App = () => {
  const [page, setPage] = useStateApp('library');
  const [toast, setToast] = useStateApp(null);
  const services = { spotify: true, soundcloud: false, qobuz: true, beatport: true };

  const PageComp = {
    library: LibraryPage, organize: OrganizePage, check: CheckPage,
    source: SourcePage, usb: UsbPage, restore: RestorePage,
  }[page] || LibraryPage;

  const showToast = (t) => {
    setToast(t);
    setTimeout(() => setToast(null), 3000);
  };

  return (
    <div className="app">
      <Topbar
        active={page}
        onNavigate={(id) => { setPage(id); showToast({ tone: 'info', icon: 'info', msg: `Navigated to ${id}` }); }}
        onSettings={() => showToast({ tone: 'info', icon: 'settings', msg: 'Settings (not wired in this mock)' })}
        services={services}
      />
      <div className="main"><PageComp/></div>
      {toast && (
        <div className="toast-container">
          <div className={`toast ${toast.tone}`}>
            <Icon name={toast.icon} size={18}/>
            <span>{toast.msg}</span>
          </div>
        </div>
      )}
    </div>
  );
};

ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
