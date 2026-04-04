import React, { useState, useEffect, createContext, useContext, useCallback, type ReactNode } from 'react';

/* ------------------------------------------------------------------ */
/*  Error Boundary                                                     */
/* ------------------------------------------------------------------ */

class ErrorBoundary extends React.Component<
  { children: ReactNode; viewKey?: string },
  { hasError: boolean; error: Error | null }
> {
  state = { hasError: false, error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidUpdate(prevProps: { viewKey?: string }) {
    if (prevProps.viewKey !== this.props.viewKey && this.state.hasError) {
      this.setState({ hasError: false, error: null });
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-64" style={{ color: 'var(--text-secondary)' }}>
          <p className="text-lg font-medium mb-2">Something went wrong</p>
          <p className="text-sm mb-4">{this.state.error?.message}</p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="px-4 py-2 bg-amber-600 text-white rounded-lg text-sm hover:bg-amber-700"
          >
            Try Again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
import {
  GitBranch,
  Clock,
  AlertTriangle,
  Columns2,
  Search as SearchIcon,
  Zap,
  History,
  Bell,
  BarChart3,
  Upload,
  Settings,
  Radio,
  Menu,
  X,
  ClipboardCheck,
  Activity,
} from 'lucide-react';
import { DecisionGraph } from './components/DecisionGraph';
import { Timeline } from './components/Timeline';
import { Contradictions } from './components/Contradictions';
import { ContextComparison } from './components/ContextComparison';
import { Search } from './components/Search';
import { ImpactAnalysis } from './components/ImpactAnalysis';
import { SessionHistory } from './components/SessionHistory';
import { NotificationFeed } from './components/NotificationFeed';
import { ProjectStats } from './components/ProjectStats';
import { Wizard } from './components/Wizard';
import { Import } from './components/Import';
import { Connectors } from './components/Connectors';
import { Webhooks } from './components/Webhooks';
import { TimeTravelView } from './components/TimeTravelView';
import { useApi } from './hooks/useApi';

/* ------------------------------------------------------------------ */
/*  Project context                                                    */
/* ------------------------------------------------------------------ */

interface ProjectContextValue {
  projectId: string;
  setProjectId: (id: string) => void;
}

const ProjectContext = createContext<ProjectContextValue>({
  projectId: 'default',
  setProjectId: () => {},
});

export function useProject() {
  return useContext(ProjectContext);
}

/* ------------------------------------------------------------------ */
/*  Views                                                              */
/* ------------------------------------------------------------------ */

type View =
  | 'graph'
  | 'timeline'
  | 'contradictions'
  | 'context'
  | 'search'
  | 'impact'
  | 'sessions'
  | 'notifications'
  | 'stats'
  | 'import'
  | 'connectors'
  | 'webhooks'
  | 'timetravel'
  | 'wizard';

interface NavItem {
  id: View;
  label: string;
  icon: ReactNode;
  badge?: number | null;
  group: 'main' | 'integrations' | 'monitoring' | 'settings';
}

function getViewFromHash(): View {
  const hash = window.location.hash.replace('#', '') as View;
  const all: View[] = ['graph','timeline','contradictions','context','search','impact','sessions','notifications','stats','import','connectors','webhooks','timetravel'];
  if (all.includes(hash)) return hash;
  return 'graph';
}

/* ------------------------------------------------------------------ */
/*  View renderer                                                      */
/* ------------------------------------------------------------------ */

function ViewContent({ view }: { view: View }) {
  switch (view) {
    case 'graph': return <DecisionGraph />;
    case 'timeline': return <Timeline />;
    case 'contradictions': return <Contradictions />;
    case 'context': return <ContextComparison />;
    case 'search': return <Search />;
    case 'impact': return <ImpactAnalysis />;
    case 'sessions': return <SessionHistory />;
    case 'notifications': return <NotificationFeed />;
    case 'stats': return <ProjectStats />;
    case 'import': return <Import />;
    case 'connectors': return <Connectors />;
    case 'webhooks': return <Webhooks />;
    case 'timetravel': return <TimeTravelView />;
    default: return <DecisionGraph />;
  }
}

/* ------------------------------------------------------------------ */
/*  Nav Item Component                                                 */
/* ------------------------------------------------------------------ */

function NavItemButton({
  item,
  active,
  collapsed,
  onClick,
}: {
  item: NavItem;
  active: boolean;
  collapsed?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={collapsed ? item.label : undefined}
      className={`nav-item w-full text-left ${active ? 'active' : ''}`}
    >
      <span className="shrink-0">{item.icon}</span>
      {!collapsed && <span className="truncate flex-1">{item.label}</span>}
      {!collapsed && item.badge != null && item.badge > 0 && (
        <span className="nav-badge">{item.badge > 99 ? '99+' : item.badge}</span>
      )}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Sidebar Content (shared between mobile menu and desktop sidebar)   */
/* ------------------------------------------------------------------ */

function SidebarContent({
  navItems,
  view,
  collapsed,
  onNavigate,
}: {
  navItems: NavItem[];
  view: View;
  collapsed?: boolean;
  onNavigate: (v: View) => void;
}) {
  const groups: Array<{ key: string; items: NavItem[] }> = [
    { key: 'main', items: navItems.filter((n) => n.group === 'main') },
    { key: 'integrations', items: navItems.filter((n) => n.group === 'integrations') },
    { key: 'monitoring', items: navItems.filter((n) => n.group === 'monitoring') },
    { key: 'settings', items: navItems.filter((n) => n.group === 'settings') },
  ];

  return (
    <>
      {/* Logo */}
      <div className="flex items-center gap-3 px-5 py-5">
        <div className="w-8 h-8 rounded-lg bg-[#D97706] flex items-center justify-center shrink-0">
          <span className="text-white font-bold text-sm">N</span>
        </div>
        {!collapsed && <span className="font-bold text-lg text-white tracking-tight">DeciGraph</span>}
      </div>

      {/* Nav groups */}
      <div className="flex-1 overflow-y-auto px-3 pb-4">
        {groups.map((group, gi) => (
          <div key={group.key}>
            {gi > 0 && group.items.length > 0 && <div className="nav-divider" />}
            <div className="space-y-0.5">
              {group.items.map((item) => (
                <NavItemButton
                  key={item.id}
                  item={item}
                  active={view === item.id}
                  collapsed={collapsed}
                  onClick={() => onNavigate(item.id)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Version */}
      {!collapsed && (
        <div className="px-5 py-3 text-xs text-[#5A5957]">v0.1.0</div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  App                                                                */
/* ------------------------------------------------------------------ */

export default function App() {
  const { get } = useApi();

  const [view, setView] = useState<View>(getViewFromHash);
  const [projectId, setProjectId] = useState('default');
  const [menuOpen, setMenuOpen] = useState(false);

  // First-run detection
  const [showWizard, setShowWizard] = useState(false);
  const [projectsChecked, setProjectsChecked] = useState(false);

  // Badge counts
  const [unresolvedCount, setUnresolvedCount] = useState<number | null>(null);

  // Build nav items
  const navItems: NavItem[] = [
    { id: 'graph', label: 'Decision Graph', icon: <GitBranch size={18} />, group: 'main' },
    { id: 'timeline', label: 'Timeline', icon: <Clock size={18} />, group: 'main' },
    { id: 'contradictions', label: 'Contradictions', icon: <AlertTriangle size={18} />, badge: unresolvedCount, group: 'main' },
    { id: 'context', label: 'Context Compare', icon: <Columns2 size={18} />, group: 'main' },
    { id: 'search', label: 'Search', icon: <SearchIcon size={18} />, group: 'main' },
    { id: 'impact', label: 'Impact Analysis', icon: <Zap size={18} />, group: 'main' },
    { id: 'sessions', label: 'Sessions', icon: <History size={18} />, group: 'main' },
    { id: 'import', label: 'Import', icon: <Upload size={18} />, group: 'integrations' },
    { id: 'connectors', label: 'Connectors', icon: <Settings size={18} />, group: 'integrations' },
    { id: 'webhooks', label: 'Webhooks', icon: <Radio size={18} />, group: 'integrations' },
    { id: 'timetravel', label: 'Time Travel', icon: <Clock size={18} />, group: 'integrations' },
    { id: 'notifications', label: 'Alerts', icon: <Bell size={18} />, group: 'monitoring' },
    { id: 'stats', label: 'Health', icon: <BarChart3 size={18} />, group: 'monitoring' },
  ];

  /* ---- Check for first run -------------------------------------- */
  useEffect(() => {
    get<Array<{ id: string }>>('/api/projects')
      .then((projects) => {
        if (Array.isArray(projects) && projects.length === 0) {
          setShowWizard(true);
        } else if (Array.isArray(projects) && projects.length > 0) {
          if (projectId === 'default' && projects[0]?.id) {
            setProjectId(projects[0].id);
          }
        }
        setProjectsChecked(true);
      })
      .catch(() => setProjectsChecked(true));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---- Fetch unresolved contradiction count --------------------- */
  useEffect(() => {
    if (!projectsChecked || showWizard || projectId === 'default') return;
    let cancelled = false;
    get<Array<{ id: string }>>(`/api/projects/${projectId}/contradictions?status=unresolved`)
      .then((data) => {
        if (!cancelled) setUnresolvedCount(Array.isArray(data) ? data.length : null);
      })
      .catch(() => { if (!cancelled) setUnresolvedCount(null); });
    return () => { cancelled = true; };
  }, [get, projectId, projectsChecked, showWizard]);

  /* ---- Hash sync ------------------------------------------------ */
  useEffect(() => {
    function onHash() { setView(getViewFromHash()); }
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  /* ---- Navigate ------------------------------------------------- */
  const navigate = useCallback((v: View) => {
    window.location.hash = v;
    setView(v);
    setMenuOpen(false);
  }, []);

  /* ---- Touch gestures: swipe from left edge to open menu -------- */
  useEffect(() => {
    let startX = 0;
    const onTouchStart = (e: TouchEvent) => { startX = e.touches[0].clientX; };
    const onTouchEnd = (e: TouchEvent) => {
      const endX = e.changedTouches[0].clientX;
      if (startX < 20 && endX - startX > 60) setMenuOpen(true);
    };
    document.addEventListener('touchstart', onTouchStart);
    document.addEventListener('touchend', onTouchEnd);
    return () => {
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchend', onTouchEnd);
    };
  }, []);

  /* ---- Wizard complete ----------------------------------------- */
  function handleWizardComplete(newProjectId: string) {
    setProjectId(newProjectId);
    setShowWizard(false);
    navigate('graph');
  }

  /* ---- Loading -------------------------------------------------- */
  if (!projectsChecked) {
    return (
      <ProjectContext.Provider value={{ projectId, setProjectId }}>
        <div className="flex items-center justify-center h-screen" style={{ background: 'var(--bg-primary)' }}>
          <div className="w-10 h-10 rounded-xl bg-[#D97706] flex items-center justify-center">
            <span className="text-white font-bold">N</span>
          </div>
        </div>
      </ProjectContext.Provider>
    );
  }

  /* ---- Wizard -------------------------------------------------- */
  if (showWizard) {
    return (
      <ProjectContext.Provider value={{ projectId, setProjectId }}>
        <Wizard onComplete={handleWizardComplete} />
      </ProjectContext.Provider>
    );
  }

  /* ---- Main dashboard ------------------------------------------ */
  return (
    <ProjectContext.Provider value={{ projectId, setProjectId }}>
      {/* Mobile top bar */}
      <header
        className="sticky top-0 z-30 flex items-center h-14 px-4 border-b md:hidden top-bar"
        style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-light)' }}
      >
        <button onClick={() => setMenuOpen(true)} className="p-2 -ml-2 touch-target">
          <Menu className="w-5 h-5" style={{ color: 'var(--text-primary)' }} />
        </button>
        <span className="ml-3 font-semibold text-lg" style={{ color: 'var(--text-primary)' }}>DeciGraph</span>
      </header>

      {/* Mobile overlay */}
      {menuOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 transition-opacity md:hidden"
          onClick={() => setMenuOpen(false)}
        />
      )}

      {/* Mobile slide-over menu */}
      <nav
        className={`fixed inset-y-0 left-0 z-50 w-3/4 max-w-[320px] bg-[#1A1A1A] transform transition-transform duration-[250ms] ease-out md:hidden flex flex-col ${
          menuOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <SidebarContent navItems={navItems} view={view} onNavigate={navigate} />
      </nav>

      <div className="flex h-screen overflow-hidden">
        {/* Desktop/Tablet sidebar */}
        <aside className="hidden md:flex md:flex-col shrink-0 sidebar">
          <SidebarContent navItems={navItems} view={view} onNavigate={navigate} />
        </aside>

        {/* Main content */}
        <main
          className="flex-1 overflow-y-auto md:ml-[260px]"
          style={{ background: 'var(--bg-primary)' }}
        >
          <ErrorBoundary viewKey={view}>
            <div className="page-enter">
              <ViewContent view={view} />
            </div>
          </ErrorBoundary>
        </main>
      </div>
    </ProjectContext.Provider>
  );
}
