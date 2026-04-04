import { useState } from 'react';
import {
  GitBranch,
  ArrowRight,
  ArrowLeft,
  Check,
  Plus,
  Trash2,
  Loader2,
  AlertCircle,
  RefreshCw,
  FileText,
  FolderOpen,
  LayoutDashboard,
  Users,
  Cpu,
} from 'lucide-react';
import { useApi } from '../hooks/useApi';

/* ------------------------------------------------------------------ */
/*  Role definitions                                                   */
/* ------------------------------------------------------------------ */

const ROLES: { value: string; label: string; description: string }[] = [
  { value: 'builder', label: 'Builder', description: 'Implements features and writes code' },
  { value: 'reviewer', label: 'Reviewer', description: 'Reviews code and design decisions' },
  { value: 'product', label: 'Product', description: 'Owns product strategy and roadmap' },
  { value: 'docs', label: 'Docs', description: 'Authors and maintains documentation' },
  { value: 'launch', label: 'Launch', description: 'Coordinates releases and go-live' },
  { value: 'ops', label: 'Ops', description: 'Manages infrastructure and operations' },
  { value: 'blockchain', label: 'Blockchain', description: 'Smart contracts and on-chain logic' },
  { value: 'challenge', label: 'Challenge', description: 'Stress-tests assumptions and plans' },
  { value: 'governor', label: 'Governor', description: 'Enforces process and governance' },
  { value: 'architect', label: 'Architect', description: 'Defines system architecture' },
  { value: 'design', label: 'Design', description: 'UX and visual design decisions' },
  { value: 'qa', label: 'QA', description: 'Quality assurance and testing strategy' },
  { value: 'devops', label: 'DevOps', description: 'CI/CD and deployment pipelines' },
  { value: 'analytics', label: 'Analytics', description: 'Data, metrics and insights' },
  { value: 'gtm', label: 'GTM', description: 'Go-to-market and growth strategy' },
  { value: 'security', label: 'Security', description: 'Security review and compliance' },
];

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface AgentDraft {
  id: string;
  name: string;
  role: string;
}

type SeedOption = 'manual' | 'import' | 'connect' | null;

interface CompileResult {
  agent: string;
  task: string;
  decisions: Array<{ decision: { id: string; title: string }; score: number }>;
}

/* ------------------------------------------------------------------ */
/*  Step indicator                                                     */
/* ------------------------------------------------------------------ */

const STEPS = [
  'Welcome',
  'Create Project',
  'Add Agents',
  'Seed Decisions',
  'See It Work',
  'Done',
];

