import { openClawConnector } from '../connectors/openclaw.js';
import { directoryConnector } from '../connectors/directory.js';
import { processBatch } from './index.js';
import type { ConversationChunk } from '../connectors/types.js';

/** Maximum number of chunks processed per poll cycle to respect distillery rate limits. */
const MAX_CHUNKS_PER_CYCLE = 10;

export class AutoDiscoveryService {
  private intervals: NodeJS.Timeout[] = [];
  private running = false;

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Starts the auto-discovery service for the given project.
   *
   * Reads configuration from environment variables:
   *   DECIGRAPH_OPENCLAW_PATH        — enables the OpenClaw connector
   *   DECIGRAPH_WATCH_DIR            — enables the generic directory connector
   *   DECIGRAPH_WATCH_PATTERN        — optional glob pattern for directory connector
   *   DECIGRAPH_DISCOVERY_INTERVAL   — poll interval in ms (default: 60000)
   */
  async start(projectId: string): Promise<void> {
    if (this.running) {
      console.warn('[decigraph:auto-discovery] Service is already running.');
      return;
    }

    this.running = true;

    const intervalMs = parseInt(process.env['DECIGRAPH_DISCOVERY_INTERVAL'] ?? '60000', 10);
    const openClawPath = process.env['DECIGRAPH_OPENCLAW_PATH'];
    const watchDir = process.env['DECIGRAPH_WATCH_DIR'];

    let connectorCount = 0;

    if (openClawPath) {
      connectorCount++;
      const handle = setInterval(() => {
        void this.runOpenClawConnector(projectId);
      }, intervalMs);
      this.intervals.push(handle);

      console.warn(
        `[decigraph:auto-discovery] OpenClaw connector started` +
          ` (path: ${openClawPath}, interval: ${intervalMs}ms)`,
      );

      // Run immediately on start
      void this.runOpenClawConnector(projectId);
    }

    if (watchDir) {
      connectorCount++;
      const handle = setInterval(() => {
        void this.runDirectoryConnector(projectId);
      }, intervalMs);
      this.intervals.push(handle);

      const pattern = process.env['DECIGRAPH_WATCH_PATTERN'];
      console.warn(
        `[decigraph:auto-discovery] Directory connector started` +
          ` (dir: ${watchDir}` +
          (pattern ? `, pattern: ${pattern}` : '') +
          `, interval: ${intervalMs}ms)`,
      );

      // Run immediately on start
      void this.runDirectoryConnector(projectId);
    }

    if (connectorCount === 0) {
      console.warn(
        '[decigraph:auto-discovery] No connectors configured. ' +
          'Set DECIGRAPH_OPENCLAW_PATH or DECIGRAPH_WATCH_DIR to enable auto-discovery.',
      );
    } else {
      console.warn(
        `[decigraph:auto-discovery] Service started for project "${projectId}" ` +
          `with ${connectorCount} connector(s).`,
      );
    }
  }

  /**
   * Stops all running connectors and clears their poll intervals.
   */
  async stop(): Promise<void> {
    for (const handle of this.intervals) {
      clearInterval(handle);
    }
    this.intervals = [];
    this.running = false;
    console.warn('[decigraph:auto-discovery] Service stopped.');
  }

  // ---------------------------------------------------------------------------
  // Private connector runners
  // ---------------------------------------------------------------------------

  private async runOpenClawConnector(projectId: string): Promise<void> {
    const basePath = process.env['DECIGRAPH_OPENCLAW_PATH'];
    if (!basePath) return;

    const intervalMs = parseInt(process.env['DECIGRAPH_DISCOVERY_INTERVAL'] ?? '60000', 10);

    // Collect up to MAX_CHUNKS_PER_CYCLE from the async generator in a single tick
    const chunks: ConversationChunk[] = [];

    try {
      const generator = openClawConnector.watch!({
        path: basePath,
        poll_interval_ms: intervalMs,
      });

      for await (const chunk of generator) {
        chunks.push(chunk);
        if (chunks.length >= MAX_CHUNKS_PER_CYCLE) break;
      }
    } catch (err) {
      console.error('[decigraph:auto-discovery] OpenClaw connector error:', err);
    }

    if (chunks.length === 0) return;

    try {
      const result = await processBatch(projectId, chunks, openClawConnector.name);
      console.warn(
        `[decigraph:auto-discovery] OpenClaw: processed=${result.processed}` +
          ` decisions=${result.decisions_extracted} errors=${result.errors}`,
      );
    } catch (err) {
      console.error('[decigraph:auto-discovery] OpenClaw batch processing error:', err);
    }
  }

  private async runDirectoryConnector(projectId: string): Promise<void> {
    const watchDir = process.env['DECIGRAPH_WATCH_DIR'];
    if (!watchDir) return;

    const pattern = process.env['DECIGRAPH_WATCH_PATTERN'];
    const intervalMs = parseInt(process.env['DECIGRAPH_DISCOVERY_INTERVAL'] ?? '60000', 10);

    const chunks: ConversationChunk[] = [];

    try {
      const generator = directoryConnector.watch!({
        path: watchDir,
        pattern,
        poll_interval_ms: intervalMs,
      });

      for await (const chunk of generator) {
        chunks.push(chunk);
        if (chunks.length >= MAX_CHUNKS_PER_CYCLE) break;
      }
    } catch (err) {
      console.error('[decigraph:auto-discovery] Directory connector error:', err);
    }

    if (chunks.length === 0) return;

    try {
      const result = await processBatch(projectId, chunks, directoryConnector.name);
      console.warn(
        `[decigraph:auto-discovery] Directory: processed=${result.processed}` +
          ` decisions=${result.decisions_extracted} errors=${result.errors}`,
      );
    } catch (err) {
      console.error('[decigraph:auto-discovery] Directory batch processing error:', err);
    }
  }
}
