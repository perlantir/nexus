// Monitors conversation text and automatically extracts decision-worthy content
// once buffer and time thresholds are exceeded.

import { DeciGraphClient } from '../../sdk/src/index.js';
import type { DistilleryResult } from '../../sdk/src/index.js';

export class AutoCapture {
  private buffer: string[] = [];
  private lastExtraction: Date = new Date();
  private minBufferSize = 500; // characters
  private extractionInterval = 300000; // 5 minutes in ms

  constructor(
    private readonly client: DeciGraphClient,
    private readonly projectId: string,
    private readonly agentName: string,
  ) {}

  /** Add a conversation message to the rolling buffer. */
  addMessage(text: string): void {
    if (text.trim().length > 0) {
      this.buffer.push(text);
    }
  }

  /**
   * Returns true if an extraction pass should be triggered.
   * Requires >= minBufferSize chars AND >= extractionInterval ms since last run.
   */
  shouldExtract(): boolean {
    const totalChars = this.buffer.reduce((sum, msg) => sum + msg.length, 0);
    const timeSinceLast = Date.now() - this.lastExtraction.getTime();
    return totalChars >= this.minBufferSize && timeSinceLast >= this.extractionInterval;
  }

  /**
   * Run extraction if thresholds are met.
   * Clears buffer and resets timer on success. Returns null if thresholds unmet.
   */
  async extract(): Promise<DistilleryResult | null> {
    if (!this.shouldExtract()) {
      return null;
    }
    return this._runExtraction();
  }

  /**
   * Immediately flush and extract regardless of thresholds.
   * Useful at session end. Returns null if buffer is empty.
   */
  async flush(): Promise<DistilleryResult | null> {
    if (this.buffer.length === 0) {
      return null;
    }
    return this._runExtraction();
  }

  private async _runExtraction(): Promise<DistilleryResult | null> {
    if (this.buffer.length === 0) {
      return null;
    }

    const conversationText = this.buffer.join('\n');
    // Capture and clear before the async call to avoid double-processing on concurrent callers
    this.buffer = [];
    this.lastExtraction = new Date();

    try {
      const result = await this.client.distill(this.projectId, {
        conversation_text: conversationText,
        agent_name: this.agentName,
      });
      return result;
    } catch (err) {
      // Restore buffer on failure so messages are not lost
      const lines = conversationText.split('\n').filter(Boolean);
      this.buffer.unshift(...lines);
      throw err;
    }
  }

  /** Override minimum character buffer size before extraction. */
  setMinBufferSize(chars: number): void {
    this.minBufferSize = chars;
  }

  /** Override minimum interval (ms) between extractions. */
  setExtractionInterval(ms: number): void {
    this.extractionInterval = ms;
  }

  /** Total character count currently in buffer. */
  get bufferSize(): number {
    return this.buffer.reduce((sum, msg) => sum + msg.length, 0);
  }

  /** Number of messages currently in buffer. */
  get messageCount(): number {
    return this.buffer.length;
  }

  /** Snapshot of current buffer contents. */
  get bufferedMessages(): readonly string[] {
    return [...this.buffer];
  }
}