function StepDots({ current }: { current: number }) {
  return (
    <div className="flex items-center justify-center gap-2 mb-8">
      {STEPS.map((label, i) => (
        <div key={i} className="flex items-center gap-2">
          <div
            title={label}
            className={`w-2.5 h-2.5 rounded-full transition-all duration-200 ${
              i < current
                ? 'bg-primary'
                : i === current
                  ? 'bg-primary ring-2 ring-primary/30 scale-125'
                  : 'bg-[var(--border-light)]'
            }`}
          />
          {i < STEPS.length - 1 && (
            <div
              className={`w-6 h-px transition-all ${
                i < current ? 'bg-primary' : 'bg-[var(--border-light)]'
              }`}
            />
          )}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Error banner                                                       */
/* ------------------------------------------------------------------ */

function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-start gap-3 p-3 rounded-md bg-red-500/10 border border-red-500/20 mb-4">
      <AlertCircle size={16} className="shrink-0 mt-0.5 text-red-400" />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-red-300 leading-relaxed">{message}</p>
      </div>
      {onRetry && (
        <button
          onClick={onRetry}
          className="shrink-0 flex items-center gap-1 text-xs text-red-400 hover:text-red-300 transition-colors"
        >
          <RefreshCw size={12} />
          Retry
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Wizard component                                                   */
/* ------------------------------------------------------------------ */

interface WizardProps {
  onComplete: (projectId: string) => void;
}

export function Wizard({ onComplete }: WizardProps) {
  const { post, get } = useApi();

  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  /* Step 2 — Project */
  const [projectName, setProjectName] = useState('');
  const [projectDesc, setProjectDesc] = useState('');
  const [createdProjectId, setCreatedProjectId] = useState<string | null>(null);

  /* Step 3 — Agents */
  const [agents, setAgents] = useState<AgentDraft[]>([
    { id: crypto.randomUUID(), name: '', role: 'builder' },
    { id: crypto.randomUUID(), name: '', role: 'reviewer' },
  ]);
  const [agentsAdded, setAgentsAdded] = useState(false);

  /* Step 4 — Seed decisions */
  const [seedOption, setSeedOption] = useState<SeedOption>(null);
  const [conversation, setConversation] = useState('');
  const [extractedDecisions, setExtractedDecisions] = useState<
    Array<{ title: string; confidence: number }>
  >([]);
  const [connectorPath, setConnectorPath] = useState('');
  const [connectorSaved, setConnectorSaved] = useState(false);
  const [distilling, setDistilling] = useState(false);

  /* Step 5 — Compile */
  const [compileResults, setCompileResults] = useState<CompileResult[]>([]);
  const [compiled, setCompiled] = useState(false);

  /* ---- Navigation helpers ---------------------------------------- */

  function next() {
    setError(null);
    setStep((s) => s + 1);
  }

  function back() {
    setError(null);
    setStep((s) => s - 1);
  }

  /* ---- Step 2: Create project ------------------------------------ */

  async function handleCreateProject() {
    if (!projectName.trim()) {
      setError('Project name is required.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await post<{ id: string }>('/api/projects', {
        name: projectName.trim(),
        description: projectDesc.trim() || undefined,
      });
      setCreatedProjectId(result.id);
      next();
    } catch (err: unknown) {
      const e = err as { message?: string };
      setError(e.message || 'Failed to create project. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  /* ---- Step 3: Add agents ---------------------------------------- */

  function addAgent() {
    setAgents((prev) => [
      ...prev,
      { id: crypto.randomUUID(), name: '', role: 'builder' },
    ]);
  }

  function removeAgent(id: string) {
    setAgents((prev) => prev.filter((a) => a.id !== id));
  }

  function updateAgent(id: string, field: 'name' | 'role', value: string) {
    setAgents((prev) => prev.map((a) => (a.id === id ? { ...a, [field]: value } : a)));
  }

  async function handleAddAgents() {
    const valid = agents.filter((a) => a.name.trim());
    if (valid.length < 2) {
      setError('Please provide at least 2 agents with names.');
      return;
    }
    if (!createdProjectId) return;
    setLoading(true);
    setError(null);
    try {
      await Promise.all(
        valid.map((a) =>
          post(`/api/projects/${createdProjectId}/agents`, {
            name: a.name.trim(),
            role: a.role,
          }),
        ),
      );
      setAgentsAdded(true);
      next();
    } catch (err: unknown) {
      const e = err as { message?: string };
      setError(e.message || 'Failed to add agents. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  /* ---- Step 4: Seed decisions ------------------------------------ */

  async function handleDistill() {
    if (!conversation.trim() || !createdProjectId) return;
    setDistilling(true);
    setError(null);
    try {
      const result = await post<{ decisions: Array<{ title: string; confidence: number }> }>(
        `/api/projects/${createdProjectId}/distill`,
        { conversation: conversation.trim() },
      );
      setExtractedDecisions(result.decisions || []);
    } catch (err: unknown) {
      const e = err as { message?: string };
      setError(e.message || 'Failed to extract decisions. Please try again.');
    } finally {
      setDistilling(false);
    }
  }

  async function handleSaveConnector() {
    if (!connectorPath.trim() || !createdProjectId) return;
    setLoading(true);
    setError(null);
    try {
      await post(`/api/projects/${createdProjectId}/connectors`, {
        name: 'openclaw',
        config: { path: connectorPath.trim() },
        enabled: true,
      });
      setConnectorSaved(true);
    } catch (err: unknown) {
      const e = err as { message?: string };
      setError(e.message || 'Failed to save connector. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  /* ---- Step 5: Compile ------------------------------------------ */

  async function handleCompile() {
    if (!createdProjectId) return;
    setLoading(true);
    setError(null);
    try {
      // Get first two agents
      const agentsRes = await get<Array<{ name: string; role: string }>>(
        `/api/projects/${createdProjectId}/agents`,
      );
      const firstTwo = (Array.isArray(agentsRes) ? agentsRes : []).slice(0, 2);
      const results = await Promise.all(
        firstTwo.map((a) =>
          post<CompileResult>('/api/compile', {
            project_id: createdProjectId,
            agent: a.name,
            task: `Summarize key decisions for ${a.role}`,
          }),
        ),
      );
      setCompileResults(results);
      setCompiled(true);
    } catch (err: unknown) {
      const e = err as { message?: string };
      setError(e.message || 'Failed to compile context. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Render steps                                                     */
  /* ---------------------------------------------------------------- */

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--bg-primary)] px-4 py-12">
      <div className="w-full max-w-2xl">
        {/* Logo */}
        <div className="flex items-center justify-center gap-2 mb-10">
          <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
            <GitBranch size={16} className="text-white" />
          </div>
          <span className="font-semibold text-lg tracking-tight">Nexus</span>
        </div>

        <StepDots current={step} />

        <div className="card p-8 animate-slide-up">
          {/* ---- Step 0: Welcome ---------------------------------- */}
          {step === 0 && (
            <div className="text-center">
              <div className="w-16 h-16 rounded-2xl bg-primary/15 flex items-center justify-center mx-auto mb-6">
                <GitBranch size={28} className="text-primary" />
              </div>
              <h1 className="text-2xl font-semibold mb-3">
                Welcome to Nexus
              </h1>
              <p className="text-base text-[var(--text-secondary)] leading-relaxed mb-2 max-w-md mx-auto">
                Your team's shared decision memory.
              </p>
              <p className="text-sm text-[var(--text-secondary)] leading-relaxed mb-8 max-w-md mx-auto">
                Nexus captures every architectural choice, product decision, and trade-off your
                team makes — then surfaces the right context to each AI agent at the right time.
                No more repeated debates. No more lost rationale.
              </p>
              <button
                onClick={next}
                className="btn-primary inline-flex items-center gap-2 px-6 py-2.5 text-sm"
              >
                Set up your first project
                <ArrowRight size={16} />
              </button>
            </div>
          )}

          {/* ---- Step 1: Create project --------------------------- */}
          {step === 1 && (
            <div>
              <div className="flex items-center gap-3 mb-6">
                <div className="w-10 h-10 rounded-lg bg-primary/15 flex items-center justify-center shrink-0">
                  <FolderOpen size={18} className="text-primary" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold">Create your project</h2>
                  <p className="text-sm text-[var(--text-secondary)]">
                    Give your decision graph a home.
                  </p>
                </div>
              </div>

              {error && <ErrorBanner message={error} />}

              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-medium mb-1.5 uppercase tracking-wider text-[var(--text-secondary)]">
                    Project name <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="text"
                    value={projectName}
                    onChange={(e) => setProjectName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleCreateProject()}
                    placeholder="e.g. Product v2 Architecture"
                    className="input w-full"
                    autoFocus
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium mb-1.5 uppercase tracking-wider text-[var(--text-secondary)]">
                    Description <span className="opacity-50">(optional)</span>
                  </label>
                  <textarea
                    value={projectDesc}
                    onChange={(e) => setProjectDesc(e.target.value)}
                    placeholder="Brief description of what this project covers…"
                    className="input w-full resize-none"
                    rows={3}
                  />
                </div>
              </div>

              {createdProjectId && (
                <div className="mt-4 p-3 rounded-md bg-primary/10 border border-primary/20">
                  <p className="text-xs text-primary font-medium">
                    Project created — ID: <code className="font-mono">{createdProjectId}</code>
                  </p>
                </div>
              )}

              <div className="flex items-center justify-between mt-6">
                <button onClick={back} className="btn-secondary flex items-center gap-2 text-sm">
                  <ArrowLeft size={15} />
                  Back
                </button>
                <button
                  onClick={handleCreateProject}
                  disabled={loading || !projectName.trim()}
                  className="btn-primary flex items-center gap-2 text-sm"
                >
                  {loading ? (
                    <Loader2 size={15} className="animate-spin" />
                  ) : (
                    <ArrowRight size={15} />
                  )}
                  {createdProjectId ? 'Continue' : 'Create Project'}
                </button>
              </div>
            </div>
          )}

          {/* ---- Step 2: Add agents ------------------------------- */}
          {step === 2 && (
            <div>
              <div className="flex items-center gap-3 mb-6">
                <div className="w-10 h-10 rounded-lg bg-primary/15 flex items-center justify-center shrink-0">
                  <Users size={18} className="text-primary" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold">Add your agents</h2>
                  <p className="text-sm text-[var(--text-secondary)]">
                    Each agent gets a tailored context window. Minimum 2 required.
                  </p>
                </div>
              </div>

              {error && <ErrorBanner message={error} />}

              <div className="space-y-3 mb-4">
                {agents.map((agent, i) => (
                  <div key={agent.id} className="flex items-start gap-3">
                    <div className="flex-1 flex gap-3">
                      <div className="flex-1">
                        {i === 0 && (
                          <label className="block text-xs font-medium mb-1.5 uppercase tracking-wider text-[var(--text-secondary)]">
                            Name
                          </label>
                        )}
                        <input
                          type="text"
                          value={agent.name}
                          onChange={(e) => updateAgent(agent.id, 'name', e.target.value)}
                          placeholder={`Agent ${i + 1} name`}
                          className="input w-full"
                        />
                      </div>
                      <div className="w-44">
                        {i === 0 && (
                          <label className="block text-xs font-medium mb-1.5 uppercase tracking-wider text-[var(--text-secondary)]">
                            Role
                          </label>
                        )}
                        <select
                          value={agent.role}
                          onChange={(e) => updateAgent(agent.id, 'role', e.target.value)}
                          className="input w-full"
                        >
                          {ROLES.map((r) => (
                            <option key={r.value} value={r.value} title={r.description}>
                              {r.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <button
                      onClick={() => removeAgent(agent.id)}
                      disabled={agents.length <= 2}
                      className="btn-ghost p-2 mt-[22px] disabled:opacity-30"
                      title="Remove agent"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
              </div>

              {/* Role legend */}
              {agents.length > 0 && (() => {
                const currentRole = ROLES.find(
                  (r) => r.value === agents[agents.length - 1]?.role,
                );
                return currentRole ? (
                  <p className="text-xs text-[var(--text-secondary)] mb-4 italic">
                    <span className="font-medium not-italic">{currentRole.label}:</span>{' '}
                    {currentRole.description}
                  </p>
                ) : null;
              })()}

              <button
                onClick={addAgent}
                className="btn-secondary flex items-center gap-2 text-sm mb-6"
              >
                <Plus size={15} />
                Add another agent
              </button>

              {agentsAdded && (
                <div className="p-3 rounded-md bg-primary/10 border border-primary/20 mb-4">
                  <p className="text-xs text-primary font-medium flex items-center gap-1.5">
                    <Check size={13} />
                    Agents added successfully
                  </p>
                </div>
              )}

              <div className="flex items-center justify-between">
                <button onClick={back} className="btn-secondary flex items-center gap-2 text-sm">
                  <ArrowLeft size={15} />
                  Back
                </button>
                <button
                  onClick={handleAddAgents}
                  disabled={loading}
                  className="btn-primary flex items-center gap-2 text-sm"
                >
                  {loading ? (
                    <Loader2 size={15} className="animate-spin" />
                  ) : (
                    <ArrowRight size={15} />
                  )}
                  Continue
                </button>
              </div>
            </div>
          )}

          {/* ---- Step 3: Seed decisions --------------------------- */}
          {step === 3 && (
            <div>
              <div className="flex items-center gap-3 mb-6">
                <div className="w-10 h-10 rounded-lg bg-primary/15 flex items-center justify-center shrink-0">
                  <FileText size={18} className="text-primary" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold">Seed decisions</h2>
                  <p className="text-sm text-[var(--text-secondary)]">
                    Optional — add initial decisions to your graph.
                  </p>
                </div>
              </div>

              {error && <ErrorBanner message={error} onRetry={() => setError(null)} />}

              {/* Option cards */}
              {!seedOption && (
                <div className="grid grid-cols-1 gap-3">
                  {[
                    {
                      id: 'manual' as SeedOption,
                      icon: <Check size={20} className="text-primary" />,
                      title: "I'll add decisions manually",
                      description: 'Skip seeding and go straight to the dashboard.',
                    },
                    {
                      id: 'import' as SeedOption,
                      icon: <FileText size={20} className="text-primary" />,
                      title: 'Import from conversations',
                      description:
                        'Paste a conversation and Nexus will extract decisions automatically.',
                    },
                    {
                      id: 'connect' as SeedOption,
                      icon: <FolderOpen size={20} className="text-primary" />,
                      title: 'Connect auto-discovery',
                      description:
                        'Point to an OpenClaw path or directory for continuous ingestion.',
                    },
                  ].map((opt) => (
                    <button
                      key={opt.id}
                      onClick={() => setSeedOption(opt.id)}
                      className="flex items-start gap-4 p-4 rounded-lg border border-[var(--border-light)] hover:border-primary/50 hover:bg-primary/5 transition-all text-left group"
                    >
                      <div className="w-9 h-9 rounded-md bg-primary/10 flex items-center justify-center shrink-0 group-hover:bg-primary/20 transition-colors">
                        {opt.icon}
                      </div>
                      <div>
                        <p className="text-sm font-medium mb-0.5">{opt.title}</p>
                        <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
                          {opt.description}
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {/* Option A: Manual */}
              {seedOption === 'manual' && (
                <div className="text-center py-4">
                  <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mx-auto mb-3">
                    <Check size={22} className="text-primary" />
                  </div>
                  <p className="text-sm text-[var(--text-secondary)] mb-4">
                    You'll add decisions from the Decision Graph after setup.
                  </p>
                  <button
                    onClick={() => setSeedOption(null)}
                    className="btn-secondary text-xs"
                  >
                    Change option
                  </button>
                </div>
              )}

              {/* Option B: Import */}
              {seedOption === 'import' && (
                <div>
                  <button
                    onClick={() => setSeedOption(null)}
                    className="btn-ghost text-xs flex items-center gap-1 mb-3 -ml-1"
                  >
                    <ArrowLeft size={12} />
                    Change option
                  </button>
                  <textarea
                    value={conversation}
                    onChange={(e) => setConversation(e.target.value)}
                    placeholder="Paste your conversation here…"
                    className="input w-full resize-none mb-3"
                    rows={6}
                  />
                  <button
                    onClick={handleDistill}
                    disabled={distilling || !conversation.trim()}
                    className="btn-primary text-sm flex items-center gap-2 mb-4"
                  >
                    {distilling ? <Loader2 size={14} className="animate-spin" /> : <Cpu size={14} />}
                    Extract decisions
                  </button>

                  {extractedDecisions.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-[var(--text-secondary)] uppercase tracking-wider mb-2">
                        Extracted decisions ({extractedDecisions.length})
                      </p>
                      {extractedDecisions.map((d, i) => (
                        <div
                          key={i}
                          className="flex items-center justify-between p-3 rounded-md bg-primary/5 border border-primary/15"
                        >
                          <p className="text-sm font-medium">{d.title}</p>
                          <span
                            className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                              d.confidence >= 0.8
                                ? 'bg-green-500/15 text-green-400'
                                : d.confidence >= 0.5
                                  ? 'bg-yellow-500/15 text-yellow-400'
                                  : 'bg-red-500/15 text-red-400'
                            }`}
                          >
                            {Math.round(d.confidence * 100)}%
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Option C: Connect */}
              {seedOption === 'connect' && (
                <div>
                  <button
                    onClick={() => setSeedOption(null)}
                    className="btn-ghost text-xs flex items-center gap-1 mb-3 -ml-1"
                  >
                    <ArrowLeft size={12} />
                    Change option
                  </button>
                  <label className="block text-xs font-medium mb-1.5 uppercase tracking-wider text-[var(--text-secondary)]">
                    OpenClaw path or directory
                  </label>
                  <input
                    type="text"
                    value={connectorPath}
                    onChange={(e) => setConnectorPath(e.target.value)}
                    placeholder="/path/to/openclaw or /projects/myapp"
                    className="input w-full mb-3"
                  />
                  <button
                    onClick={handleSaveConnector}
                    disabled={loading || !connectorPath.trim() || connectorSaved}
                    className="btn-primary text-sm flex items-center gap-2"
                  >
                    {loading ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : connectorSaved ? (
                      <Check size={14} />
                    ) : (
                      <FolderOpen size={14} />
                    )}
                    {connectorSaved ? 'Connector saved' : 'Save connector'}
                  </button>
                  {connectorSaved && (
                    <p className="text-xs text-primary mt-2">
                      Auto-discovery is now configured for this project.
                    </p>
                  )}
                </div>
              )}

              <div className="flex items-center justify-between mt-6">
                <button onClick={back} className="btn-secondary flex items-center gap-2 text-sm">
                  <ArrowLeft size={15} />
                  Back
                </button>
                <button
                  onClick={next}
                  className="btn-primary flex items-center gap-2 text-sm"
                >
                  <ArrowRight size={15} />
                  Continue
                </button>
              </div>
            </div>
          )}

          {/* ---- Step 4: See it work ------------------------------ */}
          {step === 4 && (
            <div>
              <div className="flex items-center gap-3 mb-6">
                <div className="w-10 h-10 rounded-lg bg-primary/15 flex items-center justify-center shrink-0">
                  <Cpu size={18} className="text-primary" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold">See it work</h2>
                  <p className="text-sm text-[var(--text-secondary)]">
                    Compile a context window for your first two agents.
                  </p>
                </div>
              </div>

              {error && <ErrorBanner message={error} onRetry={handleCompile} />}

              {!compiled && (
                <div className="text-center py-8">
                  <button
                    onClick={handleCompile}
                    disabled={loading}
                    className="btn-primary flex items-center gap-2 mx-auto text-sm"
                  >
                    {loading ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : (
                      <Cpu size={16} />
                    )}
                    {loading ? 'Compiling context…' : 'Compile context'}
                  </button>
                </div>
              )}

              {compiled && compileResults.length > 0 && (
                <div className="grid grid-cols-2 gap-4">
                  {compileResults.map((result, i) => (
                    <div key={i} className="card p-4">
                      <p className="text-xs font-semibold text-primary uppercase tracking-wider mb-1">
                        {result.agent}
                      </p>
                      <p className="text-xs text-[var(--text-secondary)] mb-3 leading-relaxed">
                        {result.task}
                      </p>
                      <div className="space-y-2">
                        {(result.decisions || []).slice(0, 3).map((d, j) => (
                          <div
                            key={j}
                            className="flex items-center justify-between text-xs"
                          >
                            <span className="truncate mr-2 flex-1">{d.decision.title}</span>
                            <span
                              className={`shrink-0 font-medium px-1.5 py-0.5 rounded ${
                                d.score >= 0.8
                                  ? 'text-green-400 bg-green-500/10'
                                  : d.score >= 0.5
                                    ? 'text-yellow-400 bg-yellow-500/10'
                                    : 'text-[var(--text-secondary)]'
                              }`}
                            >
                              {Math.round(d.score * 100)}
                            </span>
                          </div>
                        ))}
                        {(result.decisions || []).length === 0 && (
                          <p className="text-xs text-[var(--text-secondary)] italic">
                            No decisions ranked yet — add some in the dashboard.
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {compiled && compileResults.length === 0 && (
                <p className="text-sm text-center text-[var(--text-secondary)] py-4">
                  No agents available to compile. Continue to the dashboard to add more.
                </p>
              )}

              <div className="flex items-center justify-between mt-6">
                <button onClick={back} className="btn-secondary flex items-center gap-2 text-sm">
                  <ArrowLeft size={15} />
                  Back
                </button>
                <button
                  onClick={next}
                  className="btn-primary flex items-center gap-2 text-sm"
                >
                  <ArrowRight size={15} />
                  Continue
                </button>
              </div>
            </div>
          )}

          {/* ---- Step 5: Done ------------------------------------- */}
          {step === 5 && (
            <div className="text-center">
              <div className="w-16 h-16 rounded-2xl bg-primary/15 flex items-center justify-center mx-auto mb-6">
                <Check size={28} className="text-primary" />
              </div>
              <h2 className="text-2xl font-semibold mb-3">You're all set!</h2>
              <p className="text-sm text-[var(--text-secondary)] leading-relaxed mb-8 max-w-md mx-auto">
                Your project <span className="text-primary font-medium">{projectName}</span> is
                ready. Explore your decision graph, compare agent contexts, and manage
                contradictions.
              </p>

              <div className="grid grid-cols-3 gap-3 mb-8 text-left">
                {[
                  {
                    icon: <GitBranch size={16} className="text-primary" />,
                    label: 'Decision Graph',
                    hint: 'Visualize all decisions',
                  },
                  {
                    icon: <LayoutDashboard size={16} className="text-primary" />,
                    label: 'Context Compare',
                    hint: 'Compare agent views',
                  },
                  {
                    icon: <AlertCircle size={16} className="text-primary" />,
                    label: 'Contradictions',
                    hint: 'Resolve conflicts',
                  },
                ].map((item, i) => (
                  <div
                    key={i}
                    className="p-3 rounded-lg border border-[var(--border-light)]"
                  >
                    <div className="mb-2">{item.icon}</div>
                    <p className="text-xs font-semibold mb-0.5">{item.label}</p>
                    <p className="text-xs text-[var(--text-secondary)]">
                      {item.hint}
                    </p>
                  </div>
                ))}
              </div>

              <button
                onClick={() => createdProjectId && onComplete(createdProjectId)}
                className="btn-primary inline-flex items-center gap-2 px-6 py-2.5 text-sm"
              >
                Go to Dashboard
                <ArrowRight size={16} />
              </button>
            </div>
          )}
        </div>

        {/* Step label */}
        <p className="text-center text-xs text-[var(--text-secondary)] mt-4">
          Step {step + 1} of {STEPS.length} — {STEPS[step]}
        </p>
      </div>
    </div>
  );
}
