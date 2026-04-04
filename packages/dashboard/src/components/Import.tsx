import { useRef, useState, useCallback } from 'react';
import {
  Upload,
  FileText,
  X,
  Loader2,
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Tag,
  ChevronRight,
} from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { useProject } from '../App';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ImportedDecision {
  id: string;
  title: string;
  confidence: number;
  tags: string[];
}

/* ------------------------------------------------------------------ */
/*  Confidence badge                                                   */
/* ------------------------------------------------------------------ */

function ConfidenceBadge({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  let cls = 'bg-green-500/15 text-green-400';
  if (value < 0.8 && value >= 0.5) cls = 'bg-yellow-500/15 text-yellow-400';
  if (value < 0.5) cls = 'bg-red-500/15 text-red-400';
  return (
    <span className={`inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full ${cls}`}>
      {pct}%
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Import component                                                   */
/* ------------------------------------------------------------------ */

export function Import() {
  const { post } = useApi();
  const { projectId } = useProject();

  /* Drag-and-drop */
  const [dragOver, setDragOver] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /* Text paste */
  const [pastedText, setPastedText] = useState('');

  /* Processing */
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  /* Results */
  const [results, setResults] = useState<ImportedDecision[]>([]);
  const [imported, setImported] = useState(false);

  /* ---- Drag handlers ------------------------------------------- */

  const ALLOWED = ['.txt', '.md', 'text/plain', 'text/markdown'];

  function isAllowedFile(file: File) {
    return (
      ALLOWED.some((ext) => file.name.endsWith(ext)) ||
      file.type === 'text/plain' ||
      file.type === 'text/markdown'
    );
  }

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const dropped = Array.from(e.dataTransfer.files).filter(isAllowedFile);
    setFiles((prev) => {
      const names = new Set(prev.map((f) => f.name));
      return [...prev, ...dropped.filter((f) => !names.has(f.name))];
    });
  }, []);

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(e.target.files || []).filter(isAllowedFile);
    setFiles((prev) => {
      const names = new Set(prev.map((f) => f.name));
      return [...prev, ...selected.filter((f) => !names.has(f.name))];
    });
    // Reset so same file can be re-added if removed
    e.target.value = '';
  }

  function removeFile(name: string) {
    setFiles((prev) => prev.filter((f) => f.name !== name));
  }

  /* ---- Import action ------------------------------------------- */

  async function handleImport() {
    const hasFiles = files.length > 0;
    const hasPaste = pastedText.trim().length > 0;

    if (!hasFiles && !hasPaste) {
      setError('Please add files or paste text to import.');
      return;
    }

    setImporting(true);
    setError(null);
    setProgress(0);
    setResults([]);
    setImported(false);

    try {
      let allDecisions: ImportedDecision[] = [];
      const total = files.length + (hasPaste ? 1 : 0);
      let done = 0;

      // Process each file
      for (const file of files) {
        const text = await file.text();
        const res = await post<{ decisions: ImportedDecision[] }>(
          `/api/projects/${projectId}/import`,
          { content: text, source: file.name },
        );
        allDecisions = [...allDecisions, ...(res.decisions || [])];
        done++;
        setProgress(Math.round((done / total) * 100));
      }

      // Process pasted text
      if (hasPaste) {
        const res = await post<{ decisions: ImportedDecision[] }>(
          `/api/projects/${projectId}/import`,
          { content: pastedText.trim(), source: 'paste' },
        );
        allDecisions = [...allDecisions, ...(res.decisions || [])];
        done++;
        setProgress(100);
      }

      setResults(allDecisions);
      setImported(true);
    } catch (err: unknown) {
      const e = err as { message?: string };
      setError(e.message || 'Import failed. Please try again.');
    } finally {
      setImporting(false);
    }
  }

  function reset() {
    setFiles([]);
    setPastedText('');
    setResults([]);
    setImported(false);
    setError(null);
    setProgress(0);
  }

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-lg font-semibold mb-1">Import Decisions</h1>
          <p className="text-sm text-[var(--text-secondary)]">
            Upload conversation files or paste text to extract decisions automatically.
          </p>
        </div>

        {!imported ? (
          <>
            {/* Drag-and-drop zone */}
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`relative flex flex-col items-center justify-center gap-3 p-10 rounded-xl border-2 border-dashed cursor-pointer transition-all duration-150 mb-6 ${
                dragOver
                  ? 'border-primary bg-primary/10 scale-[1.01]'
                  : 'border-[var(--border-light)] hover:border-primary/50 hover:bg-primary/5'
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".txt,.md,text/plain,text/markdown"
                onChange={handleFileInput}
                className="hidden"
              />
              <div
                className={`w-12 h-12 rounded-xl flex items-center justify-center transition-colors ${
                  dragOver ? 'bg-primary/20' : 'bg-[var(--border-light)]/30'
                }`}
              >
                <Upload size={22} className={dragOver ? 'text-primary' : 'text-[var(--text-secondary)]'} />
              </div>
              <div className="text-center">
                <p className="text-sm font-medium mb-0.5">
                  {dragOver ? 'Release to upload' : 'Drop files here or click to browse'}
                </p>
                <p className="text-xs text-[var(--text-secondary)]">
                  Supports .txt and .md files
                </p>
              </div>
            </div>

            {/* File list */}
            {files.length > 0 && (
              <div className="space-y-2 mb-6">
                {files.map((file) => (
                  <div
                    key={file.name}
                    className="flex items-center gap-3 p-3 rounded-lg border border-[var(--border-light)]"
                  >
                    <FileText
                      size={16}
                      className="text-[var(--text-secondary)] shrink-0"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm truncate">{file.name}</p>
                      <p className="text-xs text-[var(--text-secondary)]">
                        {(file.size / 1024).toFixed(1)} KB
                      </p>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        removeFile(file.name);
                      }}
                      className="btn-ghost p-1.5"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Divider */}
            <div className="flex items-center gap-3 mb-6">
              <div className="flex-1 h-px bg-[var(--border-light)]" />
              <span className="text-xs text-[var(--text-secondary)] uppercase tracking-wider">
                or paste text
              </span>
              <div className="flex-1 h-px bg-[var(--border-light)]" />
            </div>

            {/* Text area */}
            <textarea
              value={pastedText}
              onChange={(e) => setPastedText(e.target.value)}
              placeholder="Paste a conversation, meeting notes, or decision log here…"
              className="input w-full resize-none mb-4"
              rows={6}
            />

            {/* Error */}
            {error && (
              <div className="flex items-start gap-2 p-3 rounded-md bg-red-500/10 border border-red-500/20 mb-4">
                <AlertCircle size={15} className="shrink-0 mt-0.5 text-red-400" />
                <p className="text-sm text-red-300">{error}</p>
              </div>
            )}

            {/* Progress bar */}
            {importing && (
              <div className="mb-4">
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="text-[var(--text-secondary)] flex items-center gap-1.5">
                    <Loader2 size={12} className="animate-spin" />
                    Processing…
                  </span>
                  <span className="font-medium">{progress}%</span>
                </div>
                <div className="h-1.5 rounded-full bg-[var(--border-light)] overflow-hidden">
                  <div
                    className="h-full rounded-full bg-primary transition-all duration-300"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </div>
            )}

            {/* Import button */}
            <button
              onClick={handleImport}
              disabled={importing || (files.length === 0 && !pastedText.trim())}
              className="btn-primary flex items-center gap-2 text-sm"
            >
              {importing ? (
                <Loader2 size={15} className="animate-spin" />
              ) : (
                <Upload size={15} />
              )}
              {importing ? 'Importing…' : 'Import'}
            </button>
          </>
        ) : (
          <>
            {/* Results header */}
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <CheckCircle2 size={18} className="text-primary" />
                <p className="text-sm font-medium">
                  {results.length} decision{results.length !== 1 ? 's' : ''} extracted
                </p>
              </div>
              <button onClick={reset} className="btn-secondary text-xs">
                Import more
              </button>
            </div>

            {results.length === 0 ? (
              <div className="text-center py-12">
                <p className="text-sm text-[var(--text-secondary)]">
                  No decisions were found in the provided content.
                </p>
                <button onClick={reset} className="btn-secondary text-sm mt-4">
                  Try different content
                </button>
              </div>
            ) : (
              <div className="card overflow-hidden">
                {/* Table header */}
                <div className="grid grid-cols-[1fr_120px_auto] gap-4 px-4 py-2.5 border-b border-[var(--border-light)]">
                  <span className="text-xs font-medium uppercase tracking-wider text-[var(--text-secondary)]">
                    Decision
                  </span>
                  <span className="text-xs font-medium uppercase tracking-wider text-[var(--text-secondary)]">
                    Confidence
                  </span>
                  <span className="text-xs font-medium uppercase tracking-wider text-[var(--text-secondary)]">
                    View
                  </span>
                </div>

                {/* Rows */}
                <div className="divide-y divide-[var(--border-light)]">
                  {results.map((decision) => (
                    <div
                      key={decision.id}
                      className="grid grid-cols-[1fr_120px_auto] gap-4 px-4 py-3 items-start hover:bg-[var(--bg-secondary)] transition-colors"
                    >
                      {/* Title + tags */}
                      <div>
                        <p className="text-sm font-medium mb-1.5">{decision.title}</p>
                        {decision.tags && decision.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {decision.tags.slice(0, 4).map((tag) => (
                              <span
                                key={tag}
                                className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-[var(--border-light)]/40 text-[var(--text-secondary)]"
                              >
                                <Tag size={9} />
                                {tag}
                              </span>
                            ))}
                            {decision.tags.length > 4 && (
                              <span className="text-xs text-[var(--text-secondary)]">
                                +{decision.tags.length - 4}
                              </span>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Confidence */}
                      <div className="flex items-center pt-0.5">
                        <ConfidenceBadge value={decision.confidence} />
                      </div>

                      {/* Link */}
                      <div className="flex items-center pt-0.5">
                        <a
                          href={`#graph?id=${decision.id}`}
                          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                          title="View in Decision Graph"
                        >
                          <ExternalLink size={13} />
                        </a>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Quick links */}
            <div className="mt-6">
              <a
                href="#graph"
                className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
              >
                View all in Decision Graph
                <ChevronRight size={14} />
              </a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
